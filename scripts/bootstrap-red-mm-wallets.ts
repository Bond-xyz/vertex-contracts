import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BigNumber, Contract, Wallet, providers, utils } from 'ethers';

export const RED_MM_CHAIN_ID = 16602;
export const RED_MM_ENDPOINT = '0xb8C398B78Df988AC770790E6De5bb7881F2AC813';
export const RED_MM_CLEARINGHOUSE = '0x45C40B425fb736da2C8775612400A89827b156C1';
export const RED_MM_SPOT_ENGINE = '0xf99E5c21ff7a25063594fB8ac64CA0caDDBbaA80';
export const RED_MM_USDCE = '0xF2506aa3684871549083d235453a1dcDcCB3396c';
export const RED_MM_AUTHORITY = '0xE31139d7BEe3AE76C7839dCc1849B2C6Ac18f7E4';
export const RED_MM_MAKER = '0x0dB7dE1fdFE09AF8EF54E1Ec70f3772E569825ED';
export const RED_MM_TAKER = '0xc11056392E18DA9C1dD4117A3e8EE5cBA453218B';
export const RED_MM_MAKER_SUBACCOUNT = '0x626f6e642d6d616b65720000';
export const RED_MM_TAKER_SUBACCOUNT = '0x626f6e642d74616b65720000';
export const RED_MM_NATIVE_TOP_UP_WEI = '50000000000000000';
export const RED_MM_DEPOSIT_RAW = '50000000000';
export const RED_MM_CONFIRMATION = 'EXECUTE-RED-MM-BOOTSTRAP-16602';
export const RED_MM_DEFAULT_RPC = 'https://evmrpc-testnet.0g.ai';

const MIN_GAS_PRICE_WEI = BigNumber.from('2000000007');
const MAX_GAS_PRICE_WEI = BigNumber.from('20000000000');
const JOURNAL_KIND = 'red_mm_wallet_bootstrap';

const endpointAbi = [
  'function owner() view returns (address)',
  'function getSequencer() view returns (address)',
  'function clearinghouse() view returns (address)',
  'function depositCollateral(bytes12 subaccountName,uint32 productId,uint128 amount)',
  'function getSlowModeTx(uint64 idx) view returns ((uint64 executableAt,address sender,bytes tx),uint64 txUpTo,uint64 txCount)',
  'event DepositCollateralWithReferral(bytes32 indexed subaccount,uint32 indexed productId,uint128 amount,string referralCode)',
];
const tokenAbi = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function mint(address account,uint256 amount)',
  'function approve(address spender,uint256 amount) returns (bool)',
];
const clearinghouseAbi = [
  'function getQuote() view returns (address)',
  'function getReleaseMode() view returns (uint8)',
];
const spotEngineAbi = ['function getToken(uint32 productId) view returns (address)'];

type SignerName = 'authority' | 'maker' | 'taker';
type StepState = 'planned' | 'prepared' | 'confirmed';

export type BootstrapStep = {
  id: string;
  signer: SignerName;
  nonce: number;
  to: string;
  valueWei: string;
  data: string;
  gasLimit: string;
  gasPriceWei: string;
  state: StepState;
  transactionHash?: string;
  receipt?: {
    blockNumber: number;
    blockHash: string;
    gasUsed: string;
  };
};

export type BootstrapJournal = {
  schemaVersion: 1;
  kind: typeof JOURNAL_KIND;
  chainId: 16602;
  endpoint: string;
  token: string;
  authority: string;
  maker: { address: string; subaccount: string };
  taker: { address: string; subaccount: string };
  nativeTopUpWei: string;
  depositAmountRaw: string;
  confirmationsRequired: number;
  initialState: {
    authorityNonce: number;
    makerNonce: number;
    takerNonce: number;
    slowModeTxUpTo: string;
    slowModeTxCount: string;
    clearinghouseCustodyRaw: string;
  };
  steps: BootstrapStep[];
  complete: boolean;
};

type Cli = {
  authorityKeyFile: string;
  makerKeyFile: string;
  takerKeyFile: string;
  journalFile: string;
  rpcUrl: string;
  confirmations: number;
  execute: boolean;
};

