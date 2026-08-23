import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BigNumber, providers, utils } from 'ethers';

export const GALILEO_AUTHORITY_ROTATION_KIND = 'galileo_red_authority_rotation';
export const GALILEO_AUTHORITY_ROTATION_CHAIN_ID = 16602;
export const GALILEO_AUTHORITY_ROTATION_EVIDENCE = path.resolve(
  __dirname,
  '..',
  'deployments',
  '16602',
  'authority-rotation.json'
);
export const TRACKED_RECOVERED_DEPLOYMENT_MANIFEST = path.resolve(
  __dirname,
  '..',
  'deployments',
  '16602',
  'contract-manifest.schema-v9.json'
);
export const EXPECTED_RECOVERED_MANIFEST_SHA256 = 'bd4768a57d9d6218af5bc9a818dc81424ff915190a2cf90bbe240ffa029676a3';
export const EXPECTED_AUTHORITY_ROTATION_EVIDENCE_SHA256 =
  '9cbee5659488d1c942ce345122eb0eed0276e47eb6c0b7e212ffe3b00cdb4c8d';

export const OLD_AUTHORITY = '0x4e36e0b89048F3508A815946030D10611641B0AF';
export const NEW_AUTHORITY = '0xE31139d7BEe3AE76C7839dCc1849B2C6Ac18f7E4';
export const PROXY_ADMIN = '0x9fA10f3a75657F3Cf12C7f9F7628c91F852c860E';
export const ENDPOINT = '0xb8C398B78Df988AC770790E6De5bb7881F2AC813';

const OWNER_SELECTOR = '0x8da5cb5b';
const GET_SEQUENCER_SELECTOR = '0x4d96a90a';
const SET_SEQUENCER_SELECTOR = '0x2547fa3e';
const TRANSFER_OWNERSHIP_SELECTOR = '0xf2fde38b';
const GET_SIGNER_COUNT_SELECTOR = '0xb715be81';
const GET_PUBKEY_SELECTOR = '0x55e7673b';
const OWNERSHIP_TRANSFERRED_TOPIC = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;

export type AuthorityRotationTransaction = {
  id: string;
  kind: 'native_funding' | 'endpoint_set_sequencer' | 'transfer_ownership' | 'native_sweep';
  nonce: number;
  from: string;
  to: string;
  valueWei: string;
  calldata: string;
  gasLimit: string;
  gasUsed: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: 1;
};

export type ProxyState = {
  name: string;
  proxy: string;
  implementation: string;
  admin: string;
};

export type VerifierPoint = { x: string; y: string };

export type AuthorityRotationEvidence = {
  schemaVersion: 1;
  kind: typeof GALILEO_AUTHORITY_ROTATION_KIND;
  chainId: 16602;
  capturedAt: string;
  sourceDeployment: {
    manifestReference: string;
    manifestSha256: string;
    deployer: string;
  };
  rotation: {
    oldAuthority: string;
    newAuthority: string;
    gasPriceWei: string;
    finalityConfirmationsRequired: 12;
    transactions: AuthorityRotationTransaction[];
  };
  postState: {
    observedBlockNumber: number;
    observedBlockHash: string;
    endpointSequencer: string;
    owners: Record<string, { address: string; owner: string }>;
    proxies: ProxyState[];
    verifierQuorum: {
      signerCount: number;
      signerBitmask: number;
      publicKeysSha256: string;
      publicKeys: VerifierPoint[];
    };
  };
};

export type ReadOnlyAuthorityProvider = Pick<
  providers.Provider,
  | 'getNetwork'
  | 'getBlockNumber'
  | 'getBlock'
  | 'getTransaction'
  | 'getTransactionReceipt'
  | 'getStorageAt'
  | 'getBalance'
  | 'getTransactionCount'
  | 'call'
> & {
  send(method: string, params: unknown[]): Promise<unknown>;
};

