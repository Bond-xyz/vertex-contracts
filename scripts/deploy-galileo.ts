import fs from 'fs';
import path from 'path';
import { Manifest, ManifestData } from '@openzeppelin/upgrades-core';
import { artifacts, ethers, network as hardhatNetwork, upgrades } from 'hardhat';
import { BigNumber, Contract, ContractReceipt, ContractTransaction, utils } from 'ethers';
import {
  GALILEO_CHAIN_ID,
  GALILEO_RELEASE_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  initialPrices,
  requireGalileoUsdce,
  resolveProductsWithStorkPrices,
} from './deployment-config';
import {
  ArtifactRuntimeEvidence,
  assertFreshOpenZeppelinManifestAbsent,
  collectContractCreationEvidence,
  inspectProxyDeployment,
  normalizeVerifierPublicKeys,
  ReleaseArtifactKey,
  ReleaseBuildEvidence,
  sha256File,
  verifyActiveClearinghouseLiq,
  verifyLiveMarketConfiguration,
  verifyProxyDeployment,
  verifyProxyAdminOwner,
  verifyRuntimeArtifact,
  verifyVerifierQuorumConfiguration,
  verifyVirtualBookProductId,
} from './release-evidence';
import {
  assertDeploymentIntentAvailableForFirstTransaction,
  TRACKED_GALILEO_RELEASE_POLICY,
} from './release-attestation';
import {
  assertSameVerifiedRedTestnetReleaseEvidence,
  collectAndVerifyRedTestnetReleaseEvidence,
  TRACKED_RED_GALILEO_APPROVAL,
  VerifiedRedTestnetReleaseEvidence,
} from './red-testnet-approval';
import { collectContractInterfaceDiff } from './contract-interface-diff';
import {
  assertStorkObservationBlock,
  assertStorkDeploymentSnapshotFresh,
  BACKEND_BETA_COMMIT,
  collectGalileoStorkReleasePreflight,
  GalileoStorkReleasePreflight,
  storkPricesByProductId,
  storkSnapshotSha256,
  TRACKED_COLLATERAL_PROVENANCE,
  TRACKED_STORK_DEPLOYMENT_POLICY,
  validateStorkDeploymentSnapshot,
} from './stork-deployment-snapshot';

const AUDITED_BASE_COMMIT = '6d5df597afe4eb16c6131a85f45322e0954b9e94';
const reverifyStorkBeforePriceWrite = (preflight: GalileoStorkReleasePreflight): void => {
  const verified = validateStorkDeploymentSnapshot(preflight.snapshot, preflight.policy, preflight.policySha256);
  if (storkSnapshotSha256(verified) !== preflight.snapshotSha256) {
    throw new Error('signed Stork snapshot changed before a contract price write');
  }
  assertStorkDeploymentSnapshotFresh(verified, preflight.policy);
};
const requiredAddress = (value: string | undefined, field: string): string => {
  if (!value || !utils.isAddress(value)) throw new Error(`${field} must be an address`);
  const address = utils.getAddress(value);
  if (address === ethers.constants.AddressZero) throw new Error(`${field} must not be the zero address`);
  return address;
};

const receipt = async (transaction: ContractTransaction): Promise<ContractReceipt> => transaction.wait();

const deploymentBlock = async (contract: Contract): Promise<number> =>
  (await contract.deployTransaction.wait()).blockNumber;

async function deployProxyShell(name: string, unsafeAllow: 'delegatecall'[] = []): Promise<Contract> {
  const factory = await ethers.getContractFactory(name);
  const proxy = await upgrades.deployProxy(factory, [], {
    initializer: false,
    kind: 'transparent',
    unsafeAllow,
    useDeployedImplementation: false,
  });
  await proxy.deployed();
  return proxy;
}

function manifestTransactionHash(deployment: { txHash?: string } | undefined, label: string): string {
  if (!deployment?.txHash || !utils.isHexString(deployment.txHash, 32)) {
    throw new Error(`fresh OpenZeppelin manifest is missing ${label} creation transaction`);
  }
  return deployment.txHash;
}

function manifestImplementation(data: ManifestData, address: string) {
  const expected = utils.getAddress(address);
  return Object.values(data.impls).find((deployment) => {
    if (!deployment) return false;
    const addresses = [deployment.address, ...(deployment.allAddresses || [])];
    return addresses.some((candidate) => utils.getAddress(candidate) === expected);
  });
}

