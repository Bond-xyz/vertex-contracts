import fs from 'fs';
import path from 'path';
import { artifacts, ethers } from 'hardhat';
import { BigNumber, Contract, utils } from 'ethers';
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
  decodeProductIds,
  sha256File,
  verifyActiveClearinghouseLiq,
  verifyContractCreationEvidence,
  verifyLiveMarketConfiguration,
  verifyProxyAdminOwner,
  verifyProxyDeployment,
  verifyRuntimeArtifact,
  verifyVerifierQuorumConfiguration,
  verifyVirtualBookProductId,
} from './release-evidence';
import {
  assertSameVerifiedRedTestnetReleaseEvidence,
  collectAndVerifyRedTestnetRecoveryEvidence,
  TRACKED_RED_GALILEO_APPROVAL,
  VerifiedRedTestnetReleaseEvidence,
} from './red-testnet-approval';
import {
  assertGalileoLateReceiptRecoveryInputs,
  TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL,
} from './galileo-late-receipt-recovery-approval';
import { TRACKED_GALILEO_RELEASE_POLICY } from './release-attestation';
import { collectContractInterfaceDiff } from './contract-interface-diff';
import {
  assertStorkDeploymentSnapshotFresh,
  assertStorkObservationBlock,
  BACKEND_BETA_COMMIT,
  collectGalileoStorkReleasePreflight,
  storkPricesByProductId,
  TRACKED_COLLATERAL_PROVENANCE,
  TRACKED_STORK_DEPLOYMENT_POLICY,
} from './stork-deployment-snapshot';
import {
  assertCanonicalGalileoProductPrefix,
  assertSingleAddProductEvent,
  deterministicSha256,
  FinalizationStepPlan,
  portableArtifactReference,
} from './galileo-finalization-journal';
import {
  LateReceiptRecoveryEvidence,
  recoverLateCanonicalReceipts,
  RecoveredFinalizationJournal,
} from './galileo-late-receipt-recovery';
import { isCanonicalGalileoRuntimeCodeHash } from './galileo-runtime-hash';

const AUDITED_BASE_COMMIT = '6d5df597afe4eb16c6131a85f45322e0954b9e94';
const EXPECTED_OPENZEPPELIN_MANIFEST = `.openzeppelin/unknown-${GALILEO_CHAIN_ID}.json`;
type PreparedDeployment = Record<string, any>;

type RecoveryFiles = {
  productsFile: string;
  verifierFile: string;
  productReviewFile: string;
  approvalFile: string;
  deploymentIntentFile: string;
  preparedFile: string;
  snapshotFile: string;
  originalJournalFile: string;
  originalManifestFile: string;
  recoveredJournalFile: string;
  recoveredManifestFile: string;
};

function recoveryFiles(): RecoveryFiles {
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
    snapshotFile: path.resolve(
      process.env.PERPDEX_STORK_SNAPSHOT_FILE || './config/galileo.stork-deployment-snapshot.local.json'
    ),
    originalJournalFile: path.resolve(
      process.env.PERPDEX_ABANDONED_FINALIZATION_JOURNAL || './deployments/16602/finalization.local.json'
    ),
    originalManifestFile: path.resolve(
      process.env.PERPDEX_DEPLOYMENT_MANIFEST || './deployments/16602/latest.local.json'
    ),
    recoveredJournalFile: path.resolve(
      process.env.PERPDEX_RECOVERED_FINALIZATION_JOURNAL || './deployments/16602/finalization.recovered.local.json'
    ),
    recoveredManifestFile: path.resolve(
      process.env.PERPDEX_RECOVERED_DEPLOYMENT_MANIFEST || './deployments/16602/latest.recovered.local.json'
    ),
  };
}

function redEvidenceInput(files: RecoveryFiles) {
  return {
    artifacts,
    productsFile: files.productsFile,
    productReviewFile: files.productReviewFile,
    verifierFile: files.verifierFile,
    approvalFile: files.approvalFile,
    deploymentIntentFile: files.deploymentIntentFile,
  };
}

