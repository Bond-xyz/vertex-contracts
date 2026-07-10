import fs from 'fs';
import path from 'path';
import { artifacts, ethers } from 'hardhat';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  requireGalileoUsdce,
} from './deployment-config';
import {
  assertBuildEvidenceMatches,
  collectReleaseBuildEvidence,
  loadReviewedSourceEvidence,
  ReleaseBuildEvidence,
  repositoryRoot,
  verifyProxyDeployment,
  verifyRuntimeArtifact,
} from './release-evidence';

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

  await verifyRuntimeArtifact(
    ethers.provider,
    manifest.contracts.sanctions.address,
    reviewedBuild.artifacts.sanctions,
    'sanctions',
    manifest.contracts.sanctions.runtimeCodeHash
  );
  await verifyRuntimeArtifact(
    ethers.provider,
    manifest.contracts.clearinghouseLiq.address,
    reviewedBuild.artifacts.clearinghouseLiq,
    'clearinghouse liquidation implementation',
    manifest.contracts.clearinghouseLiq.runtimeCodeHash
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
  }

  const endpoint = await ethers.getContractAt('Endpoint', manifest.contracts.endpoint.proxy);
  const clearinghouse = await ethers.getContractAt('Clearinghouse', manifest.contracts.clearinghouse.proxy);
  const exchange = await ethers.getContractAt('OffchainExchange', manifest.contracts.offchainExchange.proxy);
  const spotEngine = await ethers.getContractAt('SpotEngine', manifest.contracts.spotEngine.proxy);
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