const expectedOwners: Record<string, string> = {
  verifier: '0x74CEBff58091683C9a75EFB11D1E586B6b6CDDCf',
  endpoint: ENDPOINT,
  clearinghouse: '0x45C40B425fb736da2C8775612400A89827b156C1',
  spotEngine: '0xf99E5c21ff7a25063594fB8ac64CA0caDDBbaA80',
  perpEngine: '0xcce2dA1907589779f5326a0F5Ae935999e8AD75b',
  offchainExchange: '0x5B83fEf0FFB74856439A425a98EDF0ae65476909',
  proxyAdmin: PROXY_ADMIN,
};

const expectedProxies: ProxyState[] = [
  {
    name: 'verifier',
    proxy: expectedOwners.verifier,
    implementation: '0x768CD0C473c64eb9709AAF769eEC291f27fc353A',
    admin: PROXY_ADMIN,
  },
  {
    name: 'endpoint',
    proxy: ENDPOINT,
    implementation: '0x68F246329a6d064A954D1d02b9979CF820CEE2A5',
    admin: PROXY_ADMIN,
  },
  {
    name: 'clearinghouse',
    proxy: expectedOwners.clearinghouse,
    implementation: '0x843365397cd165b0bE281858bc100Cf68AcEe396',
    admin: PROXY_ADMIN,
  },
  {
    name: 'spotEngine',
    proxy: expectedOwners.spotEngine,
    implementation: '0x298B61A94310c4827eB53002F77D4ff3734e66a2',
    admin: PROXY_ADMIN,
  },
  {
    name: 'perpEngine',
    proxy: expectedOwners.perpEngine,
    implementation: '0x45cB70B7f7656831890692f5822399eF8f9d650F',
    admin: PROXY_ADMIN,
  },
  {
    name: 'offchainExchange',
    proxy: expectedOwners.offchainExchange,
    implementation: '0x4722b79d7e3440Cc4f6f81188C30494A50410Aed',
    admin: PROXY_ADMIN,
  },
];

type ExpectedStep = Pick<AuthorityRotationTransaction, 'id' | 'kind' | 'nonce' | 'to' | 'valueWei' | 'calldata'>;

const encodedNewAuthority = utils.hexZeroPad(NEW_AUTHORITY, 32).slice(2).toLowerCase();
const ownershipCalldata = `${TRANSFER_OWNERSHIP_SELECTOR}${encodedNewAuthority}`;
const sequencerCalldata = `${SET_SEQUENCER_SELECTOR}${encodedNewAuthority}`;