function assertPreparedBinding(prepared: PreparedDeployment, preflight: VerifiedRedTestnetReleaseEvidence): void {
  const expectedProducts = preflight.products.products;
  const expectedSymbols = expectedProducts.map((product) => product.symbol);
  const preparedSymbols = Object.keys(prepared.markets || {});
  const exactNumber = (actual: unknown, expected: unknown): boolean => {
    try {
      return BigNumber.from(actual).eq(BigNumber.from(expected));
    } catch {
      return false;
    }
  };
  const marketMismatch =
    JSON.stringify(preparedSymbols) !== JSON.stringify(expectedSymbols) ||
    expectedProducts.some((product) => {
      const market = prepared.markets?.[product.symbol];
      return (
        !market ||
        market.productId !== product.productId ||
        !utils.isAddress(market.virtualBook) ||
        utils.getAddress(market.virtualBook) === ethers.constants.AddressZero ||
        market.artifactKey !== 'virtualBook' ||
        !isCanonicalGalileoRuntimeCodeHash(market.runtimeCodeHash) ||
        !exactNumber(market.sizeIncrementX18, product.sizeIncrementX18) ||
        !exactNumber(market.minSizeX18, product.minSizeX18) ||
        !exactNumber(market.lpSpreadX18, product.lpSpreadX18) ||
        JSON.stringify(market.riskWeights) !== JSON.stringify(product.risk)
      );
    });
  const contractKeys = [
    'sanctions',
    'clearinghouseLiq',
    'verifier',
    'endpoint',
    'clearinghouse',
    'spotEngine',
    'perpEngine',
    'offchainExchange',
  ];
  const preparedContractKeys = Object.keys(prepared.contracts || {});
  const contractAddresses = contractKeys.map(
    (key) => prepared.contracts?.[key]?.proxy || prepared.contracts?.[key]?.address
  );
  const marketAddresses = expectedSymbols.map((symbol) => prepared.markets?.[symbol]?.virtualBook);
  const contractAddressMismatch =
    JSON.stringify(preparedContractKeys) !== JSON.stringify(contractKeys) ||
    contractAddresses.some(
      (address) => !utils.isAddress(address || '') || utils.getAddress(address) === ethers.constants.AddressZero
    ) ||
    new Set(contractAddresses.map((address) => utils.getAddress(address))).size !== contractAddresses.length ||
    marketAddresses.some(
      (address) => !utils.isAddress(address || '') || utils.getAddress(address) === ethers.constants.AddressZero
    ) ||
    new Set(marketAddresses.map((address) => utils.getAddress(address))).size !== marketAddresses.length ||
    marketAddresses.some((address) =>
      contractAddresses.some((contractAddress) => utils.getAddress(address) === utils.getAddress(contractAddress))
    );
  const expectedManifestPath = path.resolve(__dirname, '..', EXPECTED_OPENZEPPELIN_MANIFEST);
  if (
    prepared.schemaVersion !== 1 ||
    prepared.phase !== 'prepared_no_price_writes' ||
    prepared.release !== GALILEO_RELEASE_ID ||
    prepared.network?.chainId !== GALILEO_CHAIN_ID ||
    prepared.quoteToken !== GALILEO_USDCE_ADDRESS ||
    utils.getAddress(prepared.deployer || ethers.constants.AddressZero) !==
      utils.getAddress(preflight.deploymentIntent.deployer) ||
    utils.getAddress(prepared.sequencer || ethers.constants.AddressZero) !==
      utils.getAddress(preflight.deploymentIntent.sequencer) ||
    JSON.stringify(prepared.deploymentIntent) !== JSON.stringify(preflight.deploymentIntent) ||
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
    prepared.openZeppelin?.manifestFile !== EXPECTED_OPENZEPPELIN_MANIFEST ||
    path.resolve(__dirname, '..', prepared.openZeppelin?.manifestFile || '') !== expectedManifestPath ||
    !/^[0-9a-f]{64}$/i.test(prepared.openZeppelin?.manifestSha256 || '') ||
    !Number.isSafeInteger(prepared.finalizationBoundary?.startingNonce) ||
    prepared.finalizationBoundary.startingNonce < 0 ||
    !Number.isSafeInteger(prepared.finalizationBoundary?.blockNumber) ||
    prepared.finalizationBoundary.blockNumber < 0 ||
    !utils.isHexString(prepared.finalizationBoundary?.blockHash || '', 32) ||
    !/^[0-9a-f]{64}$/i.test(prepared.finalizationBoundary?.releaseStateHostIdentity || '') ||
    prepared.finalizationBoundary?.leaseScope !== 'single_host_local_eoa_no_cross_host' ||
    marketMismatch ||
    contractAddressMismatch ||
    JSON.stringify(prepared.collateralProvenance) !== JSON.stringify(preflight.staticPolicy.collateralProvenance) ||
    prepared.gates?.endpointUninitialized !== true ||
    prepared.gates?.perpProductsAbsent !== true ||
    prepared.gates?.staticPricesAbsent !== true
  ) {
    throw new Error('prepared Galileo graph does not match the approved static release evidence');
  }
}

