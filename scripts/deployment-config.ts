import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BigNumber, utils } from 'ethers';

export type PerpdexNetworkName = 'galileo' | 'og-mainnet' | 'og-mainnet-usdz';
export type ReleaseApprovalMode = 'tracked_red_testnet_approval' | 'external_reviewer_signature';

export const PERPDEX_NETWORK_ENV = 'PERPDEX_NETWORK';
export const DEFAULT_PERPDEX_NETWORK: PerpdexNetworkName = 'galileo';
export const GALILEO_TESTNET_CHAIN_ID = 16602;
export const OG_MAINNET_CHAIN_ID = 16661;
export const LAUNCH_PRODUCT_IDS = [2, 4, 6, 8] as const;

export type CollateralProvenanceSourcePins = {
  bondEnvironments: Record<string, string | boolean | null>;
  bondSuperApp: Record<string, unknown>;
};

export type GitFileEvidence = { path: string; blob: string; sha256: string };

// Per-lane runtime evidence. The two lane config files can be byte-identical apart
// from a comment, so file hashes alone do not say which lane a writer serves: each
// lane also binds its workload identity and an immutable Trading image. null means
// unresolved and keeps the gate closed; it is never a wildcard.
export type SequencerLaneEvidence = {
  deployment: PerpdexNetworkName;
  files: readonly GitFileEvidence[];
  // The one file the Trading writer mounts as its config; must be listed in files.
  runtimeConfigPath: string;
  // The lane's reviewed workload binding (bond-perpdex fresh-mainnet-lane-binding/v2):
  // deployment, environment and DATABASE_URL. Must be listed in files; the verifier
  // replays its contents against `environment` and `runtimeConfigPath`.
  laneBindingPath: string;
  environment: {
    // BOND_PERPS_ENV of the lane's Trading writer.
    bondPerpsEnv: string;
    // PERPDEX_QUOTE_DOMAIN (core/types quote_domain.rs). Must equal the profile's collateral assetId.
    quoteDomain: string;
    // PERPDEX_SEPARATE_QUOTE_BOOKS_ENABLED: true exactly when quoteDomain is not USDCE.
    separateQuoteBooksEnabled: boolean;
    // DATABASE_URL identity (Cloud SQL IAM user, no password). Each lane needs its own
    // fresh database; the live private-beta lineage database is refused.
    database: { name: string; iamUser: string; url: string } | null;
  };
  // Immutable Trading image the lane boots. Its source must descend from
  // SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT (checked against a checkout by
  // scripts/verify-sequencer-lane-evidence.ts; ancestry is not provable statically).
  tradingArtifact: {
    repository: string;
    digest: string | null;
    sourceCommit: string | null;
    sourceTree: string | null;
    // Protected publication run that built the digest (bond-perpdex Actions run id).
    publicationRunId: string | null;
  };
};

export type PerpdexNetworkProfile = {
  name: PerpdexNetworkName;
  displayName: string;
  chainId: number;
  projectId: string;
  releaseId: string;
  hardhatNetwork: string;
  rpcUrlEnv: string;
  legacyRpcUrlEnv: string | null;
  chainIdEnv: string;
  // null means the profile has no local signer and the deploy script refuses it.
  deployerPrivateKeyEnv: string | null;
  gasPriceEnv: string;
  explorer: string;
  collateral: { assetId: string; address: string; symbol: string; decimals: number; productId: 0 };
  marketSymbols: readonly [string, string, string, string];
  approvalMode: ReleaseApprovalMode;
  activeReleaseStatus: string;
  // Initial-health weights cap leverage: long max = 1 / (1 - longWeightInitial),
  // short max = 1 / (shortWeightInitial - 1) (weights scaled by 1e9).
  riskModel: {
    initialMarginPercent: string;
    maintenanceMarginPercent: string;
    maximumLeverage: string;
    // Audited loadProducts ceiling; 2.0 (2e9) itself is BaseEngine's spot-short
    // sentinel (health = int128.min) and is always refused for perps.
    maxShortWeightInitial: number;
    weights: {
      longWeightInitial: number;
      shortWeightInitial: number;
      longWeightMaintenance: number;
      shortWeightMaintenance: number;
    };
  };
  operators: { deployer: string | null; sequencer: string | null; contractAdmin: string | null };
  // Pinned external release reviewer; a null address keeps the reviewer allowlist empty (blocked).
  // mayBeDeployer records an explicit delegation of review to the deployer key.
  releaseReviewer: { name: string; address: string | null; mayBeDeployer: boolean } | null;
  // The Stork aggregator key a new deployment snapshot must be signed by. Keys in
  // previousReplayOnly verify historical evidence only and never a new snapshot.
  storkAggregator: {
    current: string;
    previousReplayOnly: readonly string[];
    provenance: {
      repository: string;
      commit: string;
      tree: string;
      files: readonly { path: string; blob: string; sha256: string }[];
    } | null;
  };
  // OffchainExchange matching does not enforce health, so the sequencer's own
  // leverage cap must match riskModel.maximumLeverage. Mainnet requires reviewed
  // evidence of the exact production runtime config for every lane before deploy.
  sequencerLeverageEvidence: {
    required: boolean;
    evidence: {
      repository: string;
      commit: string;
      tree: string;
      maxLeverage: number;
      // Exact-order admission must reserve ceil(shortNotional * ppb / 1e9) for a
      // short; at least shortWeightInitial - 1e9 (1_000_000_001 on mainnet) or a
      // full integer-1x short opens with negative on-chain initial health.
      shortOpeningCollateralPpb: number;
      // Perp health values a short at the oracle mark, not the fill price: the short
      // needs Q >= shortWeightInitial*mark*size - fill*size, i.e. ppb*mark notional
      // plus (mark - fill)*size. Admission must check post-fill initial health at the
      // oracle mark; a ppb reserve on fill (or mark) notional alone lets a short
      // filled below mark open unhealthy.
      shortAdmissionBasis: 'post_fill_initial_health_at_oracle_mark';
      // Matching debits fees from quote after the fill; the reserve must exclude them.
      feesReservedSeparately: true;
      lanes: readonly SequencerLaneEvidence[];
    } | null;
  };
  // Endpoint.submitTransactionsChecked signs keccak(idx, transactions) with no
  // chainId or Endpoint address, so a batch signed for one deployment replays on
  // any other Endpoint whose nSubmissions matches. Deployments listed here must
  // never share a verifier key with this profile.
  distinctVerifierQuorumFrom: readonly PerpdexNetworkName[];
  ids: {
    releasePolicy: string;
    feePolicy: string;
    storkPolicy: string;
    productReview: string;
    collateralProvenance: string;
  };
  decisions: { storkCoherence: string; productReview: string };
  pins: {
    feeBoundsWei: { minimum: bigint; default: bigint; maximum: bigint } | null;
    contractPacketBase: { commit: string; tree: string } | null;
    normalizedCarriedFieldTupleSha256: string | null;
    // 'legacy_literal': reviewed Galileo value, algorithm not reproducible in-repo.
    // 'canonical_json_v1': carriedFieldTupleSha256 recomputed from the provenance file.
    carriedFieldTupleDerivation: 'legacy_literal' | 'canonical_json_v1';
    collateralProvenanceSources: CollateralProvenanceSourcePins;
  };
  files: {
    envFile: string;
    products: string;
    productReview: string;
    collateralProvenance: string;
    contractBaseline: string;
    feePolicy: string;
    releasePolicy: string;
    storkPolicy: string;
    storkSnapshot: string;
    redApproval: string | null;
    releaseAttestation: string;
    verifierPublicKeys: string;
    verifierPrivateKeys: string | null;
    deploymentIntent: string;
  };
  deploymentsDir: string;
};