const secretRedactions: string[] = [];

function fail(message: string): never {
  throw new Error(message);
}

function sameAddress(left: string, right: string): boolean {
  return utils.getAddress(left) === utils.getAddress(right);
}

function requireNoSymlinkAncestors(resolved: string, includeFinal: boolean): void {
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const limit = includeFinal ? parts.length : Math.max(0, parts.length - 1);
  let cursor = parsed.root;
  for (let index = 0; index < limit; index += 1) {
    cursor = path.join(cursor, parts[index]);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail(`refusing symlinked path component: ${cursor}`);
  }
}

function requireAbsoluteRegularFile(raw: string, label: string): string {
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(raw)) fail(`${label} must be an absolute path`);
  requireNoSymlinkAncestors(resolved, true);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be one regular non-symlink file`);
  return resolved;
}

function requirePrivateParent(file: string): string {
  const parent = path.dirname(file);
  requireNoSymlinkAncestors(parent, true);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('journal parent must be one non-symlink directory');
  if (stat.uid !== process.getuid?.()) fail('journal parent must be owned by the current user');
  if ((stat.mode & 0o777) !== 0o700) fail('journal parent must have exact mode 0700');
  return parent;
}

function readPrivateKey(file: string, label: string): string {
  const isInheritedDescriptor = /^\/dev\/fd\/[0-9]+$/.test(file);
  let source = file;
  if (!isInheritedDescriptor) {
    source = requireAbsoluteRegularFile(file, label);
    const stat = fs.lstatSync(source);
    if (stat.uid !== process.getuid?.()) fail(`${label} must be owned by the current user`);
    const mode = stat.mode & 0o777;
    if (mode !== 0o400) fail(`${label} must have exact mode 0400`);
  }
  const value = fs.readFileSync(source, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`${label} does not contain one private key`);
  secretRedactions.push(value, value.slice(2));
  return value;
}

function parseCli(argv: string[]): Cli {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) fail('arguments must be --name value pairs');
    if (values.has(flag)) fail(`duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set([
    '--authority-key-file',
    '--maker-key-file',
    '--taker-key-file',
    '--journal-file',
    '--rpc-url',
    '--confirmations',
    '--confirm',
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) fail(`unknown argument: ${flag}`);
  const required = (flag: string): string => values.get(flag) || fail(`missing required ${flag}`);
  const confirmations = Number(values.get('--confirmations') || '12');
  if (!Number.isSafeInteger(confirmations) || confirmations < 12 || confirmations > 100) {
    fail('--confirmations must be an integer from 12 through 100');
  }
  return {
    authorityKeyFile: required('--authority-key-file'),
    makerKeyFile: required('--maker-key-file'),
    takerKeyFile: required('--taker-key-file'),
    journalFile: path.resolve(required('--journal-file')),
    rpcUrl: values.get('--rpc-url') || RED_MM_DEFAULT_RPC,
    confirmations,
    execute: values.get('--confirm') === RED_MM_CONFIRMATION,
  };
}

export function serializeBootstrapJournal(
  journal: BootstrapJournal,
  forbiddenValues: string[] = secretRedactions
): string {
  const serialized = `${JSON.stringify(journal, null, 2)}\n`;
  for (const secret of forbiddenValues) {
    if (secret && serialized.includes(secret)) fail('refusing to persist private key material');
  }
  if (/private.?key/i.test(serialized)) fail('refusing to persist private-key fields');
  return serialized;
}

