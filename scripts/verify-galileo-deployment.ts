import fs from 'fs';
import path from 'path';
import { BigNumber } from 'ethers';
import { artifacts, ethers } from 'hardhat';
import {
  GALILEO_CHAIN_ID,
  GALILEO_RELEASE_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  requireGalileoUsdce,
} from './deployment-config';
import type { ProductConfig } from './deployment-config';
import {
  assertVerifierPublicKeysMatch,
  assertBuildEvidenceMatches,
  ContractCreationEvidence,
  normalizeVerifierPublicKeys,
  ReleaseBuildEvidence,
  verifyActiveClearinghouseLiq,
  verifyContractCreationEvidence,
  verifyLiveMarketConfiguration,
  verifyProxyDeployment,
  verifyProxyAdminOwner,
  verifyRuntimeArtifact,
  verifyVerifierQuorumConfiguration,
  verifyVirtualBookProductId,
} from './release-evidence';
import {
  assertManifestOperatorsMatchSignedIntent,
  collectAndVerifyReleaseEvidence,
  TRACKED_GALILEO_RELEASE_POLICY,
} from './release-attestation';
import { collectContractInterfaceDiff } from './contract-interface-diff';

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

type ManifestMarket = ManifestMarketConfig & {
  productId: number;
  artifactKey: string;
  virtualBook: string;
  runtimeCodeHash: string;
  creation: ContractCreationEvidence;
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
  if (manifest.schemaVersion !== 6) {
    throw new Error('deployment manifest must use release-control provenance schema version 6');
  }
  if (manifest.release !== GALILEO_RELEASE_ID) throw new Error('deployment manifest release identity mismatch');
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  const recordedAttestation = manifest.source.reviewAttestation;
  if (!recordedAttestation || recordedAttestation.policyFile !== TRACKED_GALILEO_RELEASE_POLICY) {
    throw new Error('deployment manifest is missing the tracked signed reviewer-attestation policy');
  }
  const verifiedRelease = await collectAndVerifyReleaseEvidence({
    artifacts,
    productsFile,
    verifierFile,
    attestation: recordedAttestation.signedAttestation,
    deploymentIntent: manifest.deploymentIntent,
  });
  assertManifestOperatorsMatchSignedIntent(verifiedRelease, manifest);
  if (
    manifest.deploymentIntent.expectedFirstContract !== manifest.contracts.sanctions.address ||
    manifest.openZeppelin?.startedWithoutNetworkManifest !== true ||
    manifest.openZeppelin?.manifestFile !== `.openzeppelin/unknown-${GALILEO_CHAIN_ID}.json` ||
    !/^[0-9a-f]{64}$/i.test(manifest.openZeppelin?.manifestSha256 || '')
  ) {
    throw new Error('deployment manifest does not prove the signed fresh-deployment boundary');
  }
  if (
    manifest.source.reviewedReleaseCommit !== verifiedRelease.source.releaseCommit ||
    manifest.source.reviewedSourceTree !== verifiedRelease.source.sourceTree ||
    recordedAttestation.policyId !== verifiedRelease.policy.policyId ||
    recordedAttestation.policyVersion !== verifiedRelease.policy.policyVersion ||
    recordedAttestation.policySha256 !== verifiedRelease.policySha256 ||
    recordedAttestation.digest !== verifiedRelease.attestationDigest ||
    recordedAttestation.reviewer?.address !== verifiedRelease.reviewer.address ||
    recordedAttestation.reviewer?.name !== verifiedRelease.reviewer.name
  ) {
    throw new Error('deployment manifest source or reviewer attestation does not match tracked signed evidence');
  }
  const reviewedBuild = verifiedRelease.build;
  const contractInterfaceDiff = await collectContractInterfaceDiff();
  if (
    manifest.source.contractInterfaceDiff?.sha256 !== contractInterfaceDiff.sha256 ||
    manifest.gates?.reviewedContractDiffBound !== true
  ) {
    throw new Error('deployment manifest contract interface diff does not match the reviewed local candidate');
  }
  if (
    manifest.source.buildEvidenceSha256 !== verifiedRelease.buildEvidenceSha256 ||
    manifest.source.productConfigSha256 !== verifiedRelease.productConfigSha256 ||
    manifest.source.verifierPublicKeysSha256 !== verifiedRelease.verifierConfigSha256
  ) {
    throw new Error('deployment manifest build/config digests do not match signed reviewer evidence');
  }
  const recordedBuild: ReleaseBuildEvidence = {
    compiler: manifest.source.compiler,
    buildInfos: manifest.source.buildInfos,
    artifacts: manifest.source.artifacts,
  };
  assertBuildEvidenceMatches(recordedBuild, reviewedBuild);
  for (const [key, artifact] of Object.entries(reviewedBuild.artifacts)) {
    if (manifest.source.artifactRuntimeHashes?.[key] !== artifact.runtimeCodeHash) {
      throw new Error(`manifest runtime hash index mismatch for ${key}`);
    }
  }
  const products = verifiedRelease.products;
  const verifierConfig = verifiedRelease.verifierConfig;
  const verifierPublicKeys = normalizeVerifierPublicKeys([
    ...verifierConfig.keys,
    ...Array.from({ length: 5 }, () => ({ x: 0, y: 0 })),
  ]);
  assertVerifierPublicKeysMatch(
    manifest.contracts.verifier.publicKeys,
    verifierPublicKeys,
    'manifest verifier public key'
  );
  if (
    manifest.contracts.verifier.signerCount !== verifierConfig.keys.length ||
    manifest.contracts.verifier.signerBitmask !== verifierConfig.signerBitmask
  ) {
    throw new Error('manifest verifier signer count/bitmask does not match reviewed verifier config');
  }
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
    ...(Object.values(manifest.markets) as ManifestMarket[]).map((market) => market.virtualBook),
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
  const perpEngine = await ethers.getContractAt('PerpEngine', manifest.contracts.perpEngine.proxy);
  const verifier = await ethers.getContractAt('Verifier', manifest.contracts.verifier.proxy);

  if (
    manifest.roles?.deployer !== manifest.deployer ||
    manifest.roles?.sequencer !== manifest.sequencer ||
    manifest.roles?.contractOwner !== manifest.deployer ||
    manifest.roles?.proxyAdminOwner !== manifest.deployer ||
    manifest.roles?.independentReleaseReviewer?.address !== verifiedRelease.reviewer.address ||
    manifest.roles?.verifierKeys?.count !== verifierConfig.keys.length ||
    manifest.roles?.verifierKeys?.signerBitmask !== verifierConfig.signerBitmask ||
    manifest.roles?.verifierKeys?.privateMaterialRecorded !== false
  ) {
    throw new Error('deployment manifest role assignment mismatch');
  }

  const minimumDeploymentNonce = manifest.deploymentIntent.firstTransactionNonce;
  if (manifest.contracts.sanctions.creation?.transactionNonce !== minimumDeploymentNonce) {
    throw new Error('signed deployment intent was not consumed by the first sanctions deployment');
  }
  await verifyContractCreationEvidence(
    ethers.provider,
    manifest.contracts.sanctions.creation,
    manifest.contracts.sanctions.address,
    manifest.deployer,
    'sanctions',
    minimumDeploymentNonce
  );
  await verifyContractCreationEvidence(
    ethers.provider,
    manifest.contracts.clearinghouseLiq.creation,
    manifest.contracts.clearinghouseLiq.address,
    manifest.deployer,
    'clearinghouse liquidation implementation',
    minimumDeploymentNonce
  );

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
    if (!record.provenance) throw new Error(`manifest is missing fresh-deployment provenance for ${key}`);
    await verifyContractCreationEvidence(
      ethers.provider,
      record.provenance.proxy,
      record.proxy,
      manifest.deployer,
      `${key} proxy`,
      minimumDeploymentNonce
    );
    await verifyContractCreationEvidence(
      ethers.provider,
      record.provenance.implementation,
      record.implementation,
      manifest.deployer,
      `${key} implementation`,
      minimumDeploymentNonce
    );
    await verifyContractCreationEvidence(
      ethers.provider,
      record.provenance.admin,
      record.admin,
      manifest.deployer,
      `${key} ProxyAdmin`,
      minimumDeploymentNonce
    );
    const adminOwner = await verifyProxyAdminOwner(
      ethers.provider,
      record.admin,
      manifest.deployer,
      `${key} ProxyAdmin`
    );
    if (record.provenance.adminOwner !== adminOwner) throw new Error(`${key} manifest ProxyAdmin owner mismatch`);
  }
  await verifyVerifierQuorumConfiguration(
    verifier,
    manifest.contracts.verifier.publicKeys,
    manifest.contracts.verifier.signerCount,
    manifest.contracts.verifier.signerBitmask
  );
  for (const [symbol, market] of Object.entries(manifest.markets) as Array<[string, ManifestMarket]>) {
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
    await verifyContractCreationEvidence(
      ethers.provider,
      market.creation,
      market.virtualBook,
      manifest.deployer,
      `${symbol} virtual book`,
      minimumDeploymentNonce
    );
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
  const releaseMode = BigNumber.from(await clearinghouse.getReleaseMode()).toNumber();
  if (
    manifest.releaseControls?.initialMode !== 0 ||
    manifest.releaseControls?.implementationMonotonic !== true ||
    manifest.releaseControls?.proxyAdminCanReplaceImplementation !== true ||
    manifest.releaseControls?.proxyAdminUpgradeAllowedByGate1Procedure !== false ||
    manifest.releaseControls?.withdrawalsOnlyRequiresPriorCloseOnly !== true ||
    manifest.releaseControls?.withdrawalsOnlyRequiresZeroEnumerableLiabilities !== true ||
    releaseMode < 0 ||
    releaseMode > 2
  ) {
    throw new Error('release-control mode mismatch');
  }
  for (const [label, contract] of [
    ['Verifier', verifier],
    ['Endpoint', endpoint],
    ['Clearinghouse', clearinghouse],
    ['SpotEngine', spotEngine],
    ['PerpEngine', perpEngine],
    ['OffchainExchange', exchange],
  ] as const) {
    if ((await contract.owner()) !== manifest.roles.contractOwner) {
      throw new Error(`${label} owner does not match the deployment manifest`);
    }
  }
  if (
    manifest.withdrawalContract?.token !== GALILEO_USDCE_ADDRESS ||
    manifest.withdrawalContract?.collateralProductId !== 0 ||
    manifest.withdrawalContract?.directLedgerFeeX18 !== '1000000000000000000' ||
    manifest.withdrawalContract?.slowWalletQueueFeeUnits !== '1000000' ||
    manifest.withdrawalContract?.slowTimeoutSeconds !== 259200 ||
    manifest.withdrawalContract?.failureEvent !== 'SlowModeTransactionFailed(uint64)' ||
    manifest.withdrawalContract?.cancellationSupported !== false ||
    manifest.withdrawalContract?.localTimeTravelIsLive72HourEvidence !== false
  ) {
    throw new Error('withdrawal evidence contract mismatch');
  }
  if ((await spotEngine.getWithdrawFee(0)).toString() !== manifest.withdrawalContract.directLedgerFeeX18) {
    throw new Error('live product-zero withdrawal fee mismatch');
  }
  await verifyLiveMarketConfiguration(
    { clearinghouse, spotEngine, perpEngine, offchainExchange: exchange },
    products,
    collateral
  );
  for (const market of Object.values(manifest.markets) as ManifestMarket[]) {
    if ((await clearinghouse.getEngineByProduct(market.productId)) !== manifest.contracts.perpEngine.proxy) {
      throw new Error(`engine mismatch for product ${market.productId}`);
    }
    if ((await exchange.getVirtualBook(market.productId)) !== market.virtualBook) {
      throw new Error(`virtual-book mismatch for product ${market.productId}`);
    }
  }

  const releaseModeName = ['ACTIVE', 'CLOSE_ONLY', 'WITHDRAWALS_ONLY'][releaseMode];
  console.log(`Galileo deployment verification passed. Current release mode: ${releaseModeName} (${releaseMode}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
