import fs from 'fs';
import path from 'path';
import { artifacts, ethers, upgrades } from 'hardhat';
import { Contract, ContractReceipt, utils } from 'ethers';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  initialPrices,
  loadProducts,
  loadVerifierConfig,
  requireGalileoUsdce,
} from './deployment-config';
import {
  ArtifactRuntimeEvidence,
  collectReleaseBuildEvidence,
  inspectProxyDeployment,
  loadReviewedSourceEvidence,
  normalizeVerifierPublicKeys,
  ReleaseArtifactKey,
  ReleaseBuildEvidence,
  releaseBuildEvidenceSha256,
  repositoryRoot,
  requireReviewedSha256,
  verifyActiveClearinghouseLiq,
  verifyConfigFileSha256,
  verifyLiveMarketConfiguration,
  verifyProxyDeployment,
  verifyRuntimeArtifact,
  verifyVerifierQuorumConfiguration,
  verifyVirtualBookProductId,
} from './release-evidence';

const AUDITED_BASE_COMMIT = '6d5df597afe4eb16c6131a85f45322e0954b9e94';
const requiredAddress = (value: string | undefined, field: string): string => {
  if (!value || !utils.isAddress(value)) throw new Error(`${field} must be an address`);
  return utils.getAddress(value);
};

const receipt = async (transaction: any): Promise<ContractReceipt> => transaction.wait();

const deploymentBlock = async (contract: Contract): Promise<number> =>
  (await contract.deployTransaction.wait()).blockNumber;

async function deployProxyShell(name: string, unsafeAllow: 'delegatecall'[] = []): Promise<Contract> {
  const factory = await ethers.getContractFactory(name);
  const proxy = await upgrades.deployProxy(factory, [], {
    initializer: false,
    kind: 'transparent',
    unsafeAllow,
  });
  await proxy.deployed();
  return proxy;
}

async function proxyRecord(contract: Contract, artifactKey: ReleaseArtifactKey, build: ReleaseBuildEvidence) {
  const inspected = await inspectProxyDeployment(ethers.provider, contract.address);
  await verifyProxyDeployment(
    ethers.provider,
    inspected,
    build.artifacts[artifactKey],
    build.artifacts.transparentUpgradeableProxy,
    build.artifacts.proxyAdmin,
    artifactKey
  );
  return {
    ...inspected,
    artifactKey,
    deploymentBlock: await deploymentBlock(contract),
  };
}

async function runtimeRecord(contract: Contract, artifactKey: ReleaseArtifactKey, artifact: ArtifactRuntimeEvidence) {
  const runtimeCodeHash = await verifyRuntimeArtifact(ethers.provider, contract.address, artifact, artifactKey);
  return {
    address: contract.address,
    artifactKey,
    runtimeCodeHash,
    deploymentBlock: await deploymentBlock(contract),
  };
}

