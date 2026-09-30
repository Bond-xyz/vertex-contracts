/**
 * Deploy the canonical Bond release (vertex-contracts bond/galileo-refork at
 * d301054: OtterSec-audited base 6d5df597 + Bond deltas) as the dedicated
 * bigbertha/v1.2 set on 0G Galileo testnet (chain 16602).
 *
 * Graph (same order as scripts/deploy-galileo.ts prepare/finalize, without
 * the attestation chain): MockSanctionsList, ClearinghouseLiq; transparent
 * proxies Verifier, Endpoint, Clearinghouse (delegatecall to ClearinghouseLiq
 * allowed), SpotEngine, PerpEngine, OffchainExchange; Verifier.initialize
 * (8 points), Clearinghouse.initialize(endpoint, USDC.e, liq, spreads),
 * addEngine(spot), addEngine(perp), OffchainExchange.initialize; per market
 * VirtualBook(productId); Endpoint.initialize(sanctions, SEQUENCER,
 * offchainExchange, clearinghouse, verifier, initialPrices); addProduct x4.
 *
 * Inputs: PERPDEX_DEPLOY_INPUTS, PERPDEX_INITIAL_PRICES, PERPDEX_DEPLOYMENT_OUTPUT
 * (see docs/ops/galileo-v12-dedicated-contracts/deploy in bond-perpdex), and
 * PERPDEX_CONTRACT_SOURCE_PIN, the path to bond-perpdex
 * deploy/environments/carthage/contracts/contract-source.json. Before any provider
 * access the script proves that the checkout it runs from is the pinned
 * lineage: HEAD must be one of the pin's reviewed release commits, the audited
 * base must be an ancestor, no tracked file may be modified, and no untracked
 * Solidity may exist (Hardhat would compile it in). Anything else is refused,
 * so a wrong-ref deployment cannot be repeated with this tooling; the recorded
 * `source` is the verified HEAD plus the pin's lineage, never a literal here.
 * Refuses any chain other than 16602 unless the network is hardhat (dry run
 * with a MockERC20 quote). Refuses to overwrite the output file.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ethers, network, upgrades } from 'hardhat';
import { BigNumber, Contract, utils } from 'ethers';

const CHAIN_ID = 16602;
const USDCE = '0xF2506aa3684871549083d235453a1dcDcCB3396c';
const GIT_OBJECT = /^[0-9a-f]{40}$/;

type ContractSourcePin = {
  repository: string;
  branch: string;
  head: string;
  auditedBaseCommit: string;
  auditedBaseTag: string;
  reviewedReleaseCommits: string[];
  supersededSources: { commit: string }[];
};
type VerifiedSource = { repository: string; branch: string; commit: string; tree: string; auditedBaseCommit: string; auditedBaseTag: string };

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Fail closed unless this checkout is a reviewed release commit of the pinned
 * lineage. Runs first, before inputs are read or a provider is touched.
 */
