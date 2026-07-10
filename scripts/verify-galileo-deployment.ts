import fs from 'fs';
import path from 'path';
import { BigNumber } from 'ethers';
import { artifacts, ethers } from 'hardhat';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  loadProducts,
  loadVerifierPoints,
  requireGalileoUsdce,
} from './deployment-config';
import type { ProductConfig } from './deployment-config';
import {
  assertVerifierPublicKeysMatch,
  assertBuildEvidenceMatches,
  collectReleaseBuildEvidence,
  loadReviewedSourceEvidence,
  normalizeVerifierPublicKeys,
  ReleaseBuildEvidence,
  repositoryRoot,
  verifyActiveClearinghouseLiq,
  verifyConfigFileSha256,
  verifyProxyDeployment,
  verifyRuntimeArtifact,
  verifyVerifierPublicKeys,
  verifyVirtualBookProductId,
} from './release-evidence';

function sameNumberish(actual: unknown, expected: unknown): boolean {
  try {
    return BigNumber.from(actual).eq(BigNumber.from(expected));
  } catch {
    return false;
  }
}

type ManifestMarketConfig = {
  productId: unknown;
  sizeIncrementX18: unknown;
  minSizeX18: unknown;
  lpSpreadX18: unknown;
  risk?: Record<string, unknown>;
};

function assertManifestMarketMatchesConfig(
  symbol: string,
  market: ManifestMarketConfig | undefined,
  product: ProductConfig
): void {
  if (!market) throw new Error(`manifest market is missing for ${symbol}`);
  for (const field of ['productId', 'sizeIncrementX18', 'minSizeX18', 'lpSpreadX18']) {
    if (!sameNumberish(market[field], product[field])) {
      throw new Error(`manifest market ${symbol}.${field} does not match reviewed product config`);
    }
  }
  for (const field of [
    'longWeightInitial',
    'shortWeightInitial',
    'longWeightMaintenance',
    'shortWeightMaintenance',
    'priceX18',
  ]) {
    if (!sameNumberish(market.risk?.[field], product.risk[field])) {
      throw new Error(`manifest market ${symbol}.risk.${field} does not match reviewed product config`);
    }
  }
}