function writeJournal(file: string, journal: BootstrapJournal, exclusive = false): void {
  const serialized = serializeBootstrapJournal(journal);
  const parent = requirePrivateParent(file);
  if (exclusive) {
    fs.writeFileSync(file, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return;
  }
  const temporary = path.join(
    parent,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function loadJournal(file: string): BootstrapJournal {
  const resolved = requireAbsoluteRegularFile(file, 'journal file');
  const stat = fs.lstatSync(resolved);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    fail('journal file must be current-user-owned with exact mode 0600');
  }
  requirePrivateParent(resolved);
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (raw?.schemaVersion !== 1 || raw?.kind !== JOURNAL_KIND || raw?.chainId !== RED_MM_CHAIN_ID) {
    fail('journal identity does not match Red MM bootstrap schema');
  }
  const journal = raw as BootstrapJournal;
  validateJournalIdentity(journal);
  return journal;
}

export function validateJournalIdentity(journal: BootstrapJournal): void {
  if (
    !sameAddress(journal.endpoint, RED_MM_ENDPOINT) ||
    !sameAddress(journal.token, RED_MM_USDCE) ||
    !sameAddress(journal.authority, RED_MM_AUTHORITY) ||
    !sameAddress(journal.maker.address, RED_MM_MAKER) ||
    !sameAddress(journal.taker.address, RED_MM_TAKER) ||
    journal.maker.subaccount !== RED_MM_MAKER_SUBACCOUNT ||
    journal.taker.subaccount !== RED_MM_TAKER_SUBACCOUNT ||
    journal.nativeTopUpWei !== RED_MM_NATIVE_TOP_UP_WEI ||
    journal.depositAmountRaw !== RED_MM_DEPOSIT_RAW ||
    journal.confirmationsRequired < 12 ||
    journal.confirmationsRequired > 100 ||
    typeof journal.complete !== 'boolean' ||
    !Number.isSafeInteger(journal.initialState.authorityNonce) ||
    !Number.isSafeInteger(journal.initialState.makerNonce) ||
    !Number.isSafeInteger(journal.initialState.takerNonce) ||
    journal.initialState.authorityNonce < 0 ||
    journal.initialState.makerNonce < 0 ||
    journal.initialState.takerNonce < 0
  ) {
    fail('journal plan does not match the exact Red MM bootstrap policy');
  }
  const initialUpTo = BigNumber.from(journal.initialState.slowModeTxUpTo);
  const initialCount = BigNumber.from(journal.initialState.slowModeTxCount);
  BigNumber.from(journal.initialState.clearinghouseCustodyRaw);
  if (initialUpTo.gt(initialCount)) fail('journal slow-mode baseline is invalid');
  const gasPrice = BigNumber.from(journal.steps[0]?.gasPriceWei || 0);
  if (gasPrice.lt(MIN_GAS_PRICE_WEI) || gasPrice.gt(MAX_GAS_PRICE_WEI)) {
    fail('journal gas price is outside the exact Red MM bootstrap policy');
  }
  const expected = buildBootstrapSteps(
    journal.initialState.authorityNonce,
    journal.initialState.makerNonce,
    journal.initialState.takerNonce,
    gasPrice.toString()
  );
  if (journal.steps.length !== expected.length) fail('journal transaction count does not match policy');
  journal.steps.forEach((step, index) => {
    const planned = expected[index];
    if (
      step.id !== planned.id ||
      step.signer !== planned.signer ||
      step.nonce !== planned.nonce ||
      !sameAddress(step.to, planned.to) ||
      step.valueWei !== planned.valueWei ||
      step.data.toLowerCase() !== planned.data.toLowerCase() ||
      step.gasLimit !== planned.gasLimit ||
      step.gasPriceWei !== planned.gasPriceWei ||
      !['planned', 'prepared', 'confirmed'].includes(step.state) ||
      (step.transactionHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(step.transactionHash)) ||
      (step.state === 'planned' && step.transactionHash !== undefined) ||
      (step.state !== 'planned' && step.transactionHash === undefined) ||
      (step.state !== 'confirmed' && step.receipt !== undefined) ||
      (step.state === 'confirmed' && step.receipt === undefined)
    ) {
      fail(`journal transaction ${index} does not match the exact plan`);
    }
  });
  let unfinishedSeen = false;
  let preparedCount = 0;
  for (const step of journal.steps) {
    if (step.state !== 'confirmed') unfinishedSeen = true;
    if (unfinishedSeen && step.state === 'confirmed') fail('journal states are not one confirmed execution prefix');
    if (step.state === 'prepared') preparedCount += 1;
  }
  if (preparedCount > 1) fail('journal has more than one prepared transaction');
  if (journal.complete && journal.steps.some((step) => step.state !== 'confirmed' || !step.receipt)) {
    fail('complete journal does not contain eight confirmed receipts');
  }
}

export function buildBootstrapSteps(
  authorityNonce: number,
  makerNonce: number,
  takerNonce: number,
  gasPriceWei: string
): BootstrapStep[] {
  const token = new utils.Interface(tokenAbi);
  const endpoint = new utils.Interface(endpointAbi);
  const step = (
    id: string,
    signer: SignerName,
    nonce: number,
    to: string,
    valueWei: string,
    data: string,
    gasLimit: string
  ): BootstrapStep => ({ id, signer, nonce, to, valueWei, data, gasLimit, gasPriceWei, state: 'planned' });
  return [
    step('fund-maker-gas', 'authority', authorityNonce, RED_MM_MAKER, RED_MM_NATIVE_TOP_UP_WEI, '0x', '21000'),
    step('fund-taker-gas', 'authority', authorityNonce + 1, RED_MM_TAKER, RED_MM_NATIVE_TOP_UP_WEI, '0x', '21000'),
    step(
      'maker-mint-usdce',
      'maker',
      makerNonce,
      RED_MM_USDCE,
      '0',
      token.encodeFunctionData('mint', [RED_MM_MAKER, RED_MM_DEPOSIT_RAW]),
      '80000'
    ),
    step(
      'maker-approve-endpoint',
      'maker',
      makerNonce + 1,
      RED_MM_USDCE,
      '0',
      token.encodeFunctionData('approve', [RED_MM_ENDPOINT, RED_MM_DEPOSIT_RAW]),
      '70000'
    ),
    step(
      'maker-deposit',
      'maker',
      makerNonce + 2,
      RED_MM_ENDPOINT,
      '0',
      endpoint.encodeFunctionData('depositCollateral', [RED_MM_MAKER_SUBACCOUNT, 0, RED_MM_DEPOSIT_RAW]),
      '350000'
    ),
    step(
      'taker-mint-usdce',
      'taker',
      takerNonce,
      RED_MM_USDCE,
      '0',
      token.encodeFunctionData('mint', [RED_MM_TAKER, RED_MM_DEPOSIT_RAW]),
      '80000'
    ),
    step(
      'taker-approve-endpoint',
      'taker',
      takerNonce + 1,
      RED_MM_USDCE,
      '0',
      token.encodeFunctionData('approve', [RED_MM_ENDPOINT, RED_MM_DEPOSIT_RAW]),
      '70000'
    ),
    step(
      'taker-deposit',
      'taker',
      takerNonce + 2,
      RED_MM_ENDPOINT,
      '0',
      endpoint.encodeFunctionData('depositCollateral', [RED_MM_TAKER_SUBACCOUNT, 0, RED_MM_DEPOSIT_RAW]),
      '350000'
    ),
  ];
}

async function waitForNextBlock(provider: providers.JsonRpcProvider, previous: number): Promise<number> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await provider.getBlockNumber();
    if (current > previous) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail('timed out waiting for a new block while stabilizing the sequencer nonce');
}

async function stableNonce(provider: providers.JsonRpcProvider, address: string): Promise<number> {
  let block = await provider.getBlockNumber();
  let expected: number | undefined;
  for (let index = 0; index < 3; index += 1) {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(address, 'latest'),
      provider.getTransactionCount(address, 'pending'),
    ]);
    if (latest !== pending) fail('sequencer latest and pending nonces differ');
    if (expected !== undefined && latest !== expected)
      fail('sequencer nonce changed after settlement was expected to be stopped');
    expected = latest;
    if (index < 2) block = await waitForNextBlock(provider, block);
  }
  return expected as number;
}