function requirePinnedContractSource(): VerifiedSource {
  const pinPath = path.resolve(
    required(process.env.PERPDEX_CONTRACT_SOURCE_PIN, 'PERPDEX_CONTRACT_SOURCE_PIN (path to bond-perpdex deploy/environments/carthage/contracts/contract-source.json)'),
  );
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as ContractSourcePin;
  for (const key of ['repository', 'branch', 'head', 'auditedBaseCommit', 'auditedBaseTag'] as const) {
    if (typeof pin[key] !== 'string' || !pin[key]) throw new Error(`${pinPath} is missing ${key}`);
  }
  if (!Array.isArray(pin.reviewedReleaseCommits) || pin.reviewedReleaseCommits.length === 0 || !pin.reviewedReleaseCommits.every((c) => GIT_OBJECT.test(c))) {
    throw new Error(`${pinPath} reviewedReleaseCommits must be a non-empty list of full commit ids`);
  }
  const superseded = new Set((pin.supersededSources ?? []).map((entry) => entry.commit));
  const cwd = process.cwd();
  const toplevel = git(cwd, ['rev-parse', '--show-toplevel']);
  if (path.normalize(path.relative(toplevel, cwd) || '.') !== '.') {
    throw new Error(`refusing deployment: run from the vertex-contracts root, not ${cwd}`);
  }
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (superseded.has(head)) throw new Error(`refusing deployment: vertex-contracts HEAD ${head} is a superseded contract source`);
  if (!pin.reviewedReleaseCommits.includes(head)) {
    throw new Error(
      `refusing deployment: vertex-contracts HEAD ${head} is not a reviewed ${pin.repository} ${pin.branch} release commit ` +
        `(pinned: ${pin.reviewedReleaseCommits.join(', ')}); deploy only from the pin`,
    );
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', pin.auditedBaseCommit, 'HEAD'], { cwd, stdio: 'ignore' });
  } catch {
    throw new Error(`refusing deployment: audited base ${pin.auditedBaseCommit} is not an ancestor of ${head}`);
  }
  // NUL-delimited porcelain: paths arrive verbatim, never C-quoted, so a
  // pathname with a space or a non-ASCII byte cannot slip past the suffix and
  // prefix checks below. Entries are not trimmed: the status code may be a
  // space. A rename or copy record carries a second NUL-terminated path; it is
  // never reached because any code other than '??' refuses first.
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const entry of status.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code !== '??') throw new Error(`refusing deployment: tracked file ${file} is modified (${code.trim()}); the pinned source must be untouched`);
    if (file.endsWith('.sol') || file.startsWith('contracts/')) throw new Error(`refusing deployment: untracked Solidity ${file} would be compiled into the pinned source`);
  }
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']);
  console.log(`contract source pinned: ${pin.repository} ${pin.branch} @ ${head} (tree ${tree}, audited base ${pin.auditedBaseCommit} ${pin.auditedBaseTag}); checkout verified`);
  return { repository: pin.repository, branch: pin.branch, commit: head, tree, auditedBaseCommit: pin.auditedBaseCommit, auditedBaseTag: pin.auditedBaseTag };
}

type Product = {
  symbol: string;
  productId: number;
  sizeIncrementX18: string;
  minSizeX18: string;
  lpSpreadX18: string;
  risk: { longWeightInitial: number; shortWeightInitial: number; longWeightMaintenance: number; shortWeightMaintenance: number };
};
type Inputs = {
  chainId: number;
  quoteToken: string;
  sequencer: string;
  verifierPublicKeys: { x: string; y: string }[];
  signerBitmask: number;
  spreads: string;
  products: Product[];
};

const required = (value: string | undefined, label: string): string => {
  if (!value) throw new Error(`${label} is required`);
  return value;
};
const address = (value: string, label: string): string => {
  if (!utils.isAddress(value) || value === ethers.constants.AddressZero) throw new Error(`${label} must be a non-zero address`);
  return utils.getAddress(value);
};

async function codeHash(target: string): Promise<string> {
  return utils.keccak256(await ethers.provider.getCode(target));
}

async function proxyRecord(label: string, proxy: Contract) {
  const implementation = await upgrades.erc1967.getImplementationAddress(proxy.address);
  const admin = await upgrades.erc1967.getAdminAddress(proxy.address);
  const receipt = await proxy.deployTransaction.wait();
  return {
    proxy: proxy.address,
    implementation,
    admin,
    deploymentBlock: receipt.blockNumber,
    deploymentTx: receipt.transactionHash,
    proxyRuntimeCodeHash: await codeHash(proxy.address),
    implementationRuntimeCodeHash: await codeHash(implementation),
    adminRuntimeCodeHash: await codeHash(admin),
    label,
  };
}