const GALILEO_PROFILE: PerpdexNetworkProfile = {
  name: 'galileo',
  displayName: '0G Galileo Testnet',
  chainId: GALILEO_TESTNET_CHAIN_ID,
  projectId: 'g-bond',
  releaseId: 'bond-perpdex-galileo-audited-base',
  hardhatNetwork: 'galileo',
  rpcUrlEnv: 'PERPDEX_GALILEO_RPC_URL',
  legacyRpcUrlEnv: 'GALILEO_RPC_URL',
  chainIdEnv: 'GALILEO_CHAIN_ID',
  deployerPrivateKeyEnv: 'PERPDEX_GALILEO_DEPLOYER_PRIVATE_KEY',
  gasPriceEnv: 'PERPDEX_GALILEO_GAS_PRICE_WEI',
  explorer: 'https://chainscan-galileo.0g.ai',
  collateral: {
    assetId: 'USDCE',
    address: '0xF2506aa3684871549083d235453a1dcDcCB3396c',
    symbol: 'USDC.e',
    decimals: 6,
    productId: 0,
  },
  marketSymbols: ['BTCUSDCPERP', 'ETHUSDCPERP', 'SOLUSDCPERP', '0GUSDCPERP'],
  approvalMode: 'tracked_red_testnet_approval',
  activeReleaseStatus: 'approved_for_galileo_testnet_release',
  riskModel: {
    initialMarginPercent: '5',
    maintenanceMarginPercent: '2.5',
    maximumLeverage: '20',
    maxShortWeightInitial: 2_000_000_000,
    weights: {
      longWeightInitial: 950_000_000,
      shortWeightInitial: 1_050_000_000,
      longWeightMaintenance: 975_000_000,
      shortWeightMaintenance: 1_025_000_000,
    },
  },
  operators: { deployer: null, sequencer: null, contractAdmin: null },
  releaseReviewer: null,
  storkAggregator: {
    current: '0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44',
    previousReplayOnly: [],
    provenance: null,
  },
  sequencerLeverageEvidence: { required: false, evidence: null },
  distinctVerifierQuorumFrom: [],
  ids: {
    releasePolicy: 'bond-perpdex-galileo-testnet-release',
    feePolicy: 'bond-perpdex-galileo-legacy-fees',
    storkPolicy: 'bond-perpdex-galileo-stork-deployment-prices',
    productReview: 'bond-perpdex-galileo-product-vectors',
    collateralProvenance: 'bond-galileo-usdce-product-zero',
  },
  decisions: {
    storkCoherence: 'approve_exact_galileo_testnet_cross_feed_timestamp_spread',
    productReview: 'approve_galileo_vectors_with_verified_stork_deploy_time_prices',
  },
  pins: {
    feeBoundsWei: { minimum: 2_000_000_007n, default: 4_000_000_007n, maximum: 20_000_000_000n },
    contractPacketBase: {
      commit: '8ac5c9f3dfd4c5afc33e940400ead69c719fe043',
      tree: 'fa7c4782c141c55ab8ecfa51a297bec1c6a4c43f',
    },
    normalizedCarriedFieldTupleSha256: 'b385d558b2000cf9cba3db74746e855fddc546464e7c172b338b662823719f7a',
    carriedFieldTupleDerivation: 'legacy_literal',
    collateralProvenanceSources: {
      bondEnvironments: {
        repository: 'Bond-xyz/bond-environments',
        commit: 'a54d8d3723beced7fc5838a83a63b4fb9070641d',
        tree: 'b62d8dc7e029138073ff44b57a3f25e7d41b6013',
        file: 'envs/og-testnet-staging/assets.json',
        fileBlob: '82434072f7ef8a0687bcd352ac5fb7abe17e8171',
        fileSha256: 'e5deda5e8514919dfb8aa8da0266d7e37c453d23aec95316d28947e804ea08b6',
        perpdexFile: 'envs/og-testnet-staging/perpdex.json',
        perpdexFileSha256: '61e152e8082c590ec8cf7f5778cd8903ff4842ea98235e94d5463b6d5184db53',
        assetId: 'USDCE',
        lendingEnabled: true,
        ammEnabled: true,
        provisionMode: 'existing',
        autoDeploy: false,
      },
      bondSuperApp: {
        repository: 'Bond-xyz/bond-super-app',
        commit: '65ad0d7ac03423d700c16b17f63f793ec9a2aeab',
        tree: '53fd5289392b88269496664c5ee765547313179a',
        file: 'packages/config/src/generated/registry.ts',
        fileBlob: 'a1d23eeb3c7e55d48656262616210fe395f500a3',
        fileSha256: '9f4653bdee06f1a6789b6ccda91df6e177ea4acbf26eaf7c3bc3dd718d49084a',
        assetId: 'USDCE',
        registryDomains: { lending: true, amm: true, perpdex: false },
        perpdexLifecycle: 'pending_fresh_deploy',
        perpdexEnabled: false,
      },
    },
  },
  files: {
    envFile: '.env.galileo.local',
    products: 'config/galileo.products.json',
    productReview: 'config/galileo.product-approval-review.json',
    collateralProvenance: 'config/galileo.collateral-provenance.json',
    contractBaseline: 'config/galileo.contract-baseline.json',
    feePolicy: 'config/galileo.fee-policy.json',
    releasePolicy: 'config/galileo.release-policy.json',
    storkPolicy: 'config/galileo.stork-deployment-policy.json',
    storkSnapshot: 'config/galileo.stork-deployment-snapshot.local.json',
    redApproval: 'config/galileo.red-testnet-approval.json',
    releaseAttestation: 'config/galileo.release-attestation.local.json',
    verifierPublicKeys: 'config/galileo.verifier-public-keys.local.json',
    verifierPrivateKeys: 'verifier-private-keys.galileo.local.json',
    deploymentIntent: 'config/galileo.deployment-intent.local.json',
  },
  deploymentsDir: 'deployments/16602',
};