async function main() {
  const reviewedSource = loadReviewedSourceEvidence(
    repositoryRoot(),
    process.env.PERPDEX_REVIEWED_RELEASE_COMMIT,
    process.env.PERPDEX_REVIEWED_SOURCE_TREE
  );
  const reviewedBuild = await collectReleaseBuildEvidence(artifacts);
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  const manifestFile = path.resolve(process.env.PERPDEX_DEPLOYMENT_MANIFEST || './deployments/16602/latest.local.json');

  const expectedBuildEvidenceSha256 = requireReviewedSha256(
    process.env.PERPDEX_REVIEWED_BUILD_EVIDENCE_SHA256,
    'PERPDEX_REVIEWED_BUILD_EVIDENCE_SHA256'
  );
  const expectedProductConfigSha256 = requireReviewedSha256(
    process.env.PERPDEX_REVIEWED_PRODUCT_CONFIG_SHA256,
    'PERPDEX_REVIEWED_PRODUCT_CONFIG_SHA256'
  );
  const expectedVerifierConfigSha256 = requireReviewedSha256(
    process.env.PERPDEX_REVIEWED_VERIFIER_PUBLIC_KEYS_SHA256,
    'PERPDEX_REVIEWED_VERIFIER_PUBLIC_KEYS_SHA256'
  );
  const actualBuildEvidenceSha256 = releaseBuildEvidenceSha256(reviewedBuild);
  if (actualBuildEvidenceSha256 !== expectedBuildEvidenceSha256) {
    throw new Error(
      `reviewed build evidence SHA-256 mismatch: expected ${expectedBuildEvidenceSha256}, got ${actualBuildEvidenceSha256}`
    );
  }
  const productConfigSha256 = verifyConfigFileSha256(productsFile, expectedProductConfigSha256, 'product config');
  const verifierPublicKeysSha256 = verifyConfigFileSha256(
    verifierFile,
    expectedVerifierConfigSha256,
    'verifier public-key config'
  );
  const products = loadProducts(productsFile);
  const verifierConfig = loadVerifierConfig(verifierFile);
  const verifierPoints = verifierConfig.keys;

  // All reviewer-pinned local evidence is checked above before any signer is loaded or transaction is sent.
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== GALILEO_CHAIN_ID) {
    throw new Error(`refusing deployment: expected chain ${GALILEO_CHAIN_ID}, got ${network.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const sequencer = requiredAddress(
    process.env.PERPDEX_SEQUENCER_ADDRESS || deployer.address,
    'PERPDEX_SEQUENCER_ADDRESS'
  );
  const quote = requireGalileoUsdce(process.env.PERPDEX_QUOTE_TOKEN_ADDRESS);
  const quoteCode = await ethers.provider.getCode(quote);
  if (quoteCode === '0x') throw new Error('canonical quote token has no bytecode');
  const quoteContract = new Contract(
    quote,
    ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
    ethers.provider
  );
  const quoteDecimals = await quoteContract.decimals();
  const quoteSymbol = await quoteContract.symbol();
  if (quoteDecimals !== GALILEO_USDCE_DECIMALS || quoteSymbol !== GALILEO_USDCE_SYMBOL) {
    throw new Error(`Galileo collateral metadata mismatch: expected ${GALILEO_USDCE_SYMBOL}/${GALILEO_USDCE_DECIMALS}`);
  }

  // Fresh proxies only. This script never upgrades or adopts the old Fable set.
  const Sanctions = await ethers.getContractFactory('MockSanctionsList');
  const sanctions = await Sanctions.deploy();
  await sanctions.deployed();
  const Liq = await ethers.getContractFactory('ClearinghouseLiq');
  const clearinghouseLiq = await Liq.deploy();
  await clearinghouseLiq.deployed();

  const verifier = await deployProxyShell('Verifier');
  const endpoint = await deployProxyShell('Endpoint');
  // The audited liquidation path intentionally delegates to ClearinghouseLiq.
  const clearinghouse = await deployProxyShell('Clearinghouse', ['delegatecall']);
  const spotEngine = await deployProxyShell('SpotEngine');
  const perpEngine = await deployProxyShell('PerpEngine');
  const offchainExchange = await deployProxyShell('OffchainExchange');

  const paddedVerifierPoints = normalizeVerifierPublicKeys([
    ...verifierPoints,
    ...Array.from({ length: 5 }, () => ({ x: 0, y: 0 })),
  ]);
  await receipt(await verifier.initialize(paddedVerifierPoints));
  await verifyVerifierQuorumConfiguration(
    verifier,
    paddedVerifierPoints,
    verifierPoints.length,
    verifierConfig.signerBitmask
  );
  await receipt(await clearinghouse.initialize(endpoint.address, quote, clearinghouseLiq.address, products.spreads));
  await receipt(await clearinghouse.addEngine(spotEngine.address, offchainExchange.address, 0));
  await receipt(await clearinghouse.addEngine(perpEngine.address, offchainExchange.address, 1));
  await receipt(await offchainExchange.initialize(clearinghouse.address, endpoint.address));
  await receipt(
    await endpoint.initialize(
      sanctions.address,
      sequencer,
      offchainExchange.address,
      clearinghouse.address,
      verifier.address,
      initialPrices(products.products)
    )
  );

  const VirtualBook = await ethers.getContractFactory('VirtualBook');
  const markets: Record<string, any> = {};
  for (const product of products.products) {
    const virtualBook = await VirtualBook.deploy(product.productId);
    await virtualBook.deployed();
    await verifyVirtualBookProductId(
      ethers.provider,
      virtualBook.address,
      product.productId,
      `${product.symbol} virtual book`
    );
    await receipt(
      await perpEngine.addProduct(
        product.productId,
        virtualBook.address,
        product.sizeIncrementX18,
        product.minSizeX18,
        product.lpSpreadX18,
        {
          longWeightInitial: product.risk.longWeightInitial,
          shortWeightInitial: product.risk.shortWeightInitial,
          longWeightMaintenance: product.risk.longWeightMaintenance,
          shortWeightMaintenance: product.risk.shortWeightMaintenance,
          priceX18: product.risk.priceX18,
        }
      )
    );
    const configuredBook = await offchainExchange.getVirtualBook(product.productId);
    if (configuredBook !== virtualBook.address) {
      throw new Error(`virtual-book verification failed for ${product.symbol}`);
    }
    const runtimeCodeHash = await verifyRuntimeArtifact(
      ethers.provider,
      virtualBook.address,
      reviewedBuild.artifacts.virtualBook,
      `${product.symbol} virtual book`
    );
    markets[product.symbol] = {
      productId: product.productId,
      virtualBook: virtualBook.address,
      artifactKey: 'virtualBook',
      runtimeCodeHash,
      virtualBookDeploymentBlock: await deploymentBlock(virtualBook),
      sizeIncrementX18: product.sizeIncrementX18,
      minSizeX18: product.minSizeX18,
      lpSpreadX18: product.lpSpreadX18,
      risk: product.risk,
    };
  }

  await verifyLiveMarketConfiguration({ clearinghouse, spotEngine, perpEngine, offchainExchange }, products, quote);

  if ((await endpoint.getSequencer()) !== sequencer) {
    throw new Error('sequencer post-deploy verification failed');
  }
  if ((await clearinghouse.getEngineByProduct(2)) !== perpEngine.address) {
    throw new Error('perp engine product registration verification failed');
  }
  if (
    !endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[],bytes32,bytes32)'] ||
    endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[])']
  ) {
    throw new Error('unsafe batch ABI detected');
  }

  const sanctionsRecord = await runtimeRecord(sanctions, 'sanctions', reviewedBuild.artifacts.sanctions);
  const clearinghouseLiqRecord = await runtimeRecord(
    clearinghouseLiq,
    'clearinghouseLiq',
    reviewedBuild.artifacts.clearinghouseLiq
  );
  await verifyActiveClearinghouseLiq(
    ethers.provider,
    clearinghouse,
    clearinghouseLiqRecord,
    reviewedBuild.artifacts.clearinghouseLiq
  );
  const verifierRecord = {
    ...(await proxyRecord(verifier, 'verifier', reviewedBuild)),
    publicKeys: paddedVerifierPoints,
    signerCount: verifierPoints.length,
    signerBitmask: verifierConfig.signerBitmask,
  };
  const endpointRecord = await proxyRecord(endpoint, 'endpoint', reviewedBuild);
  const clearinghouseRecord = await proxyRecord(clearinghouse, 'clearinghouse', reviewedBuild);
  const spotEngineRecord = await proxyRecord(spotEngine, 'spotEngine', reviewedBuild);
  const perpEngineRecord = await proxyRecord(perpEngine, 'perpEngine', reviewedBuild);
  const offchainExchangeRecord = await proxyRecord(offchainExchange, 'offchainExchange', reviewedBuild);
  const postVerifyBuildSha256 = releaseBuildEvidenceSha256(await collectReleaseBuildEvidence(artifacts));
  if (postVerifyBuildSha256 !== expectedBuildEvidenceSha256) {
    throw new Error(
      `post-deploy build evidence SHA-256 mismatch: expected ${expectedBuildEvidenceSha256}, got ${postVerifyBuildSha256}`
    );
  }
  verifyConfigFileSha256(productsFile, expectedProductConfigSha256, 'post-deploy product config');
  verifyConfigFileSha256(verifierFile, expectedVerifierConfigSha256, 'post-deploy verifier public-key config');

  const manifest = {
    schemaVersion: 3,
    release: 'bond-perpdex-galileo-audited-base',
    source: {
      auditedBaseCommit: AUDITED_BASE_COMMIT,
      reviewedReleaseCommit: reviewedSource.releaseCommit,
      reviewedSourceTree: reviewedSource.sourceTree,
      compiler: reviewedBuild.compiler,
      buildInfos: reviewedBuild.buildInfos,
      artifacts: reviewedBuild.artifacts,
      buildEvidenceSha256: actualBuildEvidenceSha256,
      artifactRuntimeHashes: Object.fromEntries(
        Object.entries(reviewedBuild.artifacts).map(([key, artifact]) => [key, artifact.runtimeCodeHash])
      ),
      productConfigSha256,
      verifierPublicKeysSha256,
      explicitDeltas: [
        'restore omitted Version.sol implementation',
        'enforce OffchainExchange order signatures',
        'emit DepositCollateralWithReferral for Bond settlement provenance',
        'deploy unique non-custodial VirtualBook domains',
        'pin product zero to existing Galileo USDC.e and require exact custody transfers',
      ],
    },
    network: {
      name: '0G Galileo Testnet',
      chainId: GALILEO_CHAIN_ID,
    },
    deployer: deployer.address,
    sequencer,
    sequencerUsesDeployer: sequencer === deployer.address,
    quoteToken: quote,
    collateral: {
      address: GALILEO_USDCE_ADDRESS,
      symbol: GALILEO_USDCE_SYMBOL,
      decimals: GALILEO_USDCE_DECIMALS,
      productId: 0,
      source: 'existing',
      deployToken: false,
    },
    contracts: {
      sanctions: sanctionsRecord,
      clearinghouseLiq: clearinghouseLiqRecord,
      verifier: verifierRecord,
      endpoint: endpointRecord,
      clearinghouse: clearinghouseRecord,
      spotEngine: spotEngineRecord,
      perpEngine: perpEngineRecord,
      offchainExchange: offchainExchangeRecord,
    },
    markets,
    gates: {
      signedBatchAbiOnly: true,
      orderSignaturesEnforced: true,
      updatePerpBalanceAbsent: true,
      slowModeExitPreserved: true,
      productRiskConfigApproved: true,
      reviewerPinnedBuildAndConfigHashes: true,
      exactVerifierSignerCountAndBitmask: true,
      exactLiveMarketConfiguration: true,
      exactGalileoUsdcePinned: quote === GALILEO_USDCE_ADDRESS,
      collateralTokenDeploymentAbsent: true,
    },
  };

  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`Galileo deployment manifest written to ${manifestFile}`);
  console.log('No private keys or secret values were printed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