const expectedSteps: ExpectedStep[] = [
  {
    id: 'fund.new-authority',
    kind: 'native_funding',
    nonce: 56,
    to: NEW_AUTHORITY,
    valueWei: '1000000000000000000',
    calldata: '0x',
  },
  {
    id: 'endpoint.set-sequencer',
    kind: 'endpoint_set_sequencer',
    nonce: 57,
    to: ENDPOINT,
    valueWei: '0',
    calldata: sequencerCalldata,
  },
  ...[
    ['verifier.transfer-ownership', expectedOwners.verifier],
    ['clearinghouse.transfer-ownership', expectedOwners.clearinghouse],
    ['spot-engine.transfer-ownership', expectedOwners.spotEngine],
    ['perp-engine.transfer-ownership', expectedOwners.perpEngine],
    ['offchain-exchange.transfer-ownership', expectedOwners.offchainExchange],
    ['endpoint.transfer-ownership', ENDPOINT],
    ['proxy-admin.transfer-ownership', PROXY_ADMIN],
  ].map(([id, to], index) => ({
    id,
    kind: 'transfer_ownership' as const,
    nonce: 58 + index,
    to,
    valueWei: '0',
    calldata: ownershipCalldata,
  })),
  {
    id: 'retire.old-authority-balance',
    kind: 'native_sweep',
    nonce: 65,
    to: NEW_AUTHORITY,
    valueWei: '18704548399482959700',
    calldata: '0x',
  },
];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !utils.isAddress(value)) throw new Error(`${label} must be an address`);
  return utils.getAddress(value);
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be one 32-byte hash`);
  }
  return value.toLowerCase();
}

function requireUnsignedDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be one canonical unsigned decimal string`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a safe unsigned integer`);
  return Number(value);
}

function sameAddress(actual: unknown, expected: string, label: string): void {
  if (requireAddress(actual, label) !== utils.getAddress(expected)) throw new Error(`${label} mismatch`);
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error('capturedAt must be a canonical UTC timestamp');
  }
  if (new Date(value).toISOString() !== value) throw new Error('capturedAt is not a real UTC timestamp');
  return value;
}

function validatePoints(points: unknown, expectedSha256: unknown): VerifierPoint[] {
  if (!Array.isArray(points) || points.length !== 8) throw new Error('verifier public keys must contain eight slots');
  const normalized = points.map((point, index) => {
    const record = requireObject(point, `verifier public key ${index}`);
    const x = record.x;
    const y = record.y;
    if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) {
      throw new Error(`verifier public key ${index}.x must be bytes32`);
    }
    if (typeof y !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(y)) {
      throw new Error(`verifier public key ${index}.y must be bytes32`);
    }
    return { x: x.toLowerCase(), y: y.toLowerCase() };
  });
  const digest = sha256(canonicalJson(normalized));
  if (typeof expectedSha256 !== 'string' || digest !== expectedSha256.toLowerCase()) {
    throw new Error('verifier public key digest mismatch');
  }
  return normalized;
}

export function validateAuthorityRotationEvidence(value: unknown): AuthorityRotationEvidence {
  const evidence = requireObject(value, 'authority rotation evidence') as AuthorityRotationEvidence;
  if (
    evidence.schemaVersion !== 1 ||
    evidence.kind !== GALILEO_AUTHORITY_ROTATION_KIND ||
    evidence.chainId !== GALILEO_AUTHORITY_ROTATION_CHAIN_ID
  ) {
    throw new Error('authority rotation identity mismatch');
  }
  exactTimestamp(evidence.capturedAt);
  const source = requireObject(evidence.sourceDeployment, 'source deployment');
  if (
    source.manifestReference !== 'deployments/16602/contract-manifest.schema-v9.json' ||
    source.manifestSha256 !== EXPECTED_RECOVERED_MANIFEST_SHA256
  ) {
    throw new Error('authority rotation source manifest mismatch');
  }
  sameAddress(source.deployer, OLD_AUTHORITY, 'source deployer');

  const rotation = requireObject(evidence.rotation, 'rotation');
  sameAddress(rotation.oldAuthority, OLD_AUTHORITY, 'old authority');
  sameAddress(rotation.newAuthority, NEW_AUTHORITY, 'new authority');
  if (requireUnsignedDecimal(rotation.gasPriceWei, 'gas price') !== '4000000007') {
    throw new Error('authority rotation gas price mismatch');
  }
  if (rotation.finalityConfirmationsRequired !== 12) throw new Error('authority rotation finality must be 12');
  if (!Array.isArray(rotation.transactions) || rotation.transactions.length !== expectedSteps.length) {
    throw new Error('authority rotation must contain the exact ten-transaction sequence');
  }
  const seenHashes = new Set<string>();
  rotation.transactions.forEach((transaction: AuthorityRotationTransaction, index: number) => {
    const expected = expectedSteps[index];
    if (
      transaction.id !== expected.id ||
      transaction.kind !== expected.kind ||
      transaction.nonce !== expected.nonce ||
      transaction.valueWei !== expected.valueWei ||
      String(transaction.calldata).toLowerCase() !== expected.calldata.toLowerCase()
    ) {
      throw new Error(`authority rotation transaction ${index} plan mismatch`);
    }
    sameAddress(transaction.from, OLD_AUTHORITY, `transaction ${index} sender`);
    sameAddress(transaction.to, expected.to, `transaction ${index} target`);
    requireUnsignedDecimal(transaction.gasLimit, `transaction ${index} gas limit`);
    requireUnsignedDecimal(transaction.gasUsed, `transaction ${index} gas used`);
    if (BigNumber.from(transaction.gasUsed).gt(BigNumber.from(transaction.gasLimit))) {
      throw new Error(`transaction ${index} gas used exceeds its limit`);
    }
    const transactionHash = requireHash(transaction.transactionHash, `transaction ${index} hash`);
    if (seenHashes.has(transactionHash)) throw new Error('authority rotation transaction hashes must be unique');
    seenHashes.add(transactionHash);
    requireSafeInteger(transaction.blockNumber, `transaction ${index} block number`);
    requireHash(transaction.blockHash, `transaction ${index} block hash`);
    if (transaction.status !== 1) throw new Error(`transaction ${index} was not successful`);
  });

  const postState = requireObject(evidence.postState, 'post state');
  const observedBlockNumber = requireSafeInteger(postState.observedBlockNumber, 'observed block number');
  requireHash(postState.observedBlockHash, 'observed block hash');
  if (observedBlockNumber < rotation.transactions[rotation.transactions.length - 1].blockNumber + 11) {
    throw new Error('post-state observation does not provide twelve confirmations for the final transaction');
  }
  sameAddress(postState.endpointSequencer, NEW_AUTHORITY, 'post-state Endpoint sequencer');
  const owners = requireObject(postState.owners, 'post-state owners');
  if (Object.keys(owners).sort().join(',') !== Object.keys(expectedOwners).sort().join(',')) {
    throw new Error('post-state owner coverage mismatch');
  }
  for (const [name, address] of Object.entries(expectedOwners)) {
    const owner = requireObject(owners[name], `${name} owner record`);
    sameAddress(owner.address, address, `${name} owner target`);
    sameAddress(owner.owner, NEW_AUTHORITY, `${name} owner`);
  }
  if (!Array.isArray(postState.proxies) || postState.proxies.length !== expectedProxies.length) {
    throw new Error('post-state proxy coverage mismatch');
  }
  postState.proxies.forEach((proxy: ProxyState, index: number) => {
    const expected = expectedProxies[index];
    if (proxy.name !== expected.name) throw new Error(`proxy ${index} name mismatch`);
    sameAddress(proxy.proxy, expected.proxy, `${proxy.name} proxy`);
    sameAddress(proxy.implementation, expected.implementation, `${proxy.name} implementation`);
    sameAddress(proxy.admin, expected.admin, `${proxy.name} admin`);
  });
  const quorum = requireObject(postState.verifierQuorum, 'verifier quorum');
  if (quorum.signerCount !== 3 || quorum.signerBitmask !== 7) throw new Error('verifier quorum metadata mismatch');
  validatePoints(quorum.publicKeys, quorum.publicKeysSha256);
  if (quorum.publicKeysSha256 !== '1f73f9270793b1e6b299fa1a158afa527ae114a23ff2b1dbdc9b822f6f910a2a') {
    throw new Error('verifier public key set is not the recovered deployment key set');
  }
  return evidence;
}

export function loadTrackedAuthorityRotationEvidence(
  file = GALILEO_AUTHORITY_ROTATION_EVIDENCE,
  expectedSha256 = EXPECTED_AUTHORITY_ROTATION_EVIDENCE_SHA256,
  sourceManifestFile = TRACKED_RECOVERED_DEPLOYMENT_MANIFEST
): AuthorityRotationEvidence {
  const bytes = fs.readFileSync(file);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error('tracked authority rotation evidence SHA-256 mismatch');
  }
  const evidence = validateAuthorityRotationEvidence(JSON.parse(bytes.toString('utf8')));
  let sourceManifestBytes: Buffer;
  try {
    sourceManifestBytes = fs.readFileSync(sourceManifestFile);
  } catch {
    throw new Error('tracked recovered deployment manifest is missing or unreadable');
  }
  if (sha256(sourceManifestBytes) !== evidence.sourceDeployment.manifestSha256) {
    throw new Error('tracked recovered deployment manifest SHA-256 mismatch');
  }
  let sourceManifest: Record<string, unknown>;
  try {
    sourceManifest = requireObject(JSON.parse(sourceManifestBytes.toString('utf8')), 'recovered deployment manifest');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('recovered deployment manifest')) throw error;
    throw new Error('tracked recovered deployment manifest is not valid JSON');
  }
  if (
    sourceManifest.schemaVersion !== 9 ||
    requireObject(sourceManifest.network, 'recovered deployment network').chainId !== 16602
  ) {
    throw new Error('tracked recovered deployment manifest identity mismatch');
  }
  sameAddress(sourceManifest.deployer, OLD_AUTHORITY, 'recovered deployment deployer');
  sameAddress(sourceManifest.sequencer, OLD_AUTHORITY, 'recovered deployment original sequencer');
  return evidence;
}

function addressTopic(address: string): string {
  return utils.hexZeroPad(address, 32).toLowerCase();
}

function storageAddress(value: string, label: string): string {
  if (!utils.isHexString(value, 32)) throw new Error(`${label} storage word must be bytes32`);
  return utils.getAddress(utils.hexDataSlice(value, 12));
}

async function readAddress(
  provider: ReadOnlyAuthorityProvider,
  target: string,
  selector: string,
  blockTag: providers.BlockTag,
  label: string
): Promise<string> {
  const result = await provider.call({ to: target, data: selector }, blockTag);
  if (!utils.isHexString(result, 32)) throw new Error(`${label} did not return one ABI address`);
  return utils.getAddress(utils.defaultAbiCoder.decode(['address'], result)[0]);
}

async function readVerifierPoints(
  provider: ReadOnlyAuthorityProvider,
  verifier: string,
  blockTag: providers.BlockTag
): Promise<{ signerCount: number; signerBitmask: number; publicKeys: VerifierPoint[] }> {
  const signerCountBytes = await provider.call({ to: verifier, data: GET_SIGNER_COUNT_SELECTOR }, blockTag);
  if (!utils.isHexString(signerCountBytes, 32)) throw new Error('Verifier signer count response is invalid');
  const signerCountValue = BigNumber.from(utils.defaultAbiCoder.decode(['uint256'], signerCountBytes)[0]);
  if (signerCountValue.gt(BigNumber.from(Number.MAX_SAFE_INTEGER.toString()))) {
    throw new Error('Verifier signer count exceeds a safe integer');
  }
  const publicKeys: VerifierPoint[] = [];
  let signerBitmask = 0;
  for (let index = 0; index < 8; index += 1) {
    const data = utils.hexConcat([GET_PUBKEY_SELECTOR, utils.defaultAbiCoder.encode(['uint8'], [index])]);
    const response = await provider.call({ to: verifier, data }, blockTag);
    if (!utils.isHexString(response, 64)) throw new Error(`Verifier public key ${index} response is invalid`);
    const [x, y] = utils.defaultAbiCoder.decode(['uint256', 'uint256'], response);
    const point = {
      x: utils.hexZeroPad(BigNumber.from(x).toHexString(), 32).toLowerCase(),
      y: utils.hexZeroPad(BigNumber.from(y).toHexString(), 32).toLowerCase(),
    };
    if (point.x !== ZERO_BYTES32 || point.y !== ZERO_BYTES32) signerBitmask |= 1 << index;
    publicKeys.push(point);
  }
  return { signerCount: signerCountValue.toNumber(), signerBitmask, publicKeys };
}

async function verifyPostStateAt(
  provider: ReadOnlyAuthorityProvider,
  evidence: AuthorityRotationEvidence,
  blockTag: providers.BlockTag,
  label: string
): Promise<void> {
  for (const [name, record] of Object.entries(evidence.postState.owners)) {
    const owner = await readAddress(provider, record.address, OWNER_SELECTOR, blockTag, `${label} ${name} owner`);
    if (owner !== utils.getAddress(record.owner)) throw new Error(`${label} ${name} owner drift`);
  }
  const sequencer = await readAddress(
    provider,
    ENDPOINT,
    GET_SEQUENCER_SELECTOR,
    blockTag,
    `${label} Endpoint sequencer`
  );
  if (sequencer !== utils.getAddress(evidence.postState.endpointSequencer)) {
    throw new Error(`${label} Endpoint sequencer drift`);
  }
  for (const proxy of evidence.postState.proxies) {
    const implementation = storageAddress(
      await provider.getStorageAt(proxy.proxy, EIP1967_IMPLEMENTATION_SLOT, blockTag),
      `${label} ${proxy.name} implementation`
    );
    const admin = storageAddress(
      await provider.getStorageAt(proxy.proxy, EIP1967_ADMIN_SLOT, blockTag),
      `${label} ${proxy.name} admin`
    );
    if (implementation !== utils.getAddress(proxy.implementation)) {
      throw new Error(`${label} ${proxy.name} implementation drift`);
    }
    if (admin !== utils.getAddress(proxy.admin)) throw new Error(`${label} ${proxy.name} admin drift`);
  }
  const actualQuorum = await readVerifierPoints(provider, expectedOwners.verifier, blockTag);
  if (
    actualQuorum.signerCount !== evidence.postState.verifierQuorum.signerCount ||
    actualQuorum.signerBitmask !== evidence.postState.verifierQuorum.signerBitmask ||
    sha256(canonicalJson(actualQuorum.publicKeys)) !== evidence.postState.verifierQuorum.publicKeysSha256
  ) {
    throw new Error(`${label} Verifier quorum drift`);
  }
}

async function verifyRetiredAuthorityAt(
  provider: ReadOnlyAuthorityProvider,
  blockTag: providers.BlockTag,
  label: string
): Promise<void> {
  const balance = await provider.getBalance(OLD_AUTHORITY, blockTag);
  if (!balance.isZero()) throw new Error(`${label} retired authority balance is not zero`);
  const nonce = await provider.getTransactionCount(OLD_AUTHORITY, blockTag);
  if (nonce !== 66) throw new Error(`${label} retired authority nonce drift`);
}

function parseRpcChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error('eth_chainId returned a non-canonical value');
  }
  const chainId = BigNumber.from(value);
  if (chainId.gt(BigNumber.from(Number.MAX_SAFE_INTEGER.toString()))) {
    throw new Error('eth_chainId exceeds a safe integer');
  }
  return chainId.toNumber();
}

export async function verifyAuthorityRotationEvidence(
  provider: ReadOnlyAuthorityProvider,
  evidenceInput: unknown
): Promise<{ headBlock: number; transactionCount: number; authority: string }> {
  const evidence = validateAuthorityRotationEvidence(evidenceInput);
  const rpcChainId = parseRpcChainId(await provider.send('eth_chainId', []));
  if (rpcChainId !== GALILEO_AUTHORITY_ROTATION_CHAIN_ID) {
    throw new Error(`authority rotation RPC is chain ${rpcChainId}, not 16602`);
  }
  const network = await provider.getNetwork();
  if (network.chainId !== GALILEO_AUTHORITY_ROTATION_CHAIN_ID) {
    throw new Error(`authority rotation evidence is for chain 16602, not ${network.chainId}`);
  }
  const headBlock = await provider.getBlockNumber();
  const observedBlock = await provider.getBlock(evidence.postState.observedBlockNumber);
  if (!observedBlock || observedBlock.hash.toLowerCase() !== evidence.postState.observedBlockHash.toLowerCase()) {
    throw new Error('authority rotation post-state observation block is missing or reorged');
  }
  for (const transactionEvidence of evidence.rotation.transactions) {
    const transaction = await provider.getTransaction(transactionEvidence.transactionHash);
    const receipt = await provider.getTransactionReceipt(transactionEvidence.transactionHash);
    const block = await provider.getBlock(transactionEvidence.blockNumber);
    if (!transaction || !receipt || !block) throw new Error(`${transactionEvidence.id} canonical evidence is missing`);
    if (
      transaction.hash.toLowerCase() !== transactionEvidence.transactionHash.toLowerCase() ||
      transaction.nonce !== transactionEvidence.nonce ||
      utils.getAddress(transaction.from) !== utils.getAddress(transactionEvidence.from) ||
      !transaction.to ||
      utils.getAddress(transaction.to) !== utils.getAddress(transactionEvidence.to) ||
      transaction.value.toString() !== transactionEvidence.valueWei ||
      transaction.data.toLowerCase() !== transactionEvidence.calldata.toLowerCase() ||
      transaction.gasLimit.toString() !== transactionEvidence.gasLimit ||
      !transaction.gasPrice ||
      transaction.gasPrice.toString() !== evidence.rotation.gasPriceWei
    ) {
      throw new Error(`${transactionEvidence.id} transaction drift`);
    }
    if (
      receipt.status !== 1 ||
      receipt.blockNumber !== transactionEvidence.blockNumber ||
      receipt.blockHash.toLowerCase() !== transactionEvidence.blockHash.toLowerCase() ||
      receipt.gasUsed.toString() !== transactionEvidence.gasUsed ||
      !receipt.to ||
      utils.getAddress(receipt.to) !== utils.getAddress(transactionEvidence.to) ||
      utils.getAddress(receipt.from) !== utils.getAddress(transactionEvidence.from) ||
      block.hash.toLowerCase() !== transactionEvidence.blockHash.toLowerCase()
    ) {
      throw new Error(`${transactionEvidence.id} receipt drift`);
    }
    const confirmations = headBlock - transactionEvidence.blockNumber + 1;
    if (confirmations < evidence.rotation.finalityConfirmationsRequired) {
      throw new Error(`${transactionEvidence.id} has only ${confirmations} confirmations`);
    }
    if (transactionEvidence.kind === 'transfer_ownership') {
      if (
        receipt.logs.length !== 1 ||
        utils.getAddress(receipt.logs[0].address) !== utils.getAddress(transactionEvidence.to) ||
        receipt.logs[0].data !== '0x' ||
        receipt.logs[0].topics.length !== 3 ||
        receipt.logs[0].topics[0].toLowerCase() !== OWNERSHIP_TRANSFERRED_TOPIC ||
        receipt.logs[0].topics[1].toLowerCase() !== addressTopic(OLD_AUTHORITY) ||
        receipt.logs[0].topics[2].toLowerCase() !== addressTopic(NEW_AUTHORITY)
      ) {
        throw new Error(`${transactionEvidence.id} OwnershipTransferred evidence drift`);
      }
    } else if (receipt.logs.length !== 0) {
      throw new Error(`${transactionEvidence.id} unexpectedly emitted logs`);
    }
  }
  await verifyPostStateAt(provider, evidence, evidence.postState.observedBlockNumber, 'recorded post-state');
  await verifyRetiredAuthorityAt(provider, evidence.postState.observedBlockNumber, 'recorded post-state');
  await verifyPostStateAt(provider, evidence, 'latest', 'live state');
  await verifyRetiredAuthorityAt(provider, 'latest', 'live state');
  return {
    headBlock,
    transactionCount: evidence.rotation.transactions.length,
    authority: utils.getAddress(evidence.rotation.newAuthority),
  };
}