async function checkedQuote(): Promise<string> {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== GALILEO_CHAIN_ID) {
    throw new Error(`refusing recovery: expected chain ${GALILEO_CHAIN_ID}, got ${network.chainId}`);
  }
  const quote = requireGalileoUsdce(GALILEO_USDCE_ADDRESS);
  if ((await ethers.provider.getCode(quote)) === '0x') throw new Error('canonical quote token has no bytecode');
  const token = new Contract(
    quote,
    ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
    ethers.provider
  );
  if ((await token.decimals()) !== GALILEO_USDCE_DECIMALS || (await token.symbol()) !== GALILEO_USDCE_SYMBOL) {
    throw new Error(`Galileo collateral metadata mismatch: expected ${GALILEO_USDCE_SYMBOL}/${GALILEO_USDCE_DECIMALS}`);
  }
  return quote;
}

function exactRisk(risk: any, product: any): boolean {
  return (
    BigNumber.from(risk.longWeightInitialX18 ?? risk[0]).eq(
      BigNumber.from(product.risk.longWeightInitial).mul(1_000_000_000)
    ) &&
    BigNumber.from(risk.shortWeightInitialX18 ?? risk[1]).eq(
      BigNumber.from(product.risk.shortWeightInitial).mul(1_000_000_000)
    ) &&
    BigNumber.from(risk.longWeightMaintenanceX18 ?? risk[2]).eq(
      BigNumber.from(product.risk.longWeightMaintenance).mul(1_000_000_000)
    ) &&
    BigNumber.from(risk.shortWeightMaintenanceX18 ?? risk[3]).eq(
      BigNumber.from(product.risk.shortWeightMaintenance).mul(1_000_000_000)
    ) &&
    BigNumber.from(risk.priceX18 ?? risk[4]).eq(product.risk.priceX18)
  );
}