async function requireCode(provider: providers.Provider, address: string, label: string): Promise<void> {
  if ((await provider.getCode(address)) === '0x') fail(`${label} has no code`);
}

async function assertFreshWallet(
  provider: providers.Provider,
  token: Contract,
  address: string,
  label: string
): Promise<number> {
  const [latest, pending, nativeBalance, tokenBalance, allowance] = await Promise.all([
    provider.getTransactionCount(address, 'latest'),
    provider.getTransactionCount(address, 'pending'),
    provider.getBalance(address),
    token.balanceOf(address),
    token.allowance(address, RED_MM_ENDPOINT),
  ]);
  if (latest !== 0 || pending !== 0 || !nativeBalance.isZero() || !tokenBalance.isZero() || !allowance.isZero()) {
    fail(`${label} is not in the exact unused bootstrap state`);
  }
  return latest;
}

function signerFor(step: BootstrapStep, signers: Record<SignerName, Wallet>): Wallet {
  return signers[step.signer];
}

function requestFor(step: BootstrapStep): providers.TransactionRequest {
  return {
    chainId: RED_MM_CHAIN_ID,
    type: 0,
    nonce: step.nonce,
    to: step.to,
    value: BigNumber.from(step.valueWei),
    data: step.data,
    gasLimit: BigNumber.from(step.gasLimit),
    gasPrice: BigNumber.from(step.gasPriceWei),
  };
}