async function proxyRecord(
  contract: Contract,
  artifactKey: ReleaseArtifactKey,
  build: ReleaseBuildEvidence,
  openZeppelinManifest: ManifestData,
  deployer: string,
  minimumNonce: number
) {
  const inspected = await inspectProxyDeployment(ethers.provider, contract.address);
  await verifyProxyDeployment(
    ethers.provider,
    inspected,
    build.artifacts[artifactKey],
    build.artifacts.transparentUpgradeableProxy,
    build.artifacts.proxyAdmin,
    artifactKey
  );
  const proxyDeployment = openZeppelinManifest.proxies.find(
    (deployment) => utils.getAddress(deployment.address) === inspected.proxy
  );
  const implementationDeployment = manifestImplementation(openZeppelinManifest, inspected.implementation);
  const adminDeployment = openZeppelinManifest.admin;
  if (!adminDeployment || utils.getAddress(adminDeployment.address) !== inspected.admin) {
    throw new Error(`${artifactKey} ProxyAdmin is not the fresh manifest admin`);
  }
  const provenance = {
    proxy: await collectContractCreationEvidence(
      ethers.provider,
      inspected.proxy,
      manifestTransactionHash(proxyDeployment, `${artifactKey} proxy`),
      deployer,
      `${artifactKey} proxy`,
      minimumNonce
    ),
    implementation: await collectContractCreationEvidence(
      ethers.provider,
      inspected.implementation,
      manifestTransactionHash(implementationDeployment, `${artifactKey} implementation`),
      deployer,
      `${artifactKey} implementation`,
      minimumNonce
    ),
    admin: await collectContractCreationEvidence(
      ethers.provider,
      inspected.admin,
      manifestTransactionHash(adminDeployment, 'ProxyAdmin'),
      deployer,
      'ProxyAdmin',
      minimumNonce
    ),
    adminOwner: await verifyProxyAdminOwner(ethers.provider, inspected.admin, deployer),
  };
  return {
    ...inspected,
    artifactKey,
    deploymentBlock: await deploymentBlock(contract),
    provenance,
  };
}

async function runtimeRecord(
  contract: Contract,
  artifactKey: ReleaseArtifactKey,
  artifact: ArtifactRuntimeEvidence,
  deployer: string,
  minimumNonce: number
) {
  const runtimeCodeHash = await verifyRuntimeArtifact(ethers.provider, contract.address, artifact, artifactKey);
  return {
    address: contract.address,
    artifactKey,
    runtimeCodeHash,
    deploymentBlock: await deploymentBlock(contract),
    creation: await collectContractCreationEvidence(
      ethers.provider,
      contract.address,
      contract.deployTransaction.hash,
      deployer,
      artifactKey,
      minimumNonce
    ),
  };
}

type ReleaseFiles = {
  productsFile: string;
  verifierFile: string;
  productReviewFile: string;
  approvalFile: string;
  deploymentIntentFile: string;
  preparedFile: string;
  manifestFile: string;
};

type TransactionBlockEvidence = {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: 1;
};

type PreparedDeployment = Record<string, any>;

function releaseFiles(): ReleaseFiles {
  return {
    productsFile: path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json'),
    verifierFile: path.resolve(
      process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
    ),
    productReviewFile: path.resolve(
      process.env.PERPDEX_PRODUCT_REVIEW_FILE || './config/galileo.product-approval-review.json'
    ),
    approvalFile: path.resolve(process.env.PERPDEX_RED_APPROVAL_FILE || TRACKED_RED_GALILEO_APPROVAL),
    deploymentIntentFile: path.resolve(
      process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || './config/galileo.deployment-intent.local.json'
    ),
    preparedFile: path.resolve(process.env.PERPDEX_PREPARED_DEPLOYMENT || './deployments/16602/prepared.local.json'),
    manifestFile: path.resolve(process.env.PERPDEX_DEPLOYMENT_MANIFEST || './deployments/16602/latest.local.json'),
  };
}

async function checkedQuote(): Promise<string> {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== GALILEO_CHAIN_ID) {
    throw new Error(`refusing deployment: expected chain ${GALILEO_CHAIN_ID}, got ${network.chainId}`);
  }
  const quote = requireGalileoUsdce(process.env.PERPDEX_QUOTE_TOKEN_ADDRESS);
  if ((await ethers.provider.getCode(quote)) === '0x') throw new Error('canonical quote token has no bytecode');
  const quoteContract = new Contract(
    quote,
    ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
    ethers.provider
  );
  if (
    (await quoteContract.decimals()) !== GALILEO_USDCE_DECIMALS ||
    (await quoteContract.symbol()) !== GALILEO_USDCE_SYMBOL
  ) {
    throw new Error(`Galileo collateral metadata mismatch: expected ${GALILEO_USDCE_SYMBOL}/${GALILEO_USDCE_DECIMALS}`);
  }
  return quote;
}