async function verifyCompleteLiveGraph(input: {
  prepared: PreparedDeployment;
  preflight: Awaited<ReturnType<typeof collectAndVerifyRedTestnetRecoveryEvidence>>;
  products: ReturnType<typeof resolveProductsWithStorkPrices>;
  quote: string;
  endpoint: Contract;
  verifier: Contract;
  clearinghouse: Contract;
  spotEngine: Contract;
  perpEngine: Contract;
  offchainExchange: Contract;
}): Promise<void> {
  const {
    prepared,
    preflight,
    products,
    quote,
    endpoint,
    verifier,
    clearinghouse,
    spotEngine,
    perpEngine,
    offchainExchange,
  } = input;
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
      `recovered ${key}`
    );
    if (!record.provenance) throw new Error(`recovered ${key} is missing exact creation provenance`);
    await verifyContractCreationEvidence(
      ethers.provider,
      record.provenance.proxy,
      record.proxy,
      prepared.deployer,
      `recovered ${key} proxy`,
      preflight.deploymentIntent.firstTransactionNonce
    );
    await verifyContractCreationEvidence(
      ethers.provider,
      record.provenance.implementation,
      record.implementation,
      prepared.deployer,
      `recovered ${key} implementation`,
      preflight.deploymentIntent.firstTransactionNonce
    );
    await verifyContractCreationEvidence(
      ethers.provider,
      record.provenance.admin,
      record.admin,
      prepared.deployer,
      `recovered ${key} ProxyAdmin`,
      preflight.deploymentIntent.firstTransactionNonce
    );
    if (
      (await verifyProxyAdminOwner(ethers.provider, record.admin, prepared.deployer)) !== record.provenance.adminOwner
    ) {
      throw new Error(`recovered ${key} ProxyAdmin owner drift`);
    }
  }
  await verifyRuntimeArtifact(
    ethers.provider,
    prepared.contracts.sanctions.address,
    preflight.build.artifacts.sanctions,
    'recovered sanctions',
    prepared.contracts.sanctions.runtimeCodeHash
  );
  await verifyContractCreationEvidence(
    ethers.provider,
    prepared.contracts.sanctions.creation,
    prepared.contracts.sanctions.address,
    prepared.deployer,
    'recovered sanctions',
    preflight.deploymentIntent.firstTransactionNonce
  );
  await verifyActiveClearinghouseLiq(
    ethers.provider,
    clearinghouse,
    prepared.contracts.clearinghouseLiq,
    preflight.build.artifacts.clearinghouseLiq
  );
  await verifyVerifierQuorumConfiguration(
    verifier,
    prepared.contracts.verifier.publicKeys,
    prepared.contracts.verifier.signerCount,
    prepared.contracts.verifier.signerBitmask
  );
  if ((await endpoint.owner()) !== prepared.deployer || (await endpoint.getSequencer()) !== prepared.sequencer) {
    throw new Error('recovered Endpoint owner or sequencer mismatch');
  }
  const productIds = decodeProductIds(await perpEngine['getProductIds()']());
  if (JSON.stringify(productIds) !== JSON.stringify([2, 4, 6, 8])) {
    throw new Error('recovered PerpEngine product IDs are not exactly 2,4,6,8');
  }
  if (!BigNumber.from(await clearinghouse.getReleaseMode()).isZero()) {
    throw new Error('recovered Galileo graph is not in ACTIVE release mode');
  }
  if ((await clearinghouse.getQuote()) !== quote || (await spotEngine.getToken(0)) !== quote) {
    throw new Error('recovered Galileo collateral binding mismatch');
  }
  for (const [label, contract] of [
    ['Verifier', verifier],
    ['Endpoint', endpoint],
    ['Clearinghouse', clearinghouse],
    ['SpotEngine', spotEngine],
    ['PerpEngine', perpEngine],
    ['OffchainExchange', offchainExchange],
  ] as const) {
    if ((await contract.owner()) !== prepared.deployer) throw new Error(`recovered ${label} owner mismatch`);
  }
  for (const product of products.products) {
    const market = prepared.markets[product.symbol];
    if (!BigNumber.from(await endpoint.getPriceX18(product.productId)).eq(product.risk.priceX18)) {
      throw new Error(`${product.symbol} recovered Endpoint price mismatch`);
    }
    if (!exactRisk(await perpEngine.getRisk(product.productId), product)) {
      throw new Error(`${product.symbol} recovered PerpEngine risk mismatch`);
    }
    if (
      utils.getAddress(await offchainExchange.getVirtualBook(product.productId)) !==
        utils.getAddress(market.virtualBook) ||
      utils.getAddress(await clearinghouse.getEngineByProduct(product.productId)) !==
        utils.getAddress(prepared.contracts.perpEngine.proxy) ||
      !BigNumber.from(await offchainExchange.getSizeIncrement(product.productId)).eq(product.sizeIncrementX18) ||
      !BigNumber.from(await offchainExchange.getMinSize(product.productId)).eq(product.minSizeX18) ||
      !BigNumber.from((await offchainExchange.getLpParams(product.productId)).lpSpreadX18).eq(product.lpSpreadX18)
    ) {
      throw new Error(`${product.symbol} recovered VBook, engine, or market sizing mismatch`);
    }
    await verifyVirtualBookProductId(
      ethers.provider,
      market.virtualBook,
      product.productId,
      `${product.symbol} recovered virtual book`
    );
    await verifyRuntimeArtifact(
      ethers.provider,
      market.virtualBook,
      preflight.build.artifacts.virtualBook,
      `${product.symbol} recovered virtual book`,
      market.runtimeCodeHash
    );
  }
  await verifyLiveMarketConfiguration({ clearinghouse, spotEngine, perpEngine, offchainExchange }, products, quote);
}