async function verifyTransaction(
  provider: providers.Provider,
  step: BootstrapStep,
  expectedFrom: string
): Promise<providers.TransactionReceipt | null> {
  if (!step.transactionHash) return null;
  const transaction = await provider.getTransaction(step.transactionHash);
  if (!transaction) return null;
  if (
    !sameAddress(transaction.from, expectedFrom) ||
    !transaction.to ||
    !sameAddress(transaction.to, step.to) ||
    transaction.nonce !== step.nonce ||
    !transaction.value.eq(step.valueWei) ||
    transaction.data.toLowerCase() !== step.data.toLowerCase() ||
    !transaction.gasLimit.eq(step.gasLimit) ||
    !transaction.gasPrice?.eq(step.gasPriceWei)
  ) {
    fail(`transaction bytes do not match journal step ${step.id}`);
  }
  const receipt = await provider.getTransactionReceipt(step.transactionHash);
  if (!receipt) return null;
  if (receipt.status !== 1) fail(`transaction reverted for journal step ${step.id}`);
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash) fail(`receipt is not canonical for journal step ${step.id}`);
  return receipt;
}

async function executeStep(
  provider: providers.JsonRpcProvider,
  journalFile: string,
  journal: BootstrapJournal,
  step: BootstrapStep,
  signers: Record<SignerName, Wallet>
): Promise<void> {
  const wallet = signerFor(step, signers);
  const request = requestFor(step);
  if (!step.transactionHash) {
    const estimate = await provider.estimateGas({ ...request, from: wallet.address });
    if (estimate.gt(step.gasLimit)) fail(`live gas estimate exceeds the approved limit for ${step.id}`);
  }
  const raw = await wallet.signTransaction(request);
  const calculatedHash = utils.keccak256(raw);
  if (step.transactionHash && step.transactionHash !== calculatedHash) fail(`prepared hash changed for ${step.id}`);
  if (!step.transactionHash) {
    step.transactionHash = calculatedHash;
    step.state = 'prepared';
    writeJournal(journalFile, journal);
  }

  let receipt = await verifyTransaction(provider, step, wallet.address);
  if (!receipt) {
    const pending =
      step.signer === 'authority'
        ? await stableNonce(provider, wallet.address)
        : await provider.getTransactionCount(wallet.address, 'pending');
    if (pending !== step.nonce) fail(`unexpected pending nonce before ${step.id}`);
    const sent = await provider.sendTransaction(raw);
    if (sent.hash !== calculatedHash) fail(`provider returned an unexpected hash for ${step.id}`);
    receipt = await provider.waitForTransaction(calculatedHash, 1, 180_000);
    if (!receipt) fail(`timed out waiting for ${step.id}`);
    receipt = await verifyTransaction(provider, step, wallet.address);
  }
  if (!receipt) fail(`receipt remains unavailable for ${step.id}`);
  step.state = 'confirmed';
  step.receipt = {
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
  };
  writeJournal(journalFile, journal);
  console.log(`${step.id}: confirmed ${step.transactionHash}`);
}

function expectedFullSubaccount(address: string, name: string): string {
  return utils.hexConcat([address, name]).toLowerCase();
}