// Both 0G mainnet deployments share chain 16661, the audited contract baseline,
// and the fee policy. Everything that names the quote token or its markets is per
// deployment (Endpoint has exactly one quote token), and so is the verifier quorum.
// See distinctVerifierQuorumFrom for why.
const OG_MAINNET_SHARED = {
  chainId: OG_MAINNET_CHAIN_ID,
  projectId: 'g-bond',
  hardhatNetwork: 'ogMainnet',
  rpcUrlEnv: 'PERPDEX_OG_MAINNET_RPC_URL',
  legacyRpcUrlEnv: 'PERPDEX_MAINNET_RPC_URL',
  chainIdEnv: 'OG_MAINNET_CHAIN_ID',
  deployerPrivateKeyEnv: 'PERPDEX_OG_MAINNET_DEPLOYER_PRIVATE_KEY',
  gasPriceEnv: 'PERPDEX_OG_MAINNET_GAS_PRICE_WEI',
  explorer: 'https://chainscan.0g.ai',
  approvalMode: 'external_reviewer_signature' as const,
  activeReleaseStatus: 'approved_for_og_mainnet_release',
  // Red (Adam): mainnet launches at 1x. longWeightInitial 0 caps longs at exactly
  // 1x; shortWeightInitial is 2.000000001 because 2.0 is BaseEngine's spot-short
  // sentinel, capping shorts at 1/1.000000001x. Maintenance keeps Galileo's
  // half-of-initial ratio (50%), reviewed safe with zero insurance.
  riskModel: {
    initialMarginPercent: '100',
    maintenanceMarginPercent: '50',
    maximumLeverage: '1',
    maxShortWeightInitial: 2_000_000_001,
    weights: {
      longWeightInitial: 0,
      shortWeightInitial: 2_000_000_001,
      longWeightMaintenance: 500_000_000,
      shortWeightMaintenance: 1_500_000_000,
    },
  },
  operators: {
    deployer: '0x07b735E020549ba56AAb8e3370d102C2Df6cabF7',
    sequencer: '0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59',
    contractAdmin: '0x7a3A932F1cc402941f3238292c80d138dA49Be25',
  },
  // Adam delegated release review to the deployer key: he approves, then the
  // attestation is signed with the deployer wallet. The sequencer stays independent.
  // Stork rotated its aggregator signer. bond-perpdex (backend authority) pins
  // the current key in core/types/src/stork.rs, keeps 0x0a803F… as previous
  // (replay-only), records its independent confirmation via Stork's documented
  // EVM deployments in ORACLE_MANIPULATION_GUARD.md, and deploys it in the
  // price-oracle resources. Galileo evidence stays on the previous key.
  storkAggregator: {
    current: '0x0bb53E0d5E89778DCD13C2720667D292368dD053',
    previousReplayOnly: ['0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44'],
    provenance: {
      repository: 'Bond-xyz/bond-perpdex',
      commit: '966205f818c46a31758798129dd194d0c5d2bbfb',
      tree: '935edbc3bf867dc3fd9ab2617ba6457700f23c1c',
      files: [
        {
          path: 'core/types/src/stork.rs',
          blob: 'a028818f3dd0fcdc9d86851d074926f1dde698a2',
          sha256: 'dd61e82ce9f0ff5f9cb36a2312ba9ad4cd2980380f0f5d096f2e534b6901ad46',
        },
        {
          path: 'docs/requirements/ORACLE_MANIPULATION_GUARD.md',
          blob: 'ef4cae72a6783412b71ca87240a74ce9cd9624e8',
          sha256: 'ecf8ba063df28ec1ad59d475615e21f191df8582320a08d869993efb63c3b678',
        },
        {
          path: 'deploy/base/price-oracle/resources.yaml',
          blob: '8e2f010a25b51848227f5e44da82894f2742b197',
          sha256: '3e86419fd79dd406ee041452a0c2731bce928d16212062ad32b24c8ce1fa9d50',
        },
      ],
    },
  },
  releaseReviewer: {
    name: 'Adam (deployer wallet)',
    address: '0x07b735E020549ba56AAb8e3370d102C2Df6cabF7',
    mayBeDeployer: true,
  },
  decisions: {
    storkCoherence: 'approve_exact_og_mainnet_cross_feed_timestamp_spread',
    productReview: 'approve_og_mainnet_vectors_with_verified_stork_deploy_time_prices',
  },
  // Bounds around the observed 4000000007 wei eth_gasPrice at 0G mainnet block
  // 49846964 (same structure as Galileo).
  feeBoundsWei: { minimum: 2_000_000_007n, default: 4_000_000_007n, maximum: 20_000_000_000n },
  // Merged og-mainnet deployment packet (PR #25) on bond/galileo-refork.
  contractPacketBase: {
    commit: '15287abc32072de7cbe820119682dce73e044eb1',
    tree: 'a9cbb18229e9ce65c23cd413339036fc2b44971c',
  },
  sharedFiles: {
    contractBaseline: 'config/og-mainnet.contract-baseline.json',
    feePolicy: 'config/og-mainnet.fee-policy.json',
  },
};