function transactionBlockEvidence(value: ContractReceipt, label: string): TransactionBlockEvidence {
  if (value.status !== 1 || !utils.isHexString(value.transactionHash, 32) || !utils.isHexString(value.blockHash, 32)) {
    throw new Error(`${label} receipt is missing successful immutable block evidence`);
  }
  return {
    transactionHash: value.transactionHash,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    status: 1,
  };
}

function redEvidenceInput(files: ReleaseFiles) {
  return {
    artifacts,
    productsFile: files.productsFile,
    productReviewFile: files.productReviewFile,
    verifierFile: files.verifierFile,
    approvalFile: files.approvalFile,
    deploymentIntentFile: files.deploymentIntentFile,
  };
}

function writeExclusiveJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function prepareDeployment(files: ReleaseFiles): Promise<void> {
  // Static approval/provenance is verified before the first preparation transaction.
  const preflight = await collectAndVerifyRedTestnetReleaseEvidence(redEvidenceInput(files));
  const quote = await checkedQuote();
  const contractDiff = await collectContractInterfaceDiff();
  const [deployer] = await ethers.getSigners();
  const sequencer = requiredAddress(
    process.env.PERPDEX_SEQUENCER_ADDRESS || deployer.address,
    'PERPDEX_SEQUENCER_ADDRESS'
  );
  const openZeppelinManifest = await Manifest.forNetwork(hardhatNetwork.provider);
  assertFreshOpenZeppelinManifestAbsent(path.resolve(__dirname, '..'), GALILEO_CHAIN_ID, openZeppelinManifest.file);
  const latestBlock = await ethers.provider.getBlock('latest');
  if (!latestBlock) throw new Error('latest Galileo block is unavailable');
  assertDeploymentIntentAvailableForFirstTransaction(preflight.deploymentIntent, {
    deployer: deployer.address,
    sequencer,
    pendingNonce: await deployer.getTransactionCount('pending'),
    chainTimestamp: latestBlock.timestamp,
    expectedFirstContractCode: await ethers.provider.getCode(preflight.deploymentIntent.expectedFirstContract),
  });

  const Sanctions = await ethers.getContractFactory('MockSanctionsList');
  const sanctions = await Sanctions.deploy({ nonce: preflight.deploymentIntent.firstTransactionNonce });
  if (sanctions.address !== preflight.deploymentIntent.expectedFirstContract) {
    throw new Error('first preparation transaction does not match the approved deployment intent');
  }
  await sanctions.deployed();
  const Liq = await ethers.getContractFactory('ClearinghouseLiq');
  const clearinghouseLiq = await Liq.deploy();
  await clearinghouseLiq.deployed();
  const verifier = await deployProxyShell('Verifier');
  const endpoint = await deployProxyShell('Endpoint');
  const clearinghouse = await deployProxyShell('Clearinghouse', ['delegatecall']);
  const spotEngine = await deployProxyShell('SpotEngine');
  const perpEngine = await deployProxyShell('PerpEngine');
  const offchainExchange = await deployProxyShell('OffchainExchange');
  const paddedVerifierPoints = normalizeVerifierPublicKeys([
    ...preflight.verifierConfig.keys,
    ...Array.from({ length: 5 }, () => ({ x: 0, y: 0 })),
  ]);
  await receipt(await verifier.initialize(paddedVerifierPoints));
  await receipt(
    await clearinghouse.initialize(endpoint.address, quote, clearinghouseLiq.address, preflight.products.spreads)
  );
  await receipt(await clearinghouse.addEngine(spotEngine.address, offchainExchange.address, 0));
  await receipt(await clearinghouse.addEngine(perpEngine.address, offchainExchange.address, 1));
  await receipt(await offchainExchange.initialize(clearinghouse.address, endpoint.address));
  await verifyVerifierQuorumConfiguration(
    verifier,
    paddedVerifierPoints,
    preflight.verifierConfig.keys.length,
    preflight.verifierConfig.signerBitmask
  );

  const VirtualBook = await ethers.getContractFactory('VirtualBook');
  const preparedMarkets: Record<string, unknown> = {};
  for (const product of preflight.products.products) {
    const virtualBook = await VirtualBook.deploy(product.productId);
    await virtualBook.deployed();
    await verifyVirtualBookProductId(
      ethers.provider,
      virtualBook.address,
      product.productId,
      `${product.symbol} virtual book`
    );
    preparedMarkets[product.symbol] = {
      productId: product.productId,
      virtualBook: virtualBook.address,
      artifactKey: 'virtualBook',
      runtimeCodeHash: await verifyRuntimeArtifact(
        ethers.provider,
        virtualBook.address,
        preflight.build.artifacts.virtualBook,
        `${product.symbol} virtual book`
      ),
      virtualBookDeploymentBlock: await deploymentBlock(virtualBook),
      creation: await collectContractCreationEvidence(
        ethers.provider,
        virtualBook.address,
        virtualBook.deployTransaction.hash,
        deployer.address,
        `${product.symbol} virtual book`,
        preflight.deploymentIntent.firstTransactionNonce
      ),
      sizeIncrementX18: product.sizeIncrementX18,
      minSizeX18: product.minSizeX18,
      lpSpreadX18: product.lpSpreadX18,
      riskWeights: product.risk,
    };
  }
  if (
    (await endpoint.owner()) !== ethers.constants.AddressZero ||
    (await endpoint.getSequencer()) !== ethers.constants.AddressZero
  ) {
    throw new Error('prepare phase must leave Endpoint uninitialized');
  }
  if ((await perpEngine['getProductIds()']()).length !== 0) {
    throw new Error('prepare phase must not write any perp product price');
  }

  const finalOpenZeppelinManifest = await Manifest.forNetwork(hardhatNetwork.provider);
  if (finalOpenZeppelinManifest.file !== openZeppelinManifest.file) {
    throw new Error('OpenZeppelin network manifest path changed during preparation');
  }
  const openZeppelinManifestData = await finalOpenZeppelinManifest.read();
  if (openZeppelinManifestData.proxies.length !== 6 || !openZeppelinManifestData.admin) {
    throw new Error('prepared graph must contain exactly six proxies and one admin');
  }
  const openZeppelinManifestPath = path.resolve(__dirname, '..', finalOpenZeppelinManifest.file);
  const contracts = {
    sanctions: await runtimeRecord(
      sanctions,
      'sanctions',
      preflight.build.artifacts.sanctions,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
    clearinghouseLiq: await runtimeRecord(
      clearinghouseLiq,
      'clearinghouseLiq',
      preflight.build.artifacts.clearinghouseLiq,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
    verifier: {
      ...(await proxyRecord(
        verifier,
        'verifier',
        preflight.build,
        openZeppelinManifestData,
        deployer.address,
        preflight.deploymentIntent.firstTransactionNonce
      )),
      publicKeys: paddedVerifierPoints,
      signerCount: preflight.verifierConfig.keys.length,
      signerBitmask: preflight.verifierConfig.signerBitmask,
    },
    endpoint: await proxyRecord(
      endpoint,
      'endpoint',
      preflight.build,
      openZeppelinManifestData,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
    clearinghouse: await proxyRecord(
      clearinghouse,
      'clearinghouse',
      preflight.build,
      openZeppelinManifestData,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
    spotEngine: await proxyRecord(
      spotEngine,
      'spotEngine',
      preflight.build,
      openZeppelinManifestData,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
    perpEngine: await proxyRecord(
      perpEngine,
      'perpEngine',
      preflight.build,
      openZeppelinManifestData,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
    offchainExchange: await proxyRecord(
      offchainExchange,
      'offchainExchange',
      preflight.build,
      openZeppelinManifestData,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    ),
  };
  await verifyActiveClearinghouseLiq(
    ethers.provider,
    clearinghouse,
    contracts.clearinghouseLiq,
    preflight.build.artifacts.clearinghouseLiq
  );

  const postflight = await collectAndVerifyRedTestnetReleaseEvidence(redEvidenceInput(files));
  assertSameVerifiedRedTestnetReleaseEvidence(preflight, postflight);
  const prepared = {
    schemaVersion: 1,
    phase: 'prepared_no_price_writes',
    release: GALILEO_RELEASE_ID,
    deploymentIntent: postflight.deploymentIntent,
    source: {
      reviewedReleaseCommit: postflight.source.releaseCommit,
      reviewedSourceTree: postflight.source.sourceTree,
      buildEvidenceSha256: postflight.buildEvidenceSha256,
      productConfigSha256: postflight.productConfigSha256,
      productReviewSha256: postflight.productReviewSha256,
      verifierPublicKeysSha256: postflight.verifierConfigSha256,
      redApprovalSha256: postflight.approvalSha256,
      redApprovalDigest: postflight.approvalDigest,
      storkPolicySha256: postflight.staticPolicy.policySha256,
      collateralProvenanceSha256: postflight.staticPolicy.collateralProvenanceSha256,
      contractInterfaceDiff: contractDiff,
    },
    openZeppelin: {
      startedWithoutNetworkManifest: true,
      manifestFile: finalOpenZeppelinManifest.file,
      manifestSha256: sha256File(openZeppelinManifestPath),
    },
    network: { name: '0G Galileo Testnet', chainId: GALILEO_CHAIN_ID },
    deployer: deployer.address,
    sequencer,
    quoteToken: quote,
    collateralProvenance: postflight.staticPolicy.collateralProvenance,
    contracts,
    markets: preparedMarkets,
    gates: {
      endpointUninitialized: true,
      perpProductsAbsent: true,
      staticPricesAbsent: true,
      freshSnapshotNotYetLoaded: true,
      incumbentMutationOrDeletion: false,
    },
  };
  writeExclusiveJson(files.preparedFile, prepared);
  console.log(`Prepared non-price-bearing Galileo graph at ${files.preparedFile}.`);
  console.log('Capture a fresh signed Stork snapshot, then run the explicit finalize phase.');
}

function assertPreparedBinding(prepared: PreparedDeployment, preflight: VerifiedRedTestnetReleaseEvidence): void {
  if (
    prepared.schemaVersion !== 1 ||
    prepared.phase !== 'prepared_no_price_writes' ||
    prepared.release !== GALILEO_RELEASE_ID ||
    prepared.network?.chainId !== GALILEO_CHAIN_ID ||
    prepared.quoteToken !== GALILEO_USDCE_ADDRESS ||
    prepared.source?.reviewedReleaseCommit !== preflight.source.releaseCommit ||
    prepared.source?.reviewedSourceTree !== preflight.source.sourceTree ||
    prepared.source?.buildEvidenceSha256 !== preflight.buildEvidenceSha256 ||
    prepared.source?.productConfigSha256 !== preflight.productConfigSha256 ||
    prepared.source?.productReviewSha256 !== preflight.productReviewSha256 ||
    prepared.source?.verifierPublicKeysSha256 !== preflight.verifierConfigSha256 ||
    prepared.source?.redApprovalSha256 !== preflight.approvalSha256 ||
    prepared.source?.redApprovalDigest !== preflight.approvalDigest ||
    prepared.source?.storkPolicySha256 !== preflight.staticPolicy.policySha256 ||
    prepared.source?.collateralProvenanceSha256 !== preflight.staticPolicy.collateralProvenanceSha256 ||
    prepared.deploymentIntent?.deploymentId !== preflight.deploymentIntent.deploymentId ||
    JSON.stringify(prepared.collateralProvenance) !== JSON.stringify(preflight.staticPolicy.collateralProvenance) ||
    prepared.gates?.endpointUninitialized !== true ||
    prepared.gates?.perpProductsAbsent !== true ||
    prepared.gates?.staticPricesAbsent !== true
  ) {
    throw new Error('prepared Galileo graph does not match the approved static release evidence');
  }
}

async function finalizeDeployment(files: ReleaseFiles): Promise<void> {
  const preflight = await collectAndVerifyRedTestnetReleaseEvidence(redEvidenceInput(files));
  const prepared = JSON.parse(fs.readFileSync(files.preparedFile, 'utf8')) as PreparedDeployment;
  assertPreparedBinding(prepared, preflight);
  const quote = await checkedQuote();
  const [deployer] = await ethers.getSigners();
  if (
    deployer.address !== prepared.deployer ||
    requiredAddress(process.env.PERPDEX_SEQUENCER_ADDRESS || deployer.address, 'PERPDEX_SEQUENCER_ADDRESS') !==
      prepared.sequencer
  ) {
    throw new Error('finalize signer/sequencer does not match the prepared graph');
  }
  const latestContractDiff = await collectContractInterfaceDiff();
  if (latestContractDiff.sha256 !== prepared.source.contractInterfaceDiff.sha256) {
    throw new Error('contract interface diff changed after graph preparation');
  }
  const openZeppelinManifestPath = path.resolve(__dirname, '..', prepared.openZeppelin.manifestFile);
  if (sha256File(openZeppelinManifestPath) !== prepared.openZeppelin.manifestSha256) {
    throw new Error('OpenZeppelin manifest changed after graph preparation');
  }

  const verifier = await ethers.getContractAt('Verifier', prepared.contracts.verifier.proxy);
  const endpoint = await ethers.getContractAt('Endpoint', prepared.contracts.endpoint.proxy);
  const clearinghouse = await ethers.getContractAt('Clearinghouse', prepared.contracts.clearinghouse.proxy);
  const spotEngine = await ethers.getContractAt('SpotEngine', prepared.contracts.spotEngine.proxy);
  const perpEngine = await ethers.getContractAt('PerpEngine', prepared.contracts.perpEngine.proxy);
  const offchainExchange = await ethers.getContractAt('OffchainExchange', prepared.contracts.offchainExchange.proxy);
  for (const key of [
    'verifier',
    'endpoint',
    'clearinghouse',
    'spotEngine',
    'perpEngine',
    'offchainExchange',
  ] as const) {
    const record = prepared.contracts[key];
    await verifyProxyDeployment(
      ethers.provider,
      record,
      preflight.build.artifacts[key],
      preflight.build.artifacts.transparentUpgradeableProxy,
      preflight.build.artifacts.proxyAdmin,
      `prepared ${key}`
    );
    if (
      (await verifyProxyAdminOwner(ethers.provider, record.admin, prepared.deployer)) !== record.provenance.adminOwner
    ) {
      throw new Error(`prepared ${key} ProxyAdmin owner drift`);
    }
  }
  await verifyRuntimeArtifact(
    ethers.provider,
    prepared.contracts.sanctions.address,
    preflight.build.artifacts.sanctions,
    'prepared sanctions',
    prepared.contracts.sanctions.runtimeCodeHash
  );
  await verifyRuntimeArtifact(
    ethers.provider,
    prepared.contracts.clearinghouseLiq.address,
    preflight.build.artifacts.clearinghouseLiq,
    'prepared ClearinghouseLiq',
    prepared.contracts.clearinghouseLiq.runtimeCodeHash
  );
  await verifyVerifierQuorumConfiguration(
    verifier,
    prepared.contracts.verifier.publicKeys,
    prepared.contracts.verifier.signerCount,
    prepared.contracts.verifier.signerBitmask
  );
  if (
    (await endpoint.owner()) !== ethers.constants.AddressZero ||
    (await endpoint.getSequencer()) !== ethers.constants.AddressZero ||
    (await perpEngine['getProductIds()']()).length !== 0
  ) {
    throw new Error('prepared graph was already finalized or received an unreviewed price write');
  }
  for (const market of Object.values(prepared.markets) as any[]) {
    await verifyVirtualBookProductId(
      ethers.provider,
      market.virtualBook,
      market.productId,
      `prepared product ${market.productId}`
    );
    await verifyRuntimeArtifact(
      ethers.provider,
      market.virtualBook,
      preflight.build.artifacts.virtualBook,
      `prepared product ${market.productId}`,
      market.runtimeCodeHash
    );
    if ((await offchainExchange.getVirtualBook(market.productId)) !== ethers.constants.AddressZero) {
      throw new Error(`prepared product ${market.productId} was already registered`);
    }
  }

  // Last possible boundary: all graph/provider verification is complete. The
  // live snapshot is loaded only now and is reverified before every broadcast.
  const nextNonce = await deployer.getTransactionCount('pending');
  const storkPreflight = collectGalileoStorkReleasePreflight({ snapshotFile: process.env.PERPDEX_STORK_SNAPSHOT_FILE });
  if (
    storkPreflight.policySha256 !== preflight.staticPolicy.policySha256 ||
    storkPreflight.collateralProvenanceSha256 !== preflight.staticPolicy.collateralProvenanceSha256
  ) {
    throw new Error('fresh Stork snapshot does not match the statically approved policy/provenance');
  }
  const observationBlock = await ethers.provider.getBlock(storkPreflight.snapshot.observationBlock.number);
  if (!observationBlock) throw new Error('signed Stork observation block is unavailable');
  assertStorkObservationBlock(storkPreflight.snapshot, observationBlock);
  const products = resolveProductsWithStorkPrices(preflight.products, storkPricesByProductId(storkPreflight.snapshot));

  let nonce = nextNonce;
  reverifyStorkBeforePriceWrite(storkPreflight);
  const endpointInitializeTx = await endpoint.initialize(
    prepared.contracts.sanctions.address,
    prepared.sequencer,
    prepared.contracts.offchainExchange.proxy,
    prepared.contracts.clearinghouse.proxy,
    prepared.contracts.verifier.proxy,
    initialPrices(products.products),
    { nonce: nonce++ }
  );
  const productTransactions: Array<{ symbol: string; productId: number; transaction: ContractTransaction }> = [];
  for (const product of products.products) {
    reverifyStorkBeforePriceWrite(storkPreflight);
    const preparedMarket = prepared.markets[product.symbol];
    const transaction = await perpEngine.addProduct(
      product.productId,
      preparedMarket.virtualBook,
      product.sizeIncrementX18,
      product.minSizeX18,
      product.lpSpreadX18,
      { ...product.risk },
      { nonce: nonce++ }
    );
    productTransactions.push({ symbol: product.symbol, productId: product.productId, transaction });
  }
  const endpointInitializeEvidence = transactionBlockEvidence(await endpointInitializeTx.wait(), 'Endpoint.initialize');
  const productPriceWriteEvidence = new Map<string, TransactionBlockEvidence>();
  for (const pending of productTransactions) {
    productPriceWriteEvidence.set(
      pending.symbol,
      transactionBlockEvidence(await pending.transaction.wait(), `${pending.symbol} addProduct`)
    );
  }
  if (!BigNumber.from(await clearinghouse.getReleaseMode()).isZero()) {
    throw new Error('fresh Galileo deployment must start in ACTIVE release mode');
  }
  await verifyLiveMarketConfiguration({ clearinghouse, spotEngine, perpEngine, offchainExchange }, products, quote);
  if ((await endpoint.getSequencer()) !== prepared.sequencer) throw new Error('sequencer finalization mismatch');
  const markets = Object.fromEntries(
    products.products.map((product) => [
      product.symbol,
      {
        ...prepared.markets[product.symbol],
        risk: product.risk,
        priceWrite: productPriceWriteEvidence.get(product.symbol),
      },
    ])
  );

  const postflight = await collectAndVerifyRedTestnetReleaseEvidence(redEvidenceInput(files));
  assertSameVerifiedRedTestnetReleaseEvidence(preflight, postflight);
  const manifest = {
    schemaVersion: 8,
    release: GALILEO_RELEASE_ID,
    deploymentIntent: postflight.deploymentIntent,
    preparation: {
      schemaVersion: prepared.schemaVersion,
      phase: prepared.phase,
      preparedFileSha256: sha256File(files.preparedFile),
      noPriceWritesAtPreparation: true,
    },
    openZeppelin: prepared.openZeppelin,
    source: {
      auditedBaseCommit: AUDITED_BASE_COMMIT,
      reviewedReleaseCommit: postflight.source.releaseCommit,
      reviewedSourceTree: postflight.source.sourceTree,
      compiler: postflight.build.compiler,
      buildInfos: postflight.build.buildInfos,
      artifacts: postflight.build.artifacts,
      buildEvidenceSha256: postflight.buildEvidenceSha256,
      artifactRuntimeHashes: Object.fromEntries(
        Object.entries(postflight.build.artifacts).map(([key, artifact]) => [key, artifact.runtimeCodeHash])
      ),
      productConfigSha256: postflight.productConfigSha256,
      productReviewSha256: postflight.productReviewSha256,
      backendBetaCommit: BACKEND_BETA_COMMIT,
      storkPolicySha256: storkPreflight.policySha256,
      storkSnapshotSha256: storkPreflight.snapshotSha256,
      collateralProvenanceSha256: storkPreflight.collateralProvenanceSha256,
      verifierPublicKeysSha256: postflight.verifierConfigSha256,
      redTestnetApproval: {
        policyFile: TRACKED_GALILEO_RELEASE_POLICY,
        policyId: postflight.policy.policyId,
        policyVersion: postflight.policy.policyVersion,
        policySha256: postflight.policySha256,
        approvalFile: TRACKED_RED_GALILEO_APPROVAL,
        approvalSha256: postflight.approvalSha256,
        digest: postflight.approvalDigest,
        approval: postflight.approval,
      },
      explicitDeltas: [
        'restore omitted Version.sol implementation',
        'enforce OffchainExchange order signatures',
        'pin product zero to existing Galileo USDC.e',
        'initialize every launch price from one fresh signed Stork snapshot',
      ],
      contractInterfaceDiff: latestContractDiff,
    },
    network: prepared.network,
    deployer: prepared.deployer,
    sequencer: prepared.sequencer,
    sequencerUsesDeployer: prepared.sequencer === prepared.deployer,
    roles: {
      deployer: prepared.deployer,
      sequencer: prepared.sequencer,
      releaseApprover: { name: 'Red', role: 'product_and_release_owner', mode: 'tracked_galileo_testnet_artifact' },
      mainnetExternalReviewRequired: true,
      contractOwner: prepared.deployer,
      proxyAdminOwner: prepared.deployer,
      verifierKeys: {
        count: prepared.contracts.verifier.signerCount,
        signerBitmask: prepared.contracts.verifier.signerBitmask,
        privateMaterialRecorded: false,
      },
    },
    quoteToken: quote,
    collateral: {
      address: GALILEO_USDCE_ADDRESS,
      symbol: GALILEO_USDCE_SYMBOL,
      decimals: GALILEO_USDCE_DECIMALS,
      productId: 0,
      source: 'existing',
      deployToken: false,
      selectionMode: 'static_pinned',
      runtimeRegistryLookup: false,
      provenanceOnly: true,
      provenanceFile: TRACKED_COLLATERAL_PROVENANCE,
      provenanceSha256: storkPreflight.collateralProvenanceSha256,
      provenance: storkPreflight.collateralProvenance,
    },
    oracle: {
      provider: 'stork',
      backendBetaCommit: BACKEND_BETA_COMMIT,
      policyFile: TRACKED_STORK_DEPLOYMENT_POLICY,
      policySha256: storkPreflight.policySha256,
      snapshotTracked: false,
      snapshotSha256: storkPreflight.snapshotSha256,
      snapshot: storkPreflight.snapshot,
      observationBlock: storkPreflight.snapshot.observationBlock,
      signedTimestampSpreadNs: storkPreflight.snapshot.signedTimestampSpreadNs,
      endpointInitialize: endpointInitializeEvidence,
      prices: Object.fromEntries(
        storkPreflight.snapshot.feeds.map((feed) => [
          feed.symbol,
          {
            productId: feed.productId,
            feedId: feed.feedId,
            priceX18: feed.priceX18,
            signedTimestampNs: feed.signedTimestampNs,
            messageHash: feed.proof.messageHash,
            priceWrite: productPriceWriteEvidence.get(feed.symbol),
          },
        ])
      ),
    },
    contracts: prepared.contracts,
    markets,
    releaseControls: {
      initialMode: 0,
      modes: { ACTIVE: 0, CLOSE_ONLY: 1, WITHDRAWALS_ONLY: 2 },
      implementationMonotonic: true,
      proxyAdminCanReplaceImplementation: true,
      proxyAdminUpgradeAllowedByGate1Procedure: false,
      depositsDisabledOutsideActive: true,
      unflaggedOrdersDisabledOutsideActive: true,
      oversizedReduceOnlyOrdersClippedBeforeFill: true,
      withdrawalEntryPointsEnabledInAllModes: true,
      withdrawalsOnlyRequiresPriorCloseOnly: true,
      withdrawalsOnlyRequiresZeroEnumerableLiabilities: true,
    },
    withdrawalContract: {
      collateralProductId: 0,
      token: GALILEO_USDCE_ADDRESS,
      tokenDecimals: GALILEO_USDCE_DECIMALS,
      directRequestedAmountUnits: 'USDC.e base units',
      directLedgerFeeX18: '1000000000000000000',
      slowRequestedAmountUnits: 'USDC.e base units',
      slowWalletQueueFeeUnits: '1000000',
      slowTimeoutSeconds: 259200,
      successEvent: 'WithdrawalSettled(bytes32,uint32,address,address,uint128,int128)',
      failureEvent: 'SlowModeTransactionFailed(uint64)',
      cancellationSupported: false,
      localTimeTravelIsLive72HourEvidence: false,
    },
    explorerVerification: {
      explorer: 'https://chainscan-galileo.0g.ai',
      status: 'pending_after_deployment',
      requiredBeforeRelease: true,
      verifyProxyImplementationAndAdmin: true,
    },
    rollbackAndAbandonment: {
      beforeAnyDeposit: 'Do not publish the registry; retain both phase records and abandon the parallel graph.',
      afterAnyDeposit:
        'Remain in CLOSE_ONLY until all liabilities are zero; move to WITHDRAWALS_ONLY, reconcile every same-token exit, then remove the graph from the registry.',
      proxyUpgradeAsRollback: false,
      incumbentMutationOrDeletion: false,
    },
    gates: {
      signedBatchAbiOnly: true,
      orderSignaturesEnforced: true,
      updatePerpBalanceAbsent: true,
      slowModeExitPreserved: true,
      productRiskConfigApproved: true,
      trackedRedTestnetApprovalVerifiedPreAndPost: true,
      deterministicCiAndIndependentAgentReviewBound: true,
      mainnetExternalReviewWaived: false,
      signedDeploymentIntentSingleUseNonce: true,
      freshOpenZeppelinNetworkManifest: true,
      implementationAndAdminCreationProvenance: true,
      proxyAdminOwnerVerified: true,
      deterministicApplicationSolc013Reproduction: true,
      exactVerifierSignerCountAndBitmask: true,
      exactLiveMarketConfiguration: true,
      exactGalileoUsdcePinned: quote === GALILEO_USDCE_ADDRESS,
      staticCollateralProvenanceBound: true,
      twoPhasePrepareFinalize: true,
      staticApprovalBeforeFirstPreparationTransaction: true,
      signedStorkSnapshotVerifiedImmediatelyBeforeEachPriceBroadcast: true,
      endpointAndPerMarketPriceWriteBlocksRecorded: true,
      staticDeployTimePricesAbsent: true,
      collateralTokenDeploymentAbsent: true,
      reviewedContractDiffBound: true,
      releaseModeStartsActive: true,
      withdrawalSuccessEventAvailable: true,
      explorerVerificationComplete: false,
    },
  };
  writeExclusiveJson(files.manifestFile, manifest);
  console.log(`Galileo deployment manifest written to ${files.manifestFile}`);
  console.log('No private keys, Stork credentials, or secret values were printed.');
}

async function main(): Promise<void> {
  const phase = process.env.PERPDEX_DEPLOY_PHASE;
  const files = releaseFiles();
  if (phase === 'prepare') return prepareDeployment(files);
  if (phase === 'finalize') return finalizeDeployment(files);
  throw new Error('PERPDEX_DEPLOY_PHASE must be exactly prepare or finalize; one-shot deployment is disabled');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