function buildRecoveredManifest(input: {
  files: RecoveryFiles;
  prepared: PreparedDeployment;
  preflight: Awaited<ReturnType<typeof collectAndVerifyRedTestnetRecoveryEvidence>>;
  products: ReturnType<typeof resolveProductsWithStorkPrices>;
  storkPreflight: ReturnType<typeof collectGalileoStorkReleasePreflight>;
  contractDiff: Awaited<ReturnType<typeof collectContractInterfaceDiff>>;
  quote: string;
  journal: RecoveredFinalizationJournal;
  journalSha256: string;
  recovery: LateReceiptRecoveryEvidence;
}): Record<string, any> {
  const {
    files,
    prepared,
    preflight,
    products,
    storkPreflight,
    contractDiff,
    quote,
    journal,
    journalSha256,
    recovery,
  } = input;
  const endpointInitializeEvidence = journal.steps[0].receipt!;
  const productPriceWriteEvidence = new Map(journal.steps.slice(1).map((step) => [step.symbol!, step.receipt!]));
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
  return {
    schemaVersion: 9,
    release: GALILEO_RELEASE_ID,
    deploymentIntent: preflight.deploymentIntent,
    preparation: {
      schemaVersion: prepared.schemaVersion,
      phase: prepared.phase,
      preparedFileSha256: sha256File(files.preparedFile),
      noPriceWritesAtPreparation: true,
      finalizationBoundary: prepared.finalizationBoundary,
    },
    finalization: {
      journalReference: portableArtifactReference(files.recoveredManifestFile, files.recoveredJournalFile),
      journalSha256,
      planSha256: journal.planSha256,
      status: journal.status,
      leaseScope: journal.leaseScope,
      finalityConfirmations: journal.finalityConfirmations,
      finalityHeadBlock: Math.max(...journal.steps.map((step) => step.finality!.observedHeadBlock)),
      startingNonce: journal.startingNonce,
      scanFromBlock: journal.scanFromBlock,
      steps: journal.steps,
    },
    recovery,
    openZeppelin: prepared.openZeppelin,
    source: {
      auditedBaseCommit: AUDITED_BASE_COMMIT,
      reviewedReleaseCommit: preflight.source.releaseCommit,
      reviewedSourceTree: preflight.source.sourceTree,
      compiler: preflight.build.compiler,
      buildInfos: preflight.build.buildInfos,
      artifacts: preflight.build.artifacts,
      buildEvidenceSha256: preflight.buildEvidenceSha256,
      artifactRuntimeHashes: Object.fromEntries(
        Object.entries(preflight.build.artifacts).map(([key, artifact]) => [key, artifact.runtimeCodeHash])
      ),
      productConfigSha256: preflight.productConfigSha256,
      productReviewSha256: preflight.productReviewSha256,
      backendProtocolBaselineCommit: BACKEND_BETA_COMMIT,
      backendRuntimeRelease: storkPreflight.policy.backend.runtimeRelease,
      storkPolicySha256: storkPreflight.policySha256,
      storkSnapshotSha256: storkPreflight.snapshotSha256,
      collateralProvenanceSha256: storkPreflight.collateralProvenanceSha256,
      verifierPublicKeysSha256: preflight.verifierConfigSha256,
      redTestnetApproval: {
        policyFile: TRACKED_GALILEO_RELEASE_POLICY,
        policyId: preflight.policy.policyId,
        policyVersion: preflight.policy.policyVersion,
        policySha256: preflight.policySha256,
        approvalFile: TRACKED_RED_GALILEO_APPROVAL,
        approvalSha256: preflight.approvalSha256,
        digest: preflight.approvalDigest,
        approval: preflight.approval,
      },
      lateReceiptRecoveryApproval: {
        approvalFile: TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL,
        approvalSha256: preflight.lateReceiptRecoveryApproval.approvalSha256,
        digest: preflight.lateReceiptRecoveryApproval.approvalDigest,
        approval: preflight.lateReceiptRecoveryApproval.approval,
      },
      explicitDeltas: [
        'restore omitted Version.sol implementation',
        'enforce OffchainExchange order signatures',
        'pin product zero to existing Galileo USDC.e',
        'initialize every launch price from one fresh signed Stork snapshot',
      ],
      contractInterfaceDiff: contractDiff,
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
      backendProtocolBaselineCommit: BACKEND_BETA_COMMIT,
      backendRuntimeRelease: storkPreflight.policy.backend.runtimeRelease,
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
      graphPreparationDoesNotClaimFreshPriceSnapshot: true,
      signedStorkSnapshotRequiredBeforeFirstPriceBearingTransaction: true,
      durableSequentialFinalizationJournalComplete: true,
      signedStorkSnapshotVerifiedImmediatelyBeforeEachPriceBroadcast: true,
      signedStorkSnapshotVerifiedAgainstEveryReceiptBlock: true,
      exactFinalizationTransactionAndEventParity: true,
      endpointAndPerMarketPriceWriteBlocksRecorded: true,
      lateCanonicalReceiptRecoveryVerified: true,
      noRecoveryTransactionBroadcast: true,
      staticDeployTimePricesAbsent: true,
      collateralTokenDeploymentAbsent: true,
      reviewedContractDiffBound: true,
      releaseModeStartsActive: true,
      withdrawalSuccessEventAvailable: true,
      explorerVerificationComplete: false,
    },
  };
}