async function main() {
  const manifestFile = path.resolve(process.env.PERPDEX_DEPLOYMENT_MANIFEST || './deployments/16602/latest.local.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 2) {
    throw new Error('deployment manifest must use provenance schema version 2');
  }
  loadReviewedSourceEvidence(
    repositoryRoot(),
    manifest.source.reviewedReleaseCommit,
    manifest.source.reviewedSourceTree
  );
  const reviewedBuild = await collectReleaseBuildEvidence(artifacts);
  const recordedBuild: ReleaseBuildEvidence = {
    compiler: manifest.source.compiler,
    artifacts: manifest.source.artifacts,
  };
  assertBuildEvidenceMatches(recordedBuild, reviewedBuild);
  for (const [key, artifact] of Object.entries(reviewedBuild.artifacts)) {
    if (manifest.source.artifactRuntimeHashes?.[key] !== artifact.runtimeCodeHash) {
      throw new Error(`manifest runtime hash index mismatch for ${key}`);
    }
  }
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  verifyConfigFileSha256(productsFile, manifest.source.productConfigSha256, 'product config');
  verifyConfigFileSha256(verifierFile, manifest.source.verifierPublicKeysSha256, 'verifier public-key config');
  const products = loadProducts(productsFile);
  const verifierPublicKeys = normalizeVerifierPublicKeys([
    ...loadVerifierPoints(verifierFile),
    ...Array.from({ length: 5 }, () => ({ x: 0, y: 0 })),
  ]);
  assertVerifierPublicKeysMatch(
    manifest.contracts.verifier.publicKeys,
    verifierPublicKeys,
    'manifest verifier public key'
  );
  const manifestSymbols = Object.keys(manifest.markets).sort();
  const productSymbols = products.products.map((product) => product.symbol).sort();
  if (JSON.stringify(manifestSymbols) !== JSON.stringify(productSymbols)) {
    throw new Error('manifest markets do not exactly match the reviewed product config');
  }
  for (const product of products.products) {
    assertManifestMarketMatchesConfig(product.symbol, manifest.markets[product.symbol], product);
  }
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== GALILEO_CHAIN_ID || manifest.network.chainId !== GALILEO_CHAIN_ID) {
    throw new Error('manifest/network chain mismatch');
  }
  const collateral = requireGalileoUsdce(manifest.quoteToken);
  if (
    manifest.collateral?.address !== GALILEO_USDCE_ADDRESS ||
    manifest.collateral?.symbol !== GALILEO_USDCE_SYMBOL ||
    manifest.collateral?.decimals !== GALILEO_USDCE_DECIMALS ||
    manifest.collateral?.productId !== 0 ||
    manifest.collateral?.source !== 'existing' ||
    manifest.collateral?.deployToken !== false
  ) {
    throw new Error('manifest does not pin the existing Galileo USDC.e collateral');
  }

  const addresses = [
    manifest.quoteToken,
    manifest.contracts.sanctions.address,
    manifest.contracts.clearinghouseLiq.address,
    manifest.contracts.verifier.proxy,
    manifest.contracts.endpoint.proxy,
    manifest.contracts.clearinghouse.proxy,
    manifest.contracts.spotEngine.proxy,
    manifest.contracts.perpEngine.proxy,
    manifest.contracts.offchainExchange.proxy,
    ...Object.values(manifest.markets).map((market: any) => market.virtualBook),
  ];
  for (const address of addresses) {
    if ((await ethers.provider.getCode(address)) === '0x') {
      throw new Error(`missing bytecode at ${address}`);
    }
  }

  const endpoint = await ethers.getContractAt('Endpoint', manifest.contracts.endpoint.proxy);
  const clearinghouse = await ethers.getContractAt('Clearinghouse', manifest.contracts.clearinghouse.proxy);
  const exchange = await ethers.getContractAt('OffchainExchange', manifest.contracts.offchainExchange.proxy);
  const spotEngine = await ethers.getContractAt('SpotEngine', manifest.contracts.spotEngine.proxy);
  const verifier = await ethers.getContractAt('Verifier', manifest.contracts.verifier.proxy);

  await verifyRuntimeArtifact(
    ethers.provider,
    manifest.contracts.sanctions.address,
    reviewedBuild.artifacts.sanctions,
    'sanctions',
    manifest.contracts.sanctions.runtimeCodeHash
  );
  await verifyActiveClearinghouseLiq(
    ethers.provider,
    clearinghouse,
    manifest.contracts.clearinghouseLiq,
    reviewedBuild.artifacts.clearinghouseLiq
  );
  const proxyKeys = ['verifier', 'endpoint', 'clearinghouse', 'spotEngine', 'perpEngine', 'offchainExchange'] as const;
  for (const key of proxyKeys) {
    const record = manifest.contracts[key];
    if (record.artifactKey !== key) {
      throw new Error(`manifest artifact key mismatch for ${key}`);
    }
    await verifyProxyDeployment(
      ethers.provider,
      record,
      reviewedBuild.artifacts[key],
      reviewedBuild.artifacts.transparentUpgradeableProxy,
      reviewedBuild.artifacts.proxyAdmin,
      key
    );
  }
  await verifyVerifierPublicKeys(verifier, manifest.contracts.verifier.publicKeys);
  for (const [symbol, market] of Object.entries(manifest.markets) as any[]) {
    if (market.artifactKey !== 'virtualBook') {
      throw new Error(`manifest virtual-book artifact key mismatch for ${symbol}`);
    }
    await verifyRuntimeArtifact(
      ethers.provider,
      market.virtualBook,
      reviewedBuild.artifacts.virtualBook,
      `${symbol} virtual book`,
      market.runtimeCodeHash
    );
    await verifyVirtualBookProductId(ethers.provider, market.virtualBook, market.productId, `${symbol} virtual book`);
  }

  const quoteContract = new ethers.Contract(
    collateral,
    ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
    ethers.provider
  );
  if ((await clearinghouse.getQuote()) !== collateral) {
    throw new Error('clearinghouse quote token mismatch');
  }
  if ((await spotEngine.getToken(0)) !== collateral) {
    throw new Error('spot-engine product 0 token mismatch');
  }
  if (
    (await quoteContract.decimals()) !== GALILEO_USDCE_DECIMALS ||
    (await quoteContract.symbol()) !== GALILEO_USDCE_SYMBOL
  ) {
    throw new Error('on-chain Galileo USDC.e metadata mismatch');
  }
  if ((await endpoint.getSequencer()) !== manifest.sequencer) {
    throw new Error('sequencer mismatch');
  }
  for (const market of Object.values(manifest.markets) as any[]) {
    if ((await clearinghouse.getEngineByProduct(market.productId)) !== manifest.contracts.perpEngine.proxy) {
      throw new Error(`engine mismatch for product ${market.productId}`);
    }
    if ((await exchange.getVirtualBook(market.productId)) !== market.virtualBook) {
      throw new Error(`virtual-book mismatch for product ${market.productId}`);
    }
  }

  console.log('Galileo deployment verification passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