function verifyDepositEvent(step: BootstrapStep, receipt: providers.TransactionReceipt): void {
  const endpoint = new utils.Interface(endpointAbi);
  const expectedSubaccount = expectedFullSubaccount(
    step.signer === 'maker' ? RED_MM_MAKER : RED_MM_TAKER,
    step.signer === 'maker' ? RED_MM_MAKER_SUBACCOUNT : RED_MM_TAKER_SUBACCOUNT
  );
  const matches = receipt.logs.some((log) => {
    if (!sameAddress(log.address, RED_MM_ENDPOINT)) return false;
    try {
      const parsed = endpoint.parseLog(log);
      return (
        parsed.name === 'DepositCollateralWithReferral' &&
        String(parsed.args.subaccount).toLowerCase() === expectedSubaccount &&
        BigNumber.from(parsed.args.productId).eq(0) &&
        BigNumber.from(parsed.args.amount).eq(RED_MM_DEPOSIT_RAW) &&
        parsed.args.referralCode === '-1'
      );
    } catch {
      return false;
    }
  });
  if (!matches) fail(`exact deposit event is missing for ${step.id}`);
}

async function verifyPostconditions(
  provider: providers.JsonRpcProvider,
  endpoint: Contract,
  token: Contract,
  journal: BootstrapJournal
): Promise<void> {
  const [makerNative, takerNative, makerToken, takerToken, makerAllowance, takerAllowance, custody, slow] =
    await Promise.all([
      provider.getBalance(RED_MM_MAKER),
      provider.getBalance(RED_MM_TAKER),
      token.balanceOf(RED_MM_MAKER),
      token.balanceOf(RED_MM_TAKER),
      token.allowance(RED_MM_MAKER, RED_MM_ENDPOINT),
      token.allowance(RED_MM_TAKER, RED_MM_ENDPOINT),
      token.balanceOf(RED_MM_CLEARINGHOUSE),
      endpoint.getSlowModeTx(0),
    ]);
  if (makerNative.isZero() || takerNative.isZero()) fail('MM native gas balance is zero after funding');
  if (!makerToken.isZero() || !takerToken.isZero() || !makerAllowance.isZero() || !takerAllowance.isZero()) {
    fail('wallet token or allowance postcondition is not zero after deposit');
  }
  const expectedCustody = BigNumber.from(journal.initialState.clearinghouseCustodyRaw).add(
    BigNumber.from(RED_MM_DEPOSIT_RAW).mul(2)
  );
  if (!custody.eq(expectedCustody)) fail('Clearinghouse token custody did not increase by both exact deposits');
  const initialUpTo = BigNumber.from(journal.initialState.slowModeTxUpTo);
  const finalCount = BigNumber.from(journal.initialState.slowModeTxCount).add(2);
  const observedUpTo = BigNumber.from(slow.txUpTo ?? slow[1]);
  if (!observedUpTo.eq(initialUpTo)) fail('slow-mode execution advanced before bootstrap evidence completed');
  if (!BigNumber.from(slow.txCount ?? slow[2]).eq(finalCount)) {
    fail('slow-mode queue did not increase by exactly two deposits');
  }
  for (const step of journal.steps.filter((candidate) => candidate.id.endsWith('-deposit'))) {
    if (!step.transactionHash) fail(`missing transaction hash for ${step.id}`);
    const receipt = await provider.getTransactionReceipt(step.transactionHash);
    if (!receipt) fail(`missing receipt for ${step.id}`);
    verifyDepositEvent(step, receipt);
  }
}

async function waitForFinality(
  provider: providers.Provider,
  journal: BootstrapJournal,
  confirmations: number,
  signers: Record<SignerName, Wallet>
): Promise<void> {
  for (const step of journal.steps) {
    if (!step.transactionHash) fail(`missing transaction hash for ${step.id}`);
    const receipt = await provider.waitForTransaction(step.transactionHash, confirmations, 300_000);
    if (!receipt || receipt.status !== 1) fail(`finality failed for ${step.id}`);
    const exactReceipt = await verifyTransaction(provider, step, signerFor(step, signers).address);
    if (!exactReceipt || exactReceipt.blockHash !== receipt.blockHash)
      fail(`exact transaction proof failed for ${step.id}`);
    const canonical = await provider.getBlock(receipt.blockNumber);
    if (!canonical || canonical.hash !== receipt.blockHash) fail(`final receipt is not canonical for ${step.id}`);
    const head = await provider.getBlockNumber();
    if (head - receipt.blockNumber + 1 < confirmations) fail(`confirmation depth is insufficient for ${step.id}`);
  }
}