async function main(): Promise<void> {
  const files = recoveryFiles();
  const preflight = await collectAndVerifyRedTestnetRecoveryEvidence(redEvidenceInput(files));
  const prepared = JSON.parse(fs.readFileSync(files.preparedFile, 'utf8')) as PreparedDeployment;
  assertPreparedBinding(prepared, preflight);
  const quote = await checkedQuote();
  const contractDiff = await collectContractInterfaceDiff();
  if (contractDiff.sha256 !== prepared.source.contractInterfaceDiff.sha256) {
    throw new Error('contract interface diff changed after graph preparation');
  }
  const openZeppelinManifestPath = path.resolve(__dirname, '..', prepared.openZeppelin.manifestFile);
  if (sha256File(openZeppelinManifestPath) !== prepared.openZeppelin.manifestSha256) {
    throw new Error('OpenZeppelin manifest changed after graph preparation');
  }
  const storkPreflight = collectGalileoStorkReleasePreflight({
    snapshotFile: files.snapshotFile,
    requireFresh: false,
  });
  if (
    storkPreflight.policySha256 !== preflight.staticPolicy.policySha256 ||
    storkPreflight.collateralProvenanceSha256 !== preflight.staticPolicy.collateralProvenanceSha256
  ) {
    throw new Error('recovery Stork snapshot does not match the statically approved policy/provenance');
  }
  const observationBlock = await ethers.provider.getBlock(storkPreflight.snapshot.observationBlock.number);
  if (!observationBlock) throw new Error('signed Stork observation block is unavailable');
  assertStorkObservationBlock(storkPreflight.snapshot, observationBlock);
  const products = resolveProductsWithStorkPrices(preflight.products, storkPricesByProductId(storkPreflight.snapshot));

  const endpoint = await ethers.getContractAt('Endpoint', prepared.contracts.endpoint.proxy, ethers.provider);
  const verifier = await ethers.getContractAt('Verifier', prepared.contracts.verifier.proxy, ethers.provider);
  const clearinghouse = await ethers.getContractAt(
    'Clearinghouse',
    prepared.contracts.clearinghouse.proxy,
    ethers.provider
  );
  const spotEngine = await ethers.getContractAt('SpotEngine', prepared.contracts.spotEngine.proxy, ethers.provider);
  const perpEngine = await ethers.getContractAt('PerpEngine', prepared.contracts.perpEngine.proxy, ethers.provider);
  const offchainExchange = await ethers.getContractAt(
    'OffchainExchange',
    prepared.contracts.offchainExchange.proxy,
    ethers.provider
  );
  const endpointArguments = [
    prepared.contracts.sanctions.address,
    prepared.sequencer,
    prepared.contracts.offchainExchange.proxy,
    prepared.contracts.clearinghouse.proxy,
    prepared.contracts.verifier.proxy,
    initialPrices(products.products),
  ];
  const endpointCalldata = endpoint.interface.encodeFunctionData('initialize', endpointArguments);
  const steps: FinalizationStepPlan[] = [
    {
      id: 'endpoint.initialize',
      kind: 'endpoint_initialize',
      from: prepared.deployer,
      to: endpoint.address,
      nonce: prepared.finalizationBoundary.startingNonce,
      value: '0',
      calldata: endpointCalldata,
      selector: endpointCalldata.slice(0, 10),
      argsSha256: deterministicSha256(endpointArguments),
    },
  ];
  for (const [index, product] of products.products.entries()) {
    const market = prepared.markets[product.symbol];
    const args = [
      product.productId,
      market.virtualBook,
      product.sizeIncrementX18,
      product.minSizeX18,
      product.lpSpreadX18,
      { ...product.risk },
    ];
    const calldata = perpEngine.interface.encodeFunctionData('addProduct', args);
    steps.push({
      id: `perp.addProduct.${product.productId}`,
      kind: 'perp_add_product',
      symbol: product.symbol,
      productId: product.productId,
      from: prepared.deployer,
      to: perpEngine.address,
      nonce: prepared.finalizationBoundary.startingNonce + index + 1,
      value: '0',
      calldata,
      selector: calldata.slice(0, 10),
      argsSha256: deterministicSha256(args),
    });
  }
  const productById = new Map(products.products.map((product) => [product.productId, product]));
  const originalBytes = fs.readFileSync(files.originalJournalFile);
  assertGalileoLateReceiptRecoveryInputs(preflight.lateReceiptRecoveryApproval, {
    preparedFile: files.preparedFile,
    snapshotFile: files.snapshotFile,
    originalJournalFile: files.originalJournalFile,
    journal: JSON.parse(originalBytes.toString('utf8')),
  });
  const result = await recoverLateCanonicalReceipts({
    originalJournalFile: files.originalJournalFile,
    originalManifestFile: files.originalManifestFile,
    recoveredJournalFile: files.recoveredJournalFile,
    recoveredManifestFile: files.recoveredManifestFile,
    preparedFile: files.preparedFile,
    snapshotFile: files.snapshotFile,
    snapshotEvidenceSha256: storkPreflight.snapshotSha256,
    expected: {
      schemaVersion: 1,
      release: GALILEO_RELEASE_ID,
      chainId: GALILEO_CHAIN_ID,
      preparedFileSha256: sha256File(files.preparedFile),
      snapshotSha256: storkPreflight.snapshotSha256,
      manifestReference: portableArtifactReference(files.originalJournalFile, files.originalManifestFile),
      deployer: prepared.deployer,
      startingNonce: prepared.finalizationBoundary.startingNonce,
      scanFromBlock: prepared.finalizationBoundary.blockNumber,
      preparationBoundaryBlockHash: prepared.finalizationBoundary.blockHash,
      releaseStateHostIdentity: prepared.finalizationBoundary.releaseStateHostIdentity,
      leaseScope: 'single_host_local_eoa_no_cross_host',
      finalityConfirmations: 12,
      steps,
    },
    provider: ethers.provider,
    verifyReceiptBlock: async (step, receipt, block) => {
      assertStorkDeploymentSnapshotFresh(
        storkPreflight.snapshot,
        storkPreflight.policy,
        BigInt(block.timestamp) * 1_000_000_000n
      );
      if (step.kind === 'endpoint_initialize') return;
      const product = productById.get(step.productId!);
      if (!product || product.symbol !== step.symbol) throw new Error(`${step.id} product provenance mismatch`);
      assertSingleAddProductEvent(receipt as any, perpEngine.address, product.productId);
    },
    verifyLiveState: async () =>
      verifyCompleteLiveGraph({
        prepared,
        preflight,
        products,
        quote,
        endpoint,
        verifier,
        clearinghouse,
        spotEngine,
        perpEngine,
        offchainExchange,
      }),
    buildManifest: ({ journal, journalSha256, recovery }) => {
      const postflight = collectAndVerifyRedTestnetRecoveryEvidence(redEvidenceInput(files));
      return Promise.resolve(postflight).then((verifiedPostflight) => {
        assertSameVerifiedRedTestnetReleaseEvidence(preflight, verifiedPostflight);
        if (
          preflight.lateReceiptRecoveryApproval.approvalSha256 !==
            verifiedPostflight.lateReceiptRecoveryApproval.approvalSha256 ||
          preflight.lateReceiptRecoveryApproval.approvalDigest !==
            verifiedPostflight.lateReceiptRecoveryApproval.approvalDigest
        ) {
          throw new Error('post-recovery provenance drift: late-receipt recovery approval changed');
        }
        return buildRecoveredManifest({
          files,
          prepared,
          preflight: verifiedPostflight,
          products,
          storkPreflight,
          contractDiff,
          quote,
          journal,
          journalSha256,
          recovery,
        });
      });
    },
  });
  if (!fs.readFileSync(files.originalJournalFile).equals(originalBytes)) {
    throw new Error('original abandoned journal changed during read-only recovery command');
  }
  console.log(`Recovered canonical finalization journal: ${files.recoveredJournalFile}`);
  console.log(`Recovered schema-v9 deployment manifest: ${files.recoveredManifestFile}`);
  console.log(`Recovered journal SHA-256: ${result.journalSha256}`);
  console.log(`Recovered manifest SHA-256: ${result.manifestSha256}`);
  console.log('No transaction was signed or broadcast. The original terminal journal was not changed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