const OG_MAINNET_REGISTRY_SOURCE = {
  repository: 'Bond-xyz/bond-shared-registry',
  commit: '5efbb08aac4b632e73115f5d9d916a757570aa5d',
  tree: 'bef57a5d8e6edd23e19545f4458458323f33c255',
  file: 'envs/og-mainnet-prod/assets.json',
  fileBlob: '7fd1b3056d41942d77b437e82ce5253e2cdf2820',
  fileSha256: '0159a18380b3b4424739662cb24a645696598fe7fb5583637f99b9901a4630da',
  perpdexFile: 'envs/og-mainnet-prod/perpdex.json',
  perpdexFileSha256: '89f51ffb51b972ad8c2a6c40c2f862c692bdbd0e6568efcd4ba462d42906598d',
  provisionMode: 'existing',
  autoDeploy: false,
};

export const STATIC_PINNED_COLLATERAL_SELECTION = {
  mode: 'static_pinned',
  runtimeRegistryLookup: false,
  aliasSubstitutionAllowed: false,
  mockOrReplacementDeploymentAllowed: false,
  provenanceOnly: true,
} as const;

export type CarriedCollateralFields = {
  provenanceId: string;
  chainId: number;
  collateral: { address: string; symbol: string; decimals: number; productId: number };
  selection: Record<string, unknown>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

// canonical_json_v1: SHA-256 (hex) of the UTF-8 canonical JSON (keys sorted
// recursively, no whitespace) of exactly { provenanceId, chainId,
// collateral: { address (EIP-55 checksum), symbol, decimals, productId }, selection }.
// It does not reproduce the legacy Galileo literal; Galileo keeps that pin.
export function carriedFieldTupleSha256(fields: CarriedCollateralFields): string {
  const tuple = {
    provenanceId: fields.provenanceId,
    chainId: fields.chainId,
    collateral: {
      address: utils.getAddress(fields.collateral.address),
      symbol: fields.collateral.symbol,
      decimals: fields.collateral.decimals,
      productId: fields.collateral.productId,
    },
    selection: fields.selection,
  };
  return crypto.createHash('sha256').update(canonicalJson(tuple), 'utf8').digest('hex');
}

// bond-perpdex PR #2972 (contract_initial_health engine opt-in). Earlier Trading
// images refuse the lane config key, so every lane artifact must descend from it.
export const SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT = 'd7b15fd713355866f35fa5ccf971936ea47a4d47';
export const SEQUENCER_TRADING_IMAGE_REPOSITORY = 'us-central1-docker.pkg.dev/g-bond/bond-perpdex-services/trading';
// Live private-beta lineage (og-mainnet-prod). Its engine holds V1 checkpoints that
// contract_initial_health refuses, so no fresh launch lane may reuse its database.
export const SEQUENCER_RESERVED_TRADING_DATABASES: readonly string[] = ['bond_perpdex_prod_trading'];

// Reviewed fresh-lane files on Bond-xyz/bond-perpdex main at f1604545 (PR #2977,
// lane-binding.json). trading.toml is unchanged since PR #2973 (90c79ef4): same blobs.
// Blob = git object id at that commit; sha256 = SHA-256 of those exact bytes.
// f1604545 descends from the d7b15fd7 floor and from c0de735a (USDZ admitted in prod
// behind the separate-books switch).
const FRESH_MAINNET_LANE_SOURCE = {
  repository: 'Bond-xyz/bond-perpdex',
  commit: 'f16045451a96ad3ac77299903fdde200b2ac0044',
  tree: 'bc5fdc649e3e31c3f280d3b0b53d1f318dc346d9',
} as const;

// One Trading image serves both lanes; the lane is chosen by its workload env and
// runtime config, not the image. Built by protected main publication of f1604545:
// bond-perpdex Actions run 42942405427 (Cloud Build 54b23c18-04a1-400a-9dc2-411b756c498d).
const FRESH_MAINNET_TRADING_ARTIFACT: SequencerLaneEvidence['tradingArtifact'] = {
  repository: SEQUENCER_TRADING_IMAGE_REPOSITORY,
  digest: 'sha256:914762fd8d5868dbea330716bdc2a398812c5a18e8a820beddd0b00508c09bd4',
  sourceCommit: 'f16045451a96ad3ac77299903fdde200b2ac0044',
  sourceTree: 'bc5fdc649e3e31c3f280d3b0b53d1f318dc346d9',
  publicationRunId: '42942405427',
};

export const OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE: NonNullable<
  PerpdexNetworkProfile['sequencerLeverageEvidence']['evidence']
> = {
  ...FRESH_MAINNET_LANE_SOURCE,
  maxLeverage: 1,
  // orderbook-rs MarginPolicy::fully_collateralized_half_maintenance().admission_evidence()
  shortOpeningCollateralPpb: 1_000_000_001,
  shortAdmissionBasis: 'post_fill_initial_health_at_oracle_mark',
  feesReservedSeparately: true,
  lanes: [
    {
      deployment: 'og-mainnet',
      files: [
        {
          path: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet/trading.toml',
          blob: '3d25e144fee422d7dc7892d98c369c2f6c9f0cd1',
          sha256: 'd1b4a190021bf0b746dbdb3101213101d950cfc8cf96755f0608d89db2872ccf',
        },
        {
          path: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet/lane-binding.json',
          blob: '0972b7b56114d9347e54fd8f13f86f77eb9ebf09',
          sha256: 'e2e385b02d90af3bfa348871c76f67f1688ce4bfeca641a62478a409063b8545',
        },
      ],
      runtimeConfigPath: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet/trading.toml',
      laneBindingPath: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet/lane-binding.json',
      environment: {
        bondPerpsEnv: 'prod',
        quoteDomain: 'USDCE',
        separateQuoteBooksEnabled: false,
        database: {
          name: 'bond_perpdex_prod_og_mainnet_trading',
          iamUser: 'bond-perpdex-prod-og-trd%40g-bond.iam',
          url: 'postgresql://bond-perpdex-prod-og-trd%40g-bond.iam@127.0.0.1:5432/bond_perpdex_prod_og_mainnet_trading?sslmode=disable',
        },
      },
      tradingArtifact: FRESH_MAINNET_TRADING_ARTIFACT,
    },
    {
      deployment: 'og-mainnet-usdz',
      files: [
        {
          path: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet-usdz/trading.toml',
          blob: 'e3b5188881d7f00f13f1ba40fec0c65a086c999b',
          sha256: 'b7482a19440e5a452aa107bf16bd5fe61fa1dcc2aeb83cccc56b910ee2d1209e',
        },
        {
          path: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet-usdz/lane-binding.json',
          blob: 'eb9d3d78bdf6efc5d88ac2e314e90e342caf513b',
          sha256: 'e48697f21eb8b8606f487fa666d12aff9f5be91babfeba3f471d091bc553f30a',
        },
      ],
      runtimeConfigPath: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet-usdz/trading.toml',
      laneBindingPath: 'deploy/candidates/production/fresh-mainnet-launch/og-mainnet-usdz/lane-binding.json',
      // USDZ under BOND_PERPS_ENV=prod needs separate quote books (core/types at f1604545).
      environment: {
        bondPerpsEnv: 'prod',
        quoteDomain: 'USDZ',
        separateQuoteBooksEnabled: true,
        database: {
          name: 'bond_perpdex_prod_og_mainnet_usdz_trading',
          iamUser: 'bond-perpdex-prod-og-usdz-trd%40g-bond.iam',
          url: 'postgresql://bond-perpdex-prod-og-usdz-trd%40g-bond.iam@127.0.0.1:5432/bond_perpdex_prod_og_mainnet_usdz_trading?sslmode=disable',
        },
      },
      tradingArtifact: FRESH_MAINNET_TRADING_ARTIFACT,
    },
  ],
};

function ogMainnetProfile(input: {
  name: 'og-mainnet' | 'og-mainnet-usdz';
  sibling: 'og-mainnet' | 'og-mainnet-usdz';
  collateral: PerpdexNetworkProfile['collateral'];
  marketQuote: 'USDC' | 'USDZ';
  lendingEnabled: boolean;
  ammEnabled: boolean;
  bondSuperApp: Record<string, unknown>;
}): PerpdexNetworkProfile {
  const { sharedFiles } = OG_MAINNET_SHARED;
  const prefix = `config/${input.name}`;
  return {
    name: input.name,
    displayName: '0G Mainnet',
    chainId: OG_MAINNET_SHARED.chainId,
    projectId: OG_MAINNET_SHARED.projectId,
    releaseId: `bond-perpdex-${input.name}-audited-base`,
    hardhatNetwork: OG_MAINNET_SHARED.hardhatNetwork,
    rpcUrlEnv: OG_MAINNET_SHARED.rpcUrlEnv,
    legacyRpcUrlEnv: OG_MAINNET_SHARED.legacyRpcUrlEnv,
    chainIdEnv: OG_MAINNET_SHARED.chainIdEnv,
    deployerPrivateKeyEnv: OG_MAINNET_SHARED.deployerPrivateKeyEnv,
    gasPriceEnv: OG_MAINNET_SHARED.gasPriceEnv,
    explorer: OG_MAINNET_SHARED.explorer,
    collateral: input.collateral,
    marketSymbols: [
      `BTC${input.marketQuote}PERP`,
      `ETH${input.marketQuote}PERP`,
      `SOL${input.marketQuote}PERP`,
      `0G${input.marketQuote}PERP`,
    ],
    approvalMode: OG_MAINNET_SHARED.approvalMode,
    activeReleaseStatus: OG_MAINNET_SHARED.activeReleaseStatus,
    riskModel: OG_MAINNET_SHARED.riskModel,
    operators: OG_MAINNET_SHARED.operators,
    releaseReviewer: OG_MAINNET_SHARED.releaseReviewer,
    storkAggregator: OG_MAINNET_SHARED.storkAggregator,
    // Both lanes' reviewed runtime configs, lane bindings, databases and Trading image.
    sequencerLeverageEvidence: { required: true, evidence: OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE },
    distinctVerifierQuorumFrom: [input.sibling],
    ids: {
      releasePolicy: `bond-perpdex-${input.name}-release`,
      feePolicy: 'bond-perpdex-og-mainnet-legacy-fees',
      storkPolicy: `bond-perpdex-${input.name}-stork-deployment-prices`,
      productReview: `bond-perpdex-${input.name}-product-vectors`,
      collateralProvenance: `bond-${input.name}-${input.collateral.assetId.toLowerCase()}-product-zero`,
    },
    decisions: OG_MAINNET_SHARED.decisions,
    pins: {
      feeBoundsWei: OG_MAINNET_SHARED.feeBoundsWei,
      contractPacketBase: OG_MAINNET_SHARED.contractPacketBase,
      // Per collateral: each deployment's tuple covers its own provenance id and token.
      normalizedCarriedFieldTupleSha256: carriedFieldTupleSha256({
        provenanceId: `bond-${input.name}-${input.collateral.assetId.toLowerCase()}-product-zero`,
        chainId: OG_MAINNET_CHAIN_ID,
        collateral: {
          address: input.collateral.address,
          symbol: input.collateral.symbol,
          decimals: input.collateral.decimals,
          productId: input.collateral.productId,
        },
        selection: STATIC_PINNED_COLLATERAL_SELECTION,
      }),
      carriedFieldTupleDerivation: 'canonical_json_v1',
      collateralProvenanceSources: {
        bondEnvironments: {
          ...OG_MAINNET_REGISTRY_SOURCE,
          assetId: input.collateral.assetId,
          lendingEnabled: input.lendingEnabled,
          ammEnabled: input.ammEnabled,
        },
        bondSuperApp: input.bondSuperApp,
      },
    },
    files: {
      envFile: `.env.${input.name}.local`,
      products: `${prefix}.products.json`,
      productReview: `${prefix}.product-approval-review.json`,
      collateralProvenance: `${prefix}.collateral-provenance.json`,
      contractBaseline: sharedFiles.contractBaseline,
      feePolicy: sharedFiles.feePolicy,
      releasePolicy: `${prefix}.release-policy.json`,
      storkPolicy: `${prefix}.stork-deployment-policy.json`,
      storkSnapshot: `${prefix}.stork-deployment-snapshot.local.json`,
      redApproval: null,
      releaseAttestation: `${prefix}.release-attestation.local.json`,
      verifierPublicKeys: `${prefix}.verifier-public-keys.json`,
      verifierPrivateKeys: null,
      deploymentIntent: `${prefix}.deployment-intent.local.json`,
    },
    deploymentsDir: `deployments/${OG_MAINNET_CHAIN_ID}/${input.name}`,
  };
}

const OG_MAINNET_SUPER_APP_SOURCE = {
  repository: 'Bond-xyz/bond-super-app',
  commit: '1222b4710b2a4a15f1af2bd70a181a220212d287',
  tree: '2ea4f4ab4e2ba7a6aabd71d69e8f8972ebc6a13d',
  file: 'packages/config/src/generated/registry.ts',
  fileBlob: '4624cd8c4904b2994a3e02464342f4aaeb6851de',
  fileSha256: '281ad15c6437e5cc3a6de1fe548ee929e9ea9eb09f389d845fb398d087994d29',
};

// USDZ registration: bond-super-app PR #1123 head fb482b86 (merged into testnet via
// 64efeef4). The 1222b471 registry above predates USDZ, so USDZ binds its own file.
// og-mainnet-prod assets[USDZ].domains = { lending:false, amm:false, perpdex:false };
// no og-mainnet-prod perpdex domain carries USDZ collateral (that live domain is the
// USDCE private-beta lineage), so the fresh USDZ graph is pending and not enabled.
// Blob = git object id at that commit; fileSha256 = SHA-256 of those exact bytes.
const OG_MAINNET_USDZ_SUPER_APP_SOURCE = {
  repository: 'Bond-xyz/bond-super-app',
  commit: 'fb482b8640f67f23b710b87e429230615700808f',
  tree: 'b1fdefb98dc2e0ac7fd899ca0703494af8b3cd33',
  file: 'packages/config/src/generated/registry.ts',
  fileBlob: '3850aa1d7efeb3a72e7928c4bdec7bd6cc02b418',
  fileSha256: '10c5b01f4e7e4b9049095ad9a07119e328ee21763e5f7f5811ae157cbf0ab44b',
};

export const PERPDEX_NETWORK_PROFILES: Readonly<Record<PerpdexNetworkName, PerpdexNetworkProfile>> = {
  galileo: GALILEO_PROFILE,
  'og-mainnet': ogMainnetProfile({
    name: 'og-mainnet',
    sibling: 'og-mainnet-usdz',
    collateral: {
      assetId: 'USDCE',
      address: '0x1f3aa82227281ca364bfb3d253b0f1af1da6473e',
      symbol: 'USDC.e',
      decimals: 6,
      productId: 0,
    },
    marketQuote: 'USDC',
    lendingEnabled: true,
    ammEnabled: true,
    bondSuperApp: {
      ...OG_MAINNET_SUPER_APP_SOURCE,
      assetId: 'USDCE',
      registryDomains: { lending: true, amm: true, perpdex: false },
      perpdexLifecycle: 'pending_fresh_deploy',
      perpdexEnabled: false,
    },
  }),
  'og-mainnet-usdz': ogMainnetProfile({
    name: 'og-mainnet-usdz',
    sibling: 'og-mainnet',
    collateral: {
      assetId: 'USDZ',
      address: '0xd4d54bd7379e799417563b1bb42426c9bd4ccb2a',
      symbol: 'USDZ',
      decimals: 6,
      productId: 0,
    },
    marketQuote: 'USDZ',
    lendingEnabled: false,
    ammEnabled: false,
    bondSuperApp: {
      ...OG_MAINNET_USDZ_SUPER_APP_SOURCE,
      assetId: 'USDZ',
      registryDomains: { lending: false, amm: false, perpdex: false },
      perpdexLifecycle: 'pending_fresh_deploy',
      perpdexEnabled: false,
    },
  }),
};

export function resolveNetworkProfile(name: string | undefined = process.env[PERPDEX_NETWORK_ENV]) {
  const selected = name === undefined || name.trim() === '' ? DEFAULT_PERPDEX_NETWORK : name.trim();
  if (!Object.prototype.hasOwnProperty.call(PERPDEX_NETWORK_PROFILES, selected)) {
    throw new Error(
      `${PERPDEX_NETWORK_ENV} must be one of ${Object.keys(PERPDEX_NETWORK_PROFILES).join(', ')}; got ${selected}`
    );
  }
  const profile = PERPDEX_NETWORK_PROFILES[selected as PerpdexNetworkName];
  return {
    ...profile,
    collateral: { ...profile.collateral, address: utils.getAddress(profile.collateral.address) },
  } as PerpdexNetworkProfile;
}

// Resolved once per process. Every chain/collateral gate reads this profile.
export const PERPDEX_NETWORK = resolveNetworkProfile();
export const PERPDEX_CHAIN_ID = PERPDEX_NETWORK.chainId;
export const PERPDEX_PROJECT_ID = PERPDEX_NETWORK.projectId;
export const PERPDEX_RELEASE_ID = PERPDEX_NETWORK.releaseId;
export const PERPDEX_COLLATERAL_ADDRESS = PERPDEX_NETWORK.collateral.address;
export const PERPDEX_COLLATERAL_SYMBOL = PERPDEX_NETWORK.collateral.symbol;
export const PERPDEX_COLLATERAL_DECIMALS = PERPDEX_NETWORK.collateral.decimals;

export function deploymentStateFile(
  kind: 'address-plan' | 'prepared' | 'finalization' | 'latest',
  profile: PerpdexNetworkProfile = PERPDEX_NETWORK
): string {
  return `./${profile.deploymentsDir}/${kind}.local.json`;
}

// Galileo-only constants retained for the existing Galileo tests and tooling.
export const GALILEO_CHAIN_ID = GALILEO_PROFILE.chainId;
export const GALILEO_PROJECT_ID = GALILEO_PROFILE.projectId;
export const GALILEO_RELEASE_ID = GALILEO_PROFILE.releaseId;
export const GALILEO_USDCE_ADDRESS = GALILEO_PROFILE.collateral.address;
export const GALILEO_USDCE_SYMBOL = GALILEO_PROFILE.collateral.symbol;
export const GALILEO_USDCE_DECIMALS = GALILEO_PROFILE.collateral.decimals;

export function requireProfileCollateral(value?: string, profile: PerpdexNetworkProfile = PERPDEX_NETWORK): string {
  const canonical = utils.getAddress(profile.collateral.address);
  if (value === undefined || value.trim() === '') return canonical;
  if (!utils.isAddress(value) || utils.getAddress(value) !== canonical) {
    throw new Error(
      `${profile.name} collateral must be existing ${profile.collateral.symbol} ${canonical}; substitutes are forbidden`
    );
  }
  return canonical;
}

export function requireGalileoUsdce(value?: string): string {
  return requireProfileCollateral(value, GALILEO_PROFILE);
}

export function requirePinnedDeployer(value: string, profile: PerpdexNetworkProfile = PERPDEX_NETWORK): string {
  if (!utils.isAddress(value)) throw new Error('deployer must be an address');
  const deployer = utils.getAddress(value);
  const pinned = profile.operators.deployer;
  if (pinned !== null && deployer !== utils.getAddress(pinned)) {
    throw new Error(`${profile.name} deployer must be exactly the pinned deployer ${pinned}`);
  }
  return deployer;
}

// Galileo keeps its historical default (sequencer = deployer when unset). Mainnet
// profiles pin the production sequencer and refuse any other value.
export function resolveSequencer(
  value: string | undefined,
  deployer: string,
  profile: PerpdexNetworkProfile = PERPDEX_NETWORK
): string {
  const pinned = profile.operators.sequencer;
  if (pinned === null) return value || deployer;
  if (!value || !utils.isAddress(value) || utils.getAddress(value) !== utils.getAddress(pinned)) {
    throw new Error(`${profile.name} sequencer must be exactly the pinned production sequencer ${pinned}`);
  }
  return utils.getAddress(pinned);
}

export type ProductConfig = {
  symbol: string;
  productId: number;
  sizeIncrementX18: string;
  minSizeX18: string;
  lpSpreadX18: string;
  risk: {
    longWeightInitial: number;
    shortWeightInitial: number;
    longWeightMaintenance: number;
    shortWeightMaintenance: number;
  };
};

export type DeploymentProductConfig = ProductConfig & {
  risk: ProductConfig['risk'] & { priceX18: string };
};

export type GalileoProducts = {
  chainId: number;
  approved: boolean;
  spreads: string;
  products: ProductConfig[];
};

export type GalileoDeploymentProducts = Omit<GalileoProducts, 'products'> & {
  products: DeploymentProductConfig[];
};

export type VerifierPoint = { x: string; y: string };

export type VerifierConfig = {
  chainId: number;
  signerBitmask: number;
  keys: VerifierPoint[];
};

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as T;

const positive = (value: string, field: string): BigNumber => {
  const parsed = BigNumber.from(value);
  if (parsed.lte(0)) throw new Error(`${field} must be positive`);
  return parsed;
};

export function loadProducts(
  file: string,
  options: { requireApproved?: boolean; profile?: PerpdexNetworkProfile } = {}
): GalileoProducts {
  const profile = options.profile || PERPDEX_NETWORK;
  const config = readJson<GalileoProducts>(file);
  if (config.chainId !== profile.chainId) {
    throw new Error(`product config chainId must be ${profile.chainId}`);
  }
  if (options.requireApproved !== false && !config.approved) {
    throw new Error('product risk/scaling config is not approved; do not weaken this release gate');
  }
  const ids = config.products.map((product) => product.productId);
  if (JSON.stringify(ids) !== JSON.stringify(LAUNCH_PRODUCT_IDS)) {
    throw new Error('launch products must be exactly 2,4,6,8 in order');
  }
  const symbols = config.products.map((product) => product.symbol);
  if (JSON.stringify(symbols) !== JSON.stringify(profile.marketSymbols)) {
    throw new Error(`${profile.name} launch market symbols must be exactly ${profile.marketSymbols.join(',')}`);
  }
  for (const product of config.products) {
    const increment = positive(product.sizeIncrementX18, `${product.symbol}.sizeIncrementX18`);
    const minSize = positive(product.minSizeX18, `${product.symbol}.minSizeX18`);
    if ('priceX18' in product.risk) {
      throw new Error(`${product.symbol} must not contain a static deploy-time priceX18`);
    }
    if (!increment.mod(1_000_000_000).isZero() || !minSize.mod(1_000_000_000).isZero()) {
      throw new Error(`${product.symbol} sizes must preserve audited X18 to X9 storage conversion`);
    }
    const risk = product.risk;
    if (
      risk.longWeightInitial > risk.longWeightMaintenance ||
      risk.shortWeightInitial < risk.shortWeightMaintenance ||
      risk.longWeightInitial < 0 ||
      risk.shortWeightInitial === 2_000_000_000 ||
      risk.shortWeightInitial > profile.riskModel.maxShortWeightInitial
    ) {
      throw new Error(`${product.symbol} risk weights violate audited bounds`);
    }
  }
  return config;
}

export function resolveProductsWithStorkPrices(
  products: GalileoProducts,
  pricesByProductId: ReadonlyMap<number, string>
): GalileoDeploymentProducts {
  const expectedIds = products.products.map((product) => product.productId);
  const suppliedIds = [...pricesByProductId.keys()].sort((left, right) => left - right);
  if (JSON.stringify(suppliedIds) !== JSON.stringify([...expectedIds].sort((left, right) => left - right))) {
    throw new Error('verified Stork prices must cover exactly launch products 2,4,6,8');
  }
  const maxInt128 = BigNumber.from(2).pow(127).sub(1);
  return {
    ...products,
    products: products.products.map((product) => {
      const priceX18 = positive(pricesByProductId.get(product.productId) || '', `${product.symbol} Stork priceX18`);
      if (priceX18.gt(maxInt128)) throw new Error(`${product.symbol} Stork priceX18 exceeds contract int128`);
      return { ...product, risk: { ...product.risk, priceX18: priceX18.toString() } };
    }),
  };
}

function normalizedVerifierKeys(config: VerifierConfig): string[] {
  return config.keys.map((point, index) => {
    const publicKey = utils.hexConcat(['0x04', utils.hexZeroPad(point.x, 32), utils.hexZeroPad(point.y, 32)]);
    try {
      return utils.computePublicKey(publicKey, false).toLowerCase();
    } catch {
      throw new Error(`verifier public key ${index} is not a secp256k1 point`);
    }
  });
}

export function assertDistinctVerifierQuorum(
  config: VerifierConfig,
  profile: PerpdexNetworkProfile = PERPDEX_NETWORK,
  repoRoot = path.resolve(__dirname, '..')
): void {
  const own = new Set(normalizedVerifierKeys(config));
  for (const sibling of profile.distinctVerifierQuorumFrom) {
    const siblingFile = path.resolve(repoRoot, PERPDEX_NETWORK_PROFILES[sibling].files.verifierPublicKeys);
    if (!fs.existsSync(siblingFile)) {
      throw new Error(`cannot prove ${profile.name} verifier quorum is distinct: ${sibling} config is missing`);
    }
    const shared = normalizedVerifierKeys(readJson<VerifierConfig>(siblingFile)).filter((key) => own.has(key));
    if (shared.length > 0) {
      throw new Error(
        `${profile.name} verifier quorum shares ${shared.length} key(s) with ${sibling}; signed batches would replay across Endpoints`
      );
    }
  }
}

export function loadVerifierConfig(
  file: string,
  profile: PerpdexNetworkProfile = PERPDEX_NETWORK,
  repoRoot = path.resolve(__dirname, '..')
): VerifierConfig {
  const config = readJson<VerifierConfig>(file);
  if (config.chainId !== profile.chainId || config.signerBitmask !== 7) {
    throw new Error(`verifier public-key file must target chain ${profile.chainId} and bitmask 7`);
  }
  if (config.keys.length !== 3) {
    throw new Error('audited Endpoint hardcodes bitmask 7; exactly three verifier keys are required');
  }
  const normalizedKeys = normalizedVerifierKeys(config);
  if (new Set(normalizedKeys).size !== normalizedKeys.length) {
    throw new Error('verifier public keys must be three distinct secp256k1 points');
  }
  assertDistinctVerifierQuorum(config, profile, repoRoot);
  return config;
}

export function loadVerifierPoints(file: string): VerifierPoint[] {
  return loadVerifierConfig(file).keys;
}

export function initialPrices(products: DeploymentProductConfig[]): string[] {
  const maxId = Math.max(...products.map((product) => product.productId));
  const prices = Array(maxId + 1).fill('0');
  prices[0] = utils.parseUnits('1', 18).toString();
  for (const product of products) prices[product.productId] = product.risk.priceX18;
  return prices;
}