function assertSigner(wallet: Wallet, expected: string, label: string): void {
  if (!sameAddress(wallet.address, expected)) fail(`${label} key does not derive the approved public address`);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const provider = new providers.JsonRpcProvider(cli.rpcUrl, { chainId: RED_MM_CHAIN_ID, name: '0g-testnet' });
  const authorityKey = readPrivateKey(cli.authorityKeyFile, 'authority key file');
  const makerKey = readPrivateKey(cli.makerKeyFile, 'maker key file');
  const takerKey = readPrivateKey(cli.takerKeyFile, 'taker key file');
  const signers: Record<SignerName, Wallet> = {
    authority: new Wallet(authorityKey, provider),
    maker: new Wallet(makerKey, provider),
    taker: new Wallet(takerKey, provider),
  };
  assertSigner(signers.authority, RED_MM_AUTHORITY, 'authority');
  assertSigner(signers.maker, RED_MM_MAKER, 'maker');
  assertSigner(signers.taker, RED_MM_TAKER, 'taker');

  const rawChainId = await provider.send('eth_chainId', []);
  if (BigNumber.from(rawChainId).toNumber() !== RED_MM_CHAIN_ID) fail('RPC eth_chainId is not 16602');
  if ((await provider.getNetwork()).chainId !== RED_MM_CHAIN_ID) fail('provider network is not chain 16602');
  await requireCode(provider, RED_MM_ENDPOINT, 'Red Endpoint');
  await requireCode(provider, RED_MM_USDCE, 'USDC.e');
  await requireCode(provider, RED_MM_CLEARINGHOUSE, 'Red Clearinghouse');
  await requireCode(provider, RED_MM_SPOT_ENGINE, 'Red SpotEngine');
  const endpoint = new Contract(RED_MM_ENDPOINT, endpointAbi, provider);
  const token = new Contract(RED_MM_USDCE, tokenAbi, provider);
  const clearinghouseContract = new Contract(RED_MM_CLEARINGHOUSE, clearinghouseAbi, provider);
  const spotEngine = new Contract(RED_MM_SPOT_ENGINE, spotEngineAbi, provider);
  const [owner, sequencer, clearinghouse, quote, releaseMode, spotToken, tokenName, tokenSymbol, tokenDecimals] =
    await Promise.all([
      endpoint.owner(),
      endpoint.getSequencer(),
      endpoint.clearinghouse(),
      clearinghouseContract.getQuote(),
      clearinghouseContract.getReleaseMode(),
      spotEngine.getToken(0),
      token.name(),
      token.symbol(),
      token.decimals(),
    ]);
  if (!sameAddress(owner, RED_MM_AUTHORITY) || !sameAddress(sequencer, RED_MM_AUTHORITY)) {
    fail('Red Endpoint owner/sequencer does not match the approved authority');
  }
  if (!sameAddress(clearinghouse, RED_MM_CLEARINGHOUSE)) fail('Red Endpoint clearinghouse does not match');
  if (!sameAddress(quote, RED_MM_USDCE) || !sameAddress(spotToken, RED_MM_USDCE)) {
    fail('Red collateral topology does not bind product 0 to canonical USDC.e');
  }
  if (Number(releaseMode) !== 0) fail('Red Clearinghouse deposits are not active');
  if (tokenName !== 'USD Coin' || tokenSymbol !== 'USDC.e' || tokenDecimals !== 6) {
    fail('canonical USDC.e metadata does not match');
  }

  let journal: BootstrapJournal;
  if (fs.existsSync(cli.journalFile)) {
    journal = loadJournal(cli.journalFile);
    if (journal.confirmationsRequired !== cli.confirmations) fail('journal confirmation policy changed');
  } else {
    const authorityNonce = await stableNonce(provider, RED_MM_AUTHORITY);
    const [makerNonce, takerNonce, gasPrice, slow, custody, authorityBalance] = await Promise.all([
      assertFreshWallet(provider, token, RED_MM_MAKER, 'maker'),
      assertFreshWallet(provider, token, RED_MM_TAKER, 'taker'),
      provider.getGasPrice(),
      endpoint.getSlowModeTx(0),
      token.balanceOf(RED_MM_CLEARINGHOUSE),
      provider.getBalance(RED_MM_AUTHORITY),
    ]);
    if (gasPrice.lt(MIN_GAS_PRICE_WEI) || gasPrice.gt(MAX_GAS_PRICE_WEI)) fail('live gas price is outside policy');
    const authorityRequired = BigNumber.from(RED_MM_NATIVE_TOP_UP_WEI)
      .mul(2)
      .add(gasPrice.mul(21_000 * 2));
    if (authorityBalance.lt(authorityRequired)) fail('Red authority lacks the exact funding and gas requirement');
    journal = {
      schemaVersion: 1,
      kind: JOURNAL_KIND,
      chainId: RED_MM_CHAIN_ID,
      endpoint: RED_MM_ENDPOINT,
      token: RED_MM_USDCE,
      authority: RED_MM_AUTHORITY,
      maker: { address: RED_MM_MAKER, subaccount: RED_MM_MAKER_SUBACCOUNT },
      taker: { address: RED_MM_TAKER, subaccount: RED_MM_TAKER_SUBACCOUNT },
      nativeTopUpWei: RED_MM_NATIVE_TOP_UP_WEI,
      depositAmountRaw: RED_MM_DEPOSIT_RAW,
      confirmationsRequired: cli.confirmations,
      initialState: {
        authorityNonce,
        makerNonce,
        takerNonce,
        slowModeTxUpTo: BigNumber.from(slow.txUpTo ?? slow[1]).toString(),
        slowModeTxCount: BigNumber.from(slow.txCount ?? slow[2]).toString(),
        clearinghouseCustodyRaw: BigNumber.from(custody).toString(),
      },
      steps: buildBootstrapSteps(authorityNonce, makerNonce, takerNonce, gasPrice.toString()),
      complete: false,
    };
    if (cli.execute) writeJournal(cli.journalFile, journal, true);
  }

  if (!cli.execute) {
    console.log(
      JSON.stringify({
        status: 'dry-run-ready',
        chainId: RED_MM_CHAIN_ID,
        authority: RED_MM_AUTHORITY,
        maker: RED_MM_MAKER,
        taker: RED_MM_TAKER,
        nativeTopUp: '0.05 0G each',
        deposit: '50000 USDC.e each',
        transactionCount: journal.steps.length,
        executeConfirmation: RED_MM_CONFIRMATION,
      })
    );
    return;
  }
  if (journal.complete) {
    await verifyPostconditions(provider, endpoint, token, journal);
    await waitForFinality(provider, journal, cli.confirmations, signers);
    console.log(JSON.stringify({ status: 'already-complete', journal: cli.journalFile }));
    return;
  }

  for (const step of journal.steps) await executeStep(provider, cli.journalFile, journal, step, signers);
  await verifyPostconditions(provider, endpoint, token, journal);
  await waitForFinality(provider, journal, cli.confirmations, signers);
  journal.complete = true;
  writeJournal(cli.journalFile, journal);
  console.log(
    JSON.stringify({
      status: 'complete',
      journal: cli.journalFile,
      transactions: journal.steps.map((step) => ({ id: step.id, hash: step.transactionHash })),
    })
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    let message = error instanceof Error ? error.message : 'unknown failure';
    for (const secret of secretRedactions) if (secret) message = message.split(secret).join('[REDACTED]');
    message = message.replace(/0x[0-9a-fA-F]{130,}/g, '[REDACTED_SIGNED_DATA]');
    console.error(`Red MM bootstrap failed safely: ${message}`);
    process.exitCode = 1;
  });
}
