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
  assertIndependentReleaseReviewer,
  assertDeploymentIntentAvailableForFirstTransaction,
  assertSameVerifiedReleaseEvidence,
  collectAndVerifyReleaseEvidence,
  executeAfterVerifiedPreflight,
  TRACKED_GALILEO_RELEASE_POLICY,
  VerifiedReleaseEvidence,
  writeAfterVerifiedPostflight,
} from './release-attestation';
import { collectContractInterfaceDiff } from './contract-interface-diff';

const AUDITED_BASE_COMMIT = '6d5df597afe4eb16c6131a85f45322e0954b9e94';
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

async function main() {
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  const attestationFile = path.resolve(
    process.env.PERPDEX_RELEASE_ATTESTATION_FILE || './config/galileo.release-attestation.local.json'
  );
  const deploymentIntentFile = path.resolve(
    process.env.PERPDEX_DEPLOYMENT_INTENT_FILE || './config/galileo.deployment-intent.local.json'
  );
  const manifestFile = path.resolve(process.env.PERPDEX_DEPLOYMENT_MANIFEST || './deployments/16602/latest.local.json');
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== GALILEO_CHAIN_ID) {
    throw new Error(`refusing deployment: expected chain ${GALILEO_CHAIN_ID}, got ${network.chainId}`);
  }

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
  const preflightContractDiff = await collectContractInterfaceDiff();

  // The signed attestation and clean source tree are recomputed immediately before the first transaction.
  const firstDeployment = await executeAfterVerifiedPreflight(
    () =>
      collectAndVerifyReleaseEvidence({
        artifacts,
        productsFile,
        verifierFile,
        attestationFile,
        deploymentIntentFile,
      }),
    async (preflight: VerifiedReleaseEvidence) => {
      const [deployer] = await ethers.getSigners();
      const sequencer = requiredAddress(
        process.env.PERPDEX_SEQUENCER_ADDRESS || deployer.address,
        'PERPDEX_SEQUENCER_ADDRESS'
      );
      assertIndependentReleaseReviewer(preflight.reviewer.address, deployer.address, sequencer);
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
      // Fresh contracts only. This is the first transaction-producing call in the script.
      const Sanctions = await ethers.getContractFactory('MockSanctionsList');
      const sanctions = await Sanctions.deploy({ nonce: preflight.deploymentIntent.firstTransactionNonce });
      if (
        sanctions.address !== preflight.deploymentIntent.expectedFirstContract ||
        sanctions.deployTransaction.nonce !== preflight.deploymentIntent.firstTransactionNonce
      ) {
        throw new Error('first deployment transaction does not match signed deployment intent');
      }
      await sanctions.deployed();
      return { preflight, deployer, sequencer, sanctions, openZeppelinManifestFile: openZeppelinManifest.file };
    }
  );
  const { preflight, deployer, sequencer, sanctions, openZeppelinManifestFile } = firstDeployment;
  const reviewedBuild = preflight.build;
  const products = preflight.products;
  const verifierConfig = preflight.verifierConfig;
  const verifierPoints = verifierConfig.keys;

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
  if (!BigNumber.from(await clearinghouse.getReleaseMode()).isZero()) {
    throw new Error('fresh Galileo deployment must start in ACTIVE release mode');
  }
  for (const [label, contract] of [
    ['Verifier', verifier],
    ['Endpoint', endpoint],
    ['Clearinghouse', clearinghouse],
    ['SpotEngine', spotEngine],
    ['PerpEngine', perpEngine],
    ['OffchainExchange', offchainExchange],
  ] as const) {
    if ((await contract.owner()) !== deployer.address) {
      throw new Error(`${label} owner is not the signed deployment operator`);
    }
  }

  const VirtualBook = await ethers.getContractFactory('VirtualBook');
  const markets: Record<string, unknown> = {};
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

  const finalOpenZeppelinManifest = await Manifest.forNetwork(hardhatNetwork.provider);
  if (finalOpenZeppelinManifest.file !== openZeppelinManifestFile) {
    throw new Error('OpenZeppelin network manifest path changed during deployment');
  }
  const openZeppelinManifestData = await finalOpenZeppelinManifest.read();
  if (
    openZeppelinManifestData.proxies.length !== 6 ||
    Object.values(openZeppelinManifestData.impls).filter(Boolean).length !== 6 ||
    !openZeppelinManifestData.admin
  ) {
    throw new Error('fresh OpenZeppelin manifest must contain exactly six proxies, six implementations, and one admin');
  }
  const openZeppelinManifestPath = path.resolve(__dirname, '..', finalOpenZeppelinManifest.file);
  if (!fs.existsSync(openZeppelinManifestPath)) {
    throw new Error('fresh OpenZeppelin deployment manifest was not written');
  }

  const sanctionsRecord = await runtimeRecord(
    sanctions,
    'sanctions',
    reviewedBuild.artifacts.sanctions,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );
  const clearinghouseLiqRecord = await runtimeRecord(
    clearinghouseLiq,
    'clearinghouseLiq',
    reviewedBuild.artifacts.clearinghouseLiq,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );
  await verifyActiveClearinghouseLiq(
    ethers.provider,
    clearinghouse,
    clearinghouseLiqRecord,
    reviewedBuild.artifacts.clearinghouseLiq
  );
  const verifierRecord = {
    ...(await proxyRecord(
      verifier,
      'verifier',
      reviewedBuild,
      openZeppelinManifestData,
      deployer.address,
      preflight.deploymentIntent.firstTransactionNonce
    )),
    publicKeys: paddedVerifierPoints,
    signerCount: verifierPoints.length,
    signerBitmask: verifierConfig.signerBitmask,
  };
  const endpointRecord = await proxyRecord(
    endpoint,
    'endpoint',
    reviewedBuild,
    openZeppelinManifestData,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );
  const clearinghouseRecord = await proxyRecord(
    clearinghouse,
    'clearinghouse',
    reviewedBuild,
    openZeppelinManifestData,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );
  const spotEngineRecord = await proxyRecord(
    spotEngine,
    'spotEngine',
    reviewedBuild,
    openZeppelinManifestData,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );
  const perpEngineRecord = await proxyRecord(
    perpEngine,
    'perpEngine',
    reviewedBuild,
    openZeppelinManifestData,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );
  const offchainExchangeRecord = await proxyRecord(
    offchainExchange,
    'offchainExchange',
    reviewedBuild,
    openZeppelinManifestData,
    deployer.address,
    preflight.deploymentIntent.firstTransactionNonce
  );

  // A fresh signed-attestation and clean-tree verification gates manifest creation after all transactions.
  await writeAfterVerifiedPostflight(
    () =>
      collectAndVerifyReleaseEvidence({
        artifacts,
        productsFile,
        verifierFile,
        attestationFile,
        deploymentIntentFile,
      }),
    async (postflight: VerifiedReleaseEvidence) => {
      assertSameVerifiedReleaseEvidence(preflight, postflight);
      const finalBuild = postflight.build;
      const finalContractDiff = await collectContractInterfaceDiff();
      if (finalContractDiff.sha256 !== preflightContractDiff.sha256) {
        throw new Error('contract interface diff changed after deployment transactions');
      }
      const manifest = {
        schemaVersion: 6,
        release: GALILEO_RELEASE_ID,
        deploymentIntent: postflight.deploymentIntent,
        openZeppelin: {
          startedWithoutNetworkManifest: true,
          manifestFile: finalOpenZeppelinManifest.file,
          manifestSha256: sha256File(openZeppelinManifestPath),
        },
        source: {
          auditedBaseCommit: AUDITED_BASE_COMMIT,
          reviewedReleaseCommit: postflight.source.releaseCommit,
          reviewedSourceTree: postflight.source.sourceTree,
          compiler: finalBuild.compiler,
          buildInfos: finalBuild.buildInfos,
          artifacts: finalBuild.artifacts,
          buildEvidenceSha256: postflight.buildEvidenceSha256,
          artifactRuntimeHashes: Object.fromEntries(
            Object.entries(finalBuild.artifacts).map(([key, artifact]) => [key, artifact.runtimeCodeHash])
          ),
          productConfigSha256: postflight.productConfigSha256,
          verifierPublicKeysSha256: postflight.verifierConfigSha256,
          reviewAttestation: {
            policyFile: TRACKED_GALILEO_RELEASE_POLICY,
            policyId: postflight.policy.policyId,
            policyVersion: postflight.policy.policyVersion,
            policySha256: postflight.policySha256,
            digest: postflight.attestationDigest,
            reviewer: postflight.reviewer,
            signedAttestation: postflight.attestation,
          },
          explicitDeltas: [
            'restore omitted Version.sol implementation',
            'enforce OffchainExchange order signatures',
            'emit DepositCollateralWithReferral for Bond settlement provenance',
            'deploy unique non-custodial VirtualBook domains',
            'pin product zero to existing Galileo USDC.e and require exact custody transfers',
            'add implementation-level monotonic ACTIVE to CLOSE_ONLY to WITHDRAWALS_ONLY release controls',
            'emit exact same-token WithdrawalSettled conservation evidence',
            'emit explicit slow-mode failure index evidence',
          ],
          contractInterfaceDiff: finalContractDiff,
        },
        network: {
          name: '0G Galileo Testnet',
          chainId: GALILEO_CHAIN_ID,
        },
        deployer: deployer.address,
        sequencer,
        sequencerUsesDeployer: sequencer === deployer.address,
        roles: {
          deployer: deployer.address,
          sequencer,
          independentReleaseReviewer: postflight.reviewer,
          contractOwner: deployer.address,
          proxyAdminOwner: deployer.address,
          verifierKeys: {
            count: verifierPoints.length,
            signerBitmask: verifierConfig.signerBitmask,
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
          beforeAnyDeposit: 'Do not publish the registry; retain the manifest and abandon the parallel graph.',
          afterAnyDeposit:
            'Remain in CLOSE_ONLY until perp open interest, available settlement, LP supply and reserves, spot borrows and LP reserves, X-account balances, and non-quote deposits are zero and per-account PnL is reconciled; then move to WITHDRAWALS_ONLY, complete and reconcile every same-token exit, and remove the graph from the registry.',
          proxyUpgradeAsRollback: false,
          incumbentMutationOrDeletion: false,
        },
        gates: {
          signedBatchAbiOnly: true,
          orderSignaturesEnforced: true,
          updatePerpBalanceAbsent: true,
          slowModeExitPreserved: true,
          productRiskConfigApproved: true,
          reviewerSignedAttestationVerifiedPreAndPost: true,
          signedDeploymentIntentSingleUseNonce: true,
          freshOpenZeppelinNetworkManifest: true,
          implementationAndAdminCreationProvenance: true,
          proxyAdminOwnerVerified: true,
          deterministicApplicationSolc013Reproduction: true,
          exactVerifierSignerCountAndBitmask: true,
          exactLiveMarketConfiguration: true,
          exactGalileoUsdcePinned: quote === GALILEO_USDCE_ADDRESS,
          collateralTokenDeploymentAbsent: true,
          reviewedContractDiffBound: true,
          releaseModeStartsActive: true,
          withdrawalSuccessEventAvailable: true,
          explorerVerificationComplete: false,
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
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