async function main() {
  const source = requirePinnedContractSource();
  const inputs = JSON.parse(fs.readFileSync(required(process.env.PERPDEX_DEPLOY_INPUTS, 'PERPDEX_DEPLOY_INPUTS'), 'utf8')) as Inputs;
  const prices = JSON.parse(fs.readFileSync(required(process.env.PERPDEX_INITIAL_PRICES, 'PERPDEX_INITIAL_PRICES'), 'utf8')) as Record<string, string>;
  const output = path.resolve(required(process.env.PERPDEX_DEPLOYMENT_OUTPUT, 'PERPDEX_DEPLOYMENT_OUTPUT'));
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
  const chain = (await ethers.provider.getNetwork()).chainId;
  const local = network.name === 'hardhat';
  if (!local && chain !== CHAIN_ID) throw new Error(`refusing deployment: chain ${chain} is not ${CHAIN_ID}`);
  if (inputs.chainId !== CHAIN_ID) throw new Error('inputs are not for chain 16602');

  const [deployer] = await ethers.getSigners();
  const sequencer = address(inputs.sequencer, 'sequencer');
  if (inputs.verifierPublicKeys.length !== 3 || inputs.signerBitmask !== 7) throw new Error('exactly three verifier keys with bitmask 7 are required');
  const points = [...inputs.verifierPublicKeys.map((p) => ({ x: BigNumber.from(p.x), y: BigNumber.from(p.y) })), ...Array.from({ length: 5 }, () => ({ x: BigNumber.from(0), y: BigNumber.from(0) }))];
  for (const [index, point] of points.slice(0, 3).entries()) {
    if (point.x.isZero() || point.y.isZero()) throw new Error(`verifier key ${index} is zero`);
  }

  let quote = utils.getAddress(inputs.quoteToken);
  if (local) {
    const Mock = await ethers.getContractFactory('MockERC20', deployer);
    const mock = await Mock.deploy('USDC.e', 'USDC.e', 6);
    await mock.deployed();
    quote = mock.address;
    console.log(`local dry run: mock quote ${quote}`);
  } else {
    if (quote !== utils.getAddress(USDCE)) throw new Error('quote must be the shared Galileo USDC.e');
    if ((await ethers.provider.getCode(quote)) === '0x') throw new Error('USDC.e has no bytecode');
  }
  const startBalance = await deployer.getBalance();
  const startNonce = await deployer.getTransactionCount('pending');
  console.log(`deployer ${deployer.address} nonce ${startNonce} balance ${utils.formatEther(startBalance)} 0G; sequencer ${sequencer}`);

  const sanctions = await (await ethers.getContractFactory('MockSanctionsList', deployer)).deploy();
  await sanctions.deployed();
  const liq = await (await ethers.getContractFactory('ClearinghouseLiq', deployer)).deploy();
  await liq.deployed();
  console.log(`sanctions ${sanctions.address}, clearinghouseLiq ${liq.address}`);

  const shell = async (name: string, unsafeAllow: string[] = []) => {
    const factory = await ethers.getContractFactory(name, deployer);
    const proxy = await upgrades.deployProxy(factory, [], { initializer: false, kind: 'transparent', unsafeAllow: unsafeAllow as any, useDeployedImplementation: false });
    await proxy.deployed();
    console.log(`${name} proxy ${proxy.address}`);
    return proxy;
  };
  const verifier = await shell('Verifier');
  const endpoint = await shell('Endpoint');
  const clearinghouse = await shell('Clearinghouse', ['delegatecall']);
  const spotEngine = await shell('SpotEngine');
  const perpEngine = await shell('PerpEngine');
  const offchainExchange = await shell('OffchainExchange');

  await (await verifier.initialize(points)).wait();
  await (await clearinghouse.initialize(endpoint.address, quote, liq.address, inputs.spreads)).wait();
  await (await clearinghouse.addEngine(spotEngine.address, offchainExchange.address, 0)).wait();
  await (await clearinghouse.addEngine(perpEngine.address, offchainExchange.address, 1)).wait();
  await (await offchainExchange.initialize(clearinghouse.address, endpoint.address)).wait();

  const Book = await ethers.getContractFactory('VirtualBook', deployer);
  const books: Record<string, { contract: Contract; receipt: any }> = {};
  for (const product of inputs.products) {
    const book = await Book.deploy(product.productId);
    await book.deployed();
    books[product.symbol] = { contract: book, receipt: await book.deployTransaction.wait() };
    if (Number(await book.productId()) !== product.productId) throw new Error(`${product.symbol} VirtualBook productId mismatch`);
  }

  const maxId = Math.max(...inputs.products.map((p) => p.productId));
  const initialPrices: string[] = Array(maxId + 1).fill('0');
  initialPrices[0] = utils.parseUnits('1', 18).toString();
  for (const product of inputs.products) {
    const price = prices[String(product.productId)];
    if (!price || BigNumber.from(price).lte(0)) throw new Error(`missing initial price for product ${product.productId}`);
    initialPrices[product.productId] = price;
  }
  const endpointInit = await (await endpoint.initialize(sanctions.address, sequencer, offchainExchange.address, clearinghouse.address, verifier.address, initialPrices)).wait();
  if ((await endpoint.getSequencer()) !== sequencer) throw new Error('sequencer registration failed');
  if (!BigNumber.from(await clearinghouse.getReleaseMode()).isZero()) throw new Error('release mode is not ACTIVE');
  console.log(`Endpoint initialized at block ${endpointInit.blockNumber}; sequencer registered ${sequencer}`);

  const markets: Record<string, unknown> = {};
  for (const product of inputs.products) {
    const book = books[product.symbol];
    const receipt = await (
      await perpEngine.addProduct(product.productId, book.contract.address, product.sizeIncrementX18, product.minSizeX18, product.lpSpreadX18, { ...product.risk, priceX18: initialPrices[product.productId] })
    ).wait();
    if (utils.getAddress(await offchainExchange.getVirtualBook(product.productId)) !== book.contract.address) throw new Error(`${product.symbol} book registration mismatch`);
    markets[product.symbol] = {
      productId: product.productId,
      virtualBook: book.contract.address,
      virtualBookDeploymentBlock: book.receipt.blockNumber,
      virtualBookDeploymentTx: book.receipt.transactionHash,
      virtualBookRuntimeCodeHash: await codeHash(book.contract.address),
      addProductBlock: receipt.blockNumber,
      addProductTx: receipt.transactionHash,
      sizeIncrementX18: product.sizeIncrementX18,
      minSizeX18: product.minSizeX18,
      risk: { ...product.risk, priceX18: initialPrices[product.productId] },
    };
    console.log(`${product.symbol} product ${product.productId} added, book ${book.contract.address}`);
  }

  const sanctionsReceipt = await sanctions.deployTransaction.wait();
  const liqReceipt = await liq.deployTransaction.wait();
  const endNonce = await deployer.getTransactionCount('pending');
  const manifest = {
    schemaVersion: 1,
    kind: 'carthage-dedicated-galileo-set',
    source: { ...source, path: 'contracts', solc: '0.8.13', optimizerRuns: 200 },
    network: { name: local ? 'hardhat-dry-run' : '0G Galileo Testnet', chainId: chain },
    deployer: deployer.address,
    sequencer,
    sequencerUsesDeployer: sequencer === deployer.address,
    quoteToken: quote,
    transactions: { firstNonce: startNonce, count: endNonce - startNonce },
    gasSpentOg: utils.formatEther(startBalance.sub(await deployer.getBalance())),
    contracts: {
      sanctions: { address: sanctions.address, deploymentBlock: sanctionsReceipt.blockNumber, deploymentTx: sanctionsReceipt.transactionHash, runtimeCodeHash: await codeHash(sanctions.address) },
      clearinghouseLiq: { address: liq.address, deploymentBlock: liqReceipt.blockNumber, deploymentTx: liqReceipt.transactionHash, runtimeCodeHash: await codeHash(liq.address) },
      verifier: { ...(await proxyRecord('verifier', verifier)), publicKeys: points.map((p) => ({ x: utils.hexZeroPad(p.x.toHexString(), 32), y: utils.hexZeroPad(p.y.toHexString(), 32) })), signerCount: 3, signerBitmask: 7 },
      endpoint: { ...(await proxyRecord('endpoint', endpoint)), initializeBlock: endpointInit.blockNumber, initializeTx: endpointInit.transactionHash },
      clearinghouse: await proxyRecord('clearinghouse', clearinghouse),
      spotEngine: await proxyRecord('spotEngine', spotEngine),
      perpEngine: await proxyRecord('perpEngine', perpEngine),
      offchainExchange: await proxyRecord('offchainExchange', offchainExchange),
    },
    markets,
    initialPrices,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`wrote ${output}; ${manifest.transactions.count} transactions, ${manifest.gasSpentOg} 0G spent`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
