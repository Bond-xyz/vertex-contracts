import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BigNumber, utils } from 'ethers';
import {
  PERPDEX_CHAIN_ID,
  PERPDEX_COLLATERAL_ADDRESS,
  PERPDEX_COLLATERAL_DECIMALS,
  PERPDEX_COLLATERAL_SYMBOL,
  carriedFieldTupleSha256,
  PERPDEX_NETWORK,
  PERPDEX_NETWORK_PROFILES,
  PerpdexNetworkProfile,
  SEQUENCER_RESERVED_TRADING_DATABASES,
  SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT,
  SEQUENCER_TRADING_IMAGE_REPOSITORY,
  SequencerLaneEvidence,
} from './deployment-config';

export const BACKEND_PROTOCOL_BASELINE_COMMIT = '1d174da2f130cf6f4f03b29029a002d92acc76f8';
// Retained only for the existing release-attestation field name. This value is
// a reviewed protocol baseline, never the final runtime artifact source.
export const BACKEND_BETA_COMMIT = BACKEND_PROTOCOL_BASELINE_COMMIT;
export const TRACKED_STORK_DEPLOYMENT_POLICY = PERPDEX_NETWORK.files.storkPolicy;
export const TRACKED_COLLATERAL_PROVENANCE = PERPDEX_NETWORK.files.collateralProvenance;
export const DEFAULT_STORK_DEPLOYMENT_SNAPSHOT = PERPDEX_NETWORK.files.storkSnapshot;
export const BLOCKED_STORK_DEPLOYMENT_POLICY_STATUS = 'blocked_pending_reviewed_cross_feed_timestamp_spread';
export const BLOCKED_STORK_COHERENCE_DECISION = 'pending_explicit_red_policy_input';
export const APPROVED_STORK_DEPLOYMENT_POLICY_STATUS = PERPDEX_NETWORK.activeReleaseStatus;
export const APPROVED_STORK_COHERENCE_DECISION = PERPDEX_NETWORK.decisions.storkCoherence;

const STORK_CHECKSUM = '9be7e9f9ed459417d96112a7467bd0b27575a2c7847195c68f805b70ce1795ba';
const NANOS_PER_SECOND = 1_000_000_000n;
const SECP256K1_HALF_ORDER = BigNumber.from('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');

export type StorkFeedPolicy = { pair: string; symbol: string; productId: number; feedId: string };

export type StorkDeploymentPolicy = {
  schemaVersion: number;
  policyId: string;
  status: string;
  chainId: number;
  backend: {
    repository: string;
    releaseCommit: string;
    releaseCommitRole: string;
    runtimeRelease: {
      sourceCommit: string | null;
      artifactManifestSha256: string | null;
      status: string;
    };
    storkBehaviorCommit: string;
    verifierSourceFile: string;
    runtimeConfigFile: string;
  };
  verifier: {
    provider: string;
    restUrl: string;
    aggregatorPublicKey: string;
    aggregatorKeyProvenance?: PerpdexNetworkProfile['storkAggregator']['provenance'];
    calculationAlgorithm: { type: string; version: string; checksum: string };
    maxAgeSeconds: number;
    maxFutureSkewSeconds: number;
  };
  coherence: {
    maxSignedTimestampSpreadSeconds: number | null;
    decisionOwner: string;
    decision: string;
  };
  snapshot: {
    schemaVersion: number;
    tracked: boolean;
    defaultFile: string;
    priceEncoding: string;
    rawSignedProofRequired: boolean;
    observationBlockRequired: boolean;
  };
  feeds: StorkFeedPolicy[];
};

export type StorkSignedFeed = StorkFeedPolicy & {
  envelopeTimestampNs: string;
  assetId: string;
  signatureType: string;
  priceX18: string;
  proof: {
    publicKey: string;
    encodedAssetId: string;
    signedTimestampNs: string;
    messageHash: string;
    signature: { r: string; s: string; v: number };
    publisherMerkleRoot: string;
    calculationAlgorithm: { type: string; version: string; checksum: string };
  };
};

export type StorkDeploymentSnapshot = {
  schemaVersion: number;
  chainId: number;
  backendProtocolBaselineCommit: string;
  policySha256: string;
  capturedAtNs: string;
  observationBlock: { number: number; hash: string; timestamp: number };
  feeds: StorkSignedFeed[];
};

export type VerifiedStorkFeed = StorkSignedFeed & { signedTimestampNs: string };

export type VerifiedStorkDeploymentSnapshot = Omit<StorkDeploymentSnapshot, 'feeds'> & {
  feeds: VerifiedStorkFeed[];
  signedTimestampSpreadNs: string;
};

export type CollateralProvenance = {
  schemaVersion: number;
  provenanceId: string;
  chainId: number;
  collateral: { address: string; symbol: string; decimals: number; productId: number };
  selection: {
    mode: string;
    runtimeRegistryLookup: boolean;
    aliasSubstitutionAllowed: boolean;
    mockOrReplacementDeploymentAllowed: boolean;
    provenanceOnly: boolean;
  };
  normalizedCarriedFieldTupleSha256: string;
  sources: {
    bondEnvironments: {
      repository: string;
      commit: string;
      tree: string;
      file: string;
      fileBlob: string;
      fileSha256: string;
      perpdexFile: string;
      perpdexFileSha256: string;
      assetId: string;
      lendingEnabled: boolean;
      ammEnabled: boolean;
      provisionMode: string;
      autoDeploy: boolean;
    };
    bondSuperApp: {
      repository: string;
      commit: string;
      tree: string;
      file: string;
      fileBlob: string;
      fileSha256: string;
      assetId: string;
      registryDomains: { lending: boolean; amm: boolean; perpdex: boolean };
      perpdexLifecycle: string;
      perpdexEnabled: boolean;
    };
  };
};

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as T;

export function sha256File(file: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.resolve(file)))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function storkSnapshotSha256(snapshot: StorkDeploymentSnapshot): string {
  return crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function requireGitObject(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a 40-character Git object`);
}

function requireSha256(value: string, label: string): string {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new Error(`${label} must be a SHA-256`);
  return normalized.toLowerCase();
}

function requireDecimalInteger(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive exact decimal integer string`);
  return BigInt(value);
}

function requireBytes32(value: string, label: string): string {
  if (!utils.isHexString(value, 32)) throw new Error(`${label} must be exactly 32 bytes`);
  return value.toLowerCase();
}

export function validateStorkDeploymentPolicy(policy: StorkDeploymentPolicy): StorkDeploymentPolicy {
  if (
    policy.schemaVersion !== 1 ||
    policy.policyId !== PERPDEX_NETWORK.ids.storkPolicy ||
    policy.chainId !== PERPDEX_CHAIN_ID ||
    policy.backend.repository !== 'Bond-xyz/perpdex-rust-backend' ||
    policy.backend.releaseCommit !== BACKEND_BETA_COMMIT ||
    policy.backend.releaseCommitRole !== 'reviewed_protocol_baseline_only' ||
    policy.backend.storkBehaviorCommit !== '6576efbbfaa74a0babe442be1f8aa029912893f2' ||
    policy.backend.verifierSourceFile !== 'services/price-oracle/src/stork.rs' ||
    policy.backend.runtimeConfigFile !== 'services/price-oracle/config/default.toml'
  ) {
    throw new Error('Stork deployment policy is not bound to the reviewed backend protocol baseline');
  }
  requireGitObject(policy.backend.releaseCommit, 'backend protocol baseline commit');
  requireGitObject(policy.backend.storkBehaviorCommit, 'Stork behavior commit');
  const runtimeRelease = policy.backend.runtimeRelease;
  const runtimeReleaseUnset = runtimeRelease.sourceCommit === null && runtimeRelease.artifactManifestSha256 === null;
  if (
    runtimeReleaseUnset
      ? runtimeRelease.status !== 'pending_final_immutable_backend_release'
      : runtimeRelease.status !== 'reviewed_immutable_backend_release' ||
        runtimeRelease.sourceCommit === null ||
        runtimeRelease.artifactManifestSha256 === null
  ) {
    throw new Error('runtime backend source and immutable artifact manifest must resolve together under review');
  }
  if (!runtimeReleaseUnset) {
    requireGitObject(runtimeRelease.sourceCommit!, 'runtime backend source commit');
    requireSha256(runtimeRelease.artifactManifestSha256!, 'runtime backend artifact manifest SHA-256');
    if (runtimeRelease.sourceCommit!.toLowerCase() === BACKEND_PROTOCOL_BASELINE_COMMIT) {
      throw new Error('reviewed protocol baseline cannot be reused as the final runtime backend source');
    }
  }
  const verifier = policy.verifier;
  if (
    verifier.provider !== 'stork' ||
    verifier.restUrl !== 'https://rest.jp.stork-oracle.network' ||
    utils.getAddress(verifier.aggregatorPublicKey) !== utils.getAddress(PERPDEX_NETWORK.storkAggregator.current) ||
    JSON.stringify(verifier.aggregatorKeyProvenance ?? null) !==
      JSON.stringify(PERPDEX_NETWORK.storkAggregator.provenance) ||
    verifier.calculationAlgorithm.type !== 'median' ||
    verifier.calculationAlgorithm.version !== 'v1' ||
    requireSha256(verifier.calculationAlgorithm.checksum, 'Stork calculation checksum') !== STORK_CHECKSUM ||
    verifier.maxAgeSeconds !== 30 ||
    verifier.maxFutureSkewSeconds !== 2
  ) {
    throw new Error('Stork deployment policy verifier does not match the reviewed protocol baseline constraints');
  }
  if (
    policy.snapshot.schemaVersion !== 1 ||
    policy.snapshot.tracked !== false ||
    policy.snapshot.defaultFile !== DEFAULT_STORK_DEPLOYMENT_SNAPSHOT ||
    policy.snapshot.priceEncoding !== 'positive_signed_int256_x18' ||
    policy.snapshot.rawSignedProofRequired !== true ||
    policy.snapshot.observationBlockRequired !== true
  ) {
    throw new Error('Stork deployment snapshot policy must require untracked exact signed evidence');
  }
  const [btc, eth, sol, zeroG] = PERPDEX_NETWORK.marketSymbols;
  const expected = [
    ['BTC/USD', btc, 2, 'BTCUSD'],
    ['ETH/USD', eth, 4, 'ETHUSD'],
    ['SOL/USD', sol, 6, 'SOLUSD'],
    ['0G/USD', zeroG, 8, '0GUSD'],
  ];
  const actual = policy.feeds.map((feed) => [feed.pair, feed.symbol, feed.productId, feed.feedId]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Stork deployment policy must contain exact BTC/ETH/SOL/0G feed mappings');
  }
  if (
    policy.coherence.maxSignedTimestampSpreadSeconds !== null &&
    (!Number.isSafeInteger(policy.coherence.maxSignedTimestampSpreadSeconds) ||
      policy.coherence.maxSignedTimestampSpreadSeconds <= 0 ||
      policy.coherence.maxSignedTimestampSpreadSeconds > verifier.maxAgeSeconds)
  ) {
    throw new Error(
      'cross-feed signed timestamp spread must be null or a positive safe integer no greater than Stork max age'
    );
  }
  if (policy.coherence.decisionOwner !== 'Red') {
    throw new Error('cross-feed signed timestamp spread is a Red-only release decision');
  }
  if (
    policy.coherence.maxSignedTimestampSpreadSeconds === null &&
    (policy.status !== BLOCKED_STORK_DEPLOYMENT_POLICY_STATUS ||
      policy.coherence.decision !== BLOCKED_STORK_COHERENCE_DECISION)
  ) {
    throw new Error('unset cross-feed signed timestamp spread must remain explicitly fail-closed pending Red');
  }
  if (
    policy.coherence.maxSignedTimestampSpreadSeconds !== null &&
    (policy.status !== APPROVED_STORK_DEPLOYMENT_POLICY_STATUS ||
      policy.coherence.decision !== APPROVED_STORK_COHERENCE_DECISION)
  ) {
    throw new Error('reviewed cross-feed signed timestamp spread must use the exact approved Galileo testnet state');
  }
  return policy;
}

export function loadTrackedStorkDeploymentPolicy(repoRoot = path.resolve(__dirname, '..')): {
  policy: StorkDeploymentPolicy;
  policyFile: string;
  policySha256: string;
} {
  const policyFile = path.resolve(repoRoot, TRACKED_STORK_DEPLOYMENT_POLICY);
  const policy = validateStorkDeploymentPolicy(readJson<StorkDeploymentPolicy>(policyFile));
  return { policy, policyFile, policySha256: sha256File(policyFile) };
}

function unresolvedPins(value: unknown, prefix: string): string[] {
  if (value === null) return [prefix];
  if (typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    unresolvedPins(child, `${prefix}.${key}`)
  );
}

// Operator-fill fields are tracked as null in both the profile pins and the
// provenance file; any remaining null keeps every release gate closed.
export function unresolvedCollateralProvenancePins(profile: PerpdexNetworkProfile = PERPDEX_NETWORK): string[] {
  return [
    ...unresolvedPins(profile.pins.normalizedCarriedFieldTupleSha256, 'normalizedCarriedFieldTupleSha256'),
    ...unresolvedPins(profile.pins.collateralProvenanceSources, 'sources'),
  ];
}

export function loadTrackedCollateralProvenance(
  repoRoot = path.resolve(__dirname, '..'),
  options: { allowUnresolved?: boolean } = {}
): {
  provenance: CollateralProvenance;
  provenanceFile: string;
  provenanceSha256: string;
  unresolved: string[];
} {
  const provenanceFile = path.resolve(repoRoot, TRACKED_COLLATERAL_PROVENANCE);
  const provenance = readJson<CollateralProvenance>(provenanceFile);
  const pins = PERPDEX_NETWORK.pins;
  if (
    provenance.schemaVersion !== 1 ||
    provenance.provenanceId !== PERPDEX_NETWORK.ids.collateralProvenance ||
    provenance.chainId !== PERPDEX_CHAIN_ID ||
    utils.getAddress(provenance.collateral.address) !== PERPDEX_COLLATERAL_ADDRESS ||
    provenance.collateral.symbol !== PERPDEX_COLLATERAL_SYMBOL ||
    provenance.collateral.decimals !== PERPDEX_COLLATERAL_DECIMALS ||
    provenance.collateral.productId !== 0 ||
    provenance.selection.mode !== 'static_pinned' ||
    provenance.selection.runtimeRegistryLookup !== false ||
    provenance.selection.aliasSubstitutionAllowed !== false ||
    provenance.selection.mockOrReplacementDeploymentAllowed !== false ||
    provenance.selection.provenanceOnly !== true
  ) {
    throw new Error(
      `collateral provenance must statically pin exact ${PERPDEX_NETWORK.name} ${PERPDEX_COLLATERAL_SYMBOL} product 0`
    );
  }
  if (
    provenance.normalizedCarriedFieldTupleSha256 !== pins.normalizedCarriedFieldTupleSha256 ||
    (pins.carriedFieldTupleDerivation === 'canonical_json_v1' &&
      provenance.normalizedCarriedFieldTupleSha256 !==
        carriedFieldTupleSha256({
          provenanceId: provenance.provenanceId,
          chainId: provenance.chainId,
          collateral: provenance.collateral,
          selection: provenance.selection,
        }))
  ) {
    throw new Error('normalized collateral carried-field tuple binding mismatch');
  }
  if (
    canonicalJson(provenance.sources.bondEnvironments) !==
    canonicalJson(pins.collateralProvenanceSources.bondEnvironments)
  ) {
    throw new Error('bond-environments collateral provenance mismatch');
  }
  if (canonicalJson(provenance.sources.bondSuperApp) !== canonicalJson(pins.collateralProvenanceSources.bondSuperApp)) {
    throw new Error('Bond Super App collateral provenance mismatch');
  }
  const unresolved = unresolvedCollateralProvenancePins();
  if (unresolved.length > 0 && options.allowUnresolved !== true) {
    throw new Error(`collateral provenance has unresolved operator-fill fields: ${unresolved.join(', ')}`);
  }
  return { provenance, provenanceFile, provenanceSha256: sha256File(provenanceFile), unresolved };
}

export function verifyStorkSignedFeed(
  feed: StorkSignedFeed,
  expected: StorkFeedPolicy,
  verifier: StorkDeploymentPolicy['verifier']
): VerifiedStorkFeed {
  if (
    feed.pair !== expected.pair ||
    feed.symbol !== expected.symbol ||
    feed.productId !== expected.productId ||
    feed.feedId !== expected.feedId ||
    feed.assetId !== expected.feedId ||
    feed.signatureType !== 'evm'
  ) {
    throw new Error(`signed Stork feed identity mismatch for ${expected.feedId}`);
  }
  requireDecimalInteger(feed.envelopeTimestampNs, `${expected.feedId} envelope timestamp`);
  const price = requireDecimalInteger(feed.priceX18, `${expected.feedId} priceX18`);
  if (price >= 2n ** 255n) throw new Error(`${expected.feedId} priceX18 exceeds positive signed int256`);
  const signedTimestamp = requireDecimalInteger(feed.proof.signedTimestampNs, `${expected.feedId} signed timestamp`);
  const publicKey = utils.getAddress(feed.proof.publicKey);
  if (PERPDEX_NETWORK.storkAggregator.previousReplayOnly.some((key) => utils.getAddress(key) === publicKey)) {
    throw new Error(`${expected.feedId} is signed by a previous replay-only Stork aggregator key`);
  }
  if (
    publicKey !== utils.getAddress(verifier.aggregatorPublicKey) ||
    publicKey !== utils.getAddress(PERPDEX_NETWORK.storkAggregator.current)
  ) {
    throw new Error(`${expected.feedId} Stork aggregator does not match the reviewed protocol baseline`);
  }
  const encodedAssetId = requireBytes32(feed.proof.encodedAssetId, `${expected.feedId} encoded asset ID`);
  if (encodedAssetId !== utils.keccak256(utils.toUtf8Bytes(expected.feedId)).toLowerCase()) {
    throw new Error(`${expected.feedId} encoded asset ID mismatch`);
  }
  const algorithm = feed.proof.calculationAlgorithm;
  if (
    algorithm.type !== verifier.calculationAlgorithm.type ||
    algorithm.version !== verifier.calculationAlgorithm.version ||
    requireSha256(algorithm.checksum, `${expected.feedId} calculation checksum`) !==
      requireSha256(verifier.calculationAlgorithm.checksum, 'policy calculation checksum')
  ) {
    throw new Error(`${expected.feedId} Stork calculation algorithm mismatch`);
  }
  const publisherMerkleRoot = requireBytes32(feed.proof.publisherMerkleRoot, `${expected.feedId} publisher root`);
  const checksum = `0x${requireSha256(algorithm.checksum, `${expected.feedId} checksum`)}`;
  const messageHash = utils.keccak256(
    utils.solidityPack(
      ['address', 'bytes32', 'uint256', 'int256', 'bytes32', 'bytes32'],
      [publicKey, encodedAssetId, signedTimestamp.toString(), price.toString(), publisherMerkleRoot, checksum]
    )
  );
  if (requireBytes32(feed.proof.messageHash, `${expected.feedId} message hash`) !== messageHash.toLowerCase()) {
    throw new Error('Stork message hash does not match the signed proof');
  }
  const { r, s, v } = feed.proof.signature;
  if (!utils.isHexString(r, 32) || !utils.isHexString(s, 32) || (v !== 27 && v !== 28)) {
    throw new Error(`${expected.feedId} Stork signature encoding is invalid`);
  }
  const rValue = BigNumber.from(r);
  const sValue = BigNumber.from(s);
  if (rValue.isZero() || sValue.isZero() || sValue.gt(SECP256K1_HALF_ORDER)) {
    throw new Error(`${expected.feedId} Stork signature is non-canonical`);
  }
  let recovered: string;
  try {
    recovered = utils.verifyMessage(utils.arrayify(messageHash), utils.joinSignature({ r, s, v }));
  } catch {
    throw new Error(`${expected.feedId} Stork signature recovery failed`);
  }
  if (utils.getAddress(recovered) !== publicKey) {
    throw new Error(`${expected.feedId} Stork signature was not produced by the pinned aggregator`);
  }
  return { ...feed, signedTimestampNs: signedTimestamp.toString() };
}

export function validateStorkDeploymentSnapshot(
  snapshot: StorkDeploymentSnapshot,
  policy: StorkDeploymentPolicy,
  policySha256: string
): VerifiedStorkDeploymentSnapshot {
  validateStorkDeploymentPolicy(policy);
  const maxSpreadSeconds = policy.coherence.maxSignedTimestampSpreadSeconds;
  if (maxSpreadSeconds === null) {
    throw new Error('cross-feed signed timestamp spread policy is unresolved; deployment remains blocked');
  }
  if (
    snapshot.schemaVersion !== policy.snapshot.schemaVersion ||
    snapshot.chainId !== PERPDEX_CHAIN_ID ||
    snapshot.backendProtocolBaselineCommit !== BACKEND_PROTOCOL_BASELINE_COMMIT ||
    requireSha256(snapshot.policySha256, 'snapshot policy SHA-256') !== requireSha256(policySha256, 'policy SHA-256')
  ) {
    throw new Error('Stork deployment snapshot identity or accepted-beta binding mismatch');
  }
  requireDecimalInteger(snapshot.capturedAtNs, 'snapshot capture timestamp');
  if (
    !Number.isSafeInteger(snapshot.observationBlock.number) ||
    snapshot.observationBlock.number <= 0 ||
    !utils.isHexString(snapshot.observationBlock.hash, 32) ||
    !Number.isSafeInteger(snapshot.observationBlock.timestamp) ||
    snapshot.observationBlock.timestamp <= 0
  ) {
    throw new Error('Stork deployment snapshot observation block is invalid');
  }
  assertStorkSnapshotObservationTime(snapshot, policy);
  if (snapshot.feeds.length !== policy.feeds.length) {
    throw new Error('Stork deployment snapshot must contain exactly four launch feeds');
  }
  const feeds = policy.feeds.map((expected, index) =>
    verifyStorkSignedFeed(snapshot.feeds[index], expected, policy.verifier)
  );
  const timestamps = feeds.map((feed) => BigInt(feed.signedTimestampNs));
  const minimum = timestamps.reduce((left, right) => (left < right ? left : right));
  const maximum = timestamps.reduce((left, right) => (left > right ? left : right));
  const spread = maximum - minimum;
  if (spread > BigInt(maxSpreadSeconds) * NANOS_PER_SECOND) {
    throw new Error('signed Stork feed timestamps exceed the reviewed cross-feed spread');
  }
  const verified = { ...snapshot, feeds, signedTimestampSpreadNs: spread.toString() };
  const capturedAtNs = BigInt(snapshot.capturedAtNs);
  assertStorkDeploymentSnapshotFresh(verified, policy, capturedAtNs);
  return verified;
}

export function assertStorkSnapshotObservationTime(
  snapshot: StorkDeploymentSnapshot,
  policy: StorkDeploymentPolicy
): void {
  const capturedAtNs = requireDecimalInteger(snapshot.capturedAtNs, 'snapshot capture timestamp');
  const blockTimestampNs = BigInt(snapshot.observationBlock.timestamp) * NANOS_PER_SECOND;
  const maxFutureNs = BigInt(policy.verifier.maxFutureSkewSeconds) * NANOS_PER_SECOND;
  const maxAgeNs = BigInt(policy.verifier.maxAgeSeconds) * NANOS_PER_SECOND;
  if (blockTimestampNs > capturedAtNs + maxFutureNs) {
    throw new Error('snapshot observation block exceeds the accepted future skew from capture time');
  }
  if (capturedAtNs - blockTimestampNs > maxAgeNs) {
    throw new Error('snapshot observation block is too old at capture time');
  }
}

export function assertStorkDeploymentSnapshotFresh(
  snapshot: VerifiedStorkDeploymentSnapshot,
  policy: StorkDeploymentPolicy,
  nowNs = BigInt(Date.now()) * 1_000_000n
): void {
  const maxAgeNs = BigInt(policy.verifier.maxAgeSeconds) * NANOS_PER_SECOND;
  const maxFutureNs = BigInt(policy.verifier.maxFutureSkewSeconds) * NANOS_PER_SECOND;
  for (const feed of snapshot.feeds) {
    const signed = BigInt(feed.signedTimestampNs);
    if (signed > nowNs + maxFutureNs) throw new Error(`${feed.feedId || 'Stork feed'} exceeds future skew`);
    if (nowNs - signed > maxAgeNs) throw new Error(`${feed.feedId || 'Stork feed'} signed price is stale`);
  }
}

export function assertStorkObservationBlock(
  snapshot: VerifiedStorkDeploymentSnapshot,
  block: { number: number; hash?: string | null; timestamp: number }
): void {
  if (
    block.number !== snapshot.observationBlock.number ||
    !block.hash ||
    block.hash.toLowerCase() !== snapshot.observationBlock.hash.toLowerCase() ||
    block.timestamp !== snapshot.observationBlock.timestamp
  ) {
    throw new Error('live Galileo observation block does not match the signed Stork snapshot evidence');
  }
}

export function loadAndVerifyStorkDeploymentSnapshot(input: {
  policyFile?: string;
  snapshotFile?: string;
  repoRoot?: string;
}): {
  policy: StorkDeploymentPolicy;
  policyFile: string;
  policySha256: string;
  snapshot: VerifiedStorkDeploymentSnapshot;
  snapshotFile: string;
  snapshotSha256: string;
} {
  const repoRoot = input.repoRoot || path.resolve(__dirname, '..');
  const tracked = loadTrackedStorkDeploymentPolicy(repoRoot);
  const policyFile = path.resolve(input.policyFile || tracked.policyFile);
  if (policyFile !== tracked.policyFile)
    throw new Error('Stork deployment policy must be the tracked repository artifact');
  const snapshotFile = path.resolve(input.snapshotFile || path.join(repoRoot, DEFAULT_STORK_DEPLOYMENT_SNAPSHOT));
  if (!fs.existsSync(snapshotFile)) {
    throw new Error(`fresh signed Stork deployment snapshot is unavailable: ${snapshotFile}`);
  }
  const snapshot = validateStorkDeploymentSnapshot(
    readJson<StorkDeploymentSnapshot>(snapshotFile),
    tracked.policy,
    tracked.policySha256
  );
  return { ...tracked, snapshot, snapshotFile, snapshotSha256: storkSnapshotSha256(snapshot) };
}

export type GalileoStaticReleasePolicy = ReturnType<typeof loadTrackedStorkDeploymentPolicy> & {
  collateralProvenance: CollateralProvenance;
  collateralProvenanceFile: string;
  collateralProvenanceSha256: string;
};

const DEFAULT_QUOTE_DOMAIN = 'USDCE';
const SAFE_REPO_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const POSTGRES_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
// Cloud SQL IAM user, URL-encoded (`<sa>%40<project>.iam`), proxy on loopback, no password.
const IAM_DATABASE_URL =
  /^postgresql:\/\/([a-z][a-z0-9-]*%40[a-z][a-z0-9-]*\.iam)@127\.0\.0\.1:5432\/([a-z][a-z0-9_]*)\?sslmode=disable$/;

const safeRepoPath = (file: unknown): file is string =>
  typeof file === 'string' && SAFE_REPO_PATH.test(file) && !file.split('/').some((part) => part === '..');

/**
 * Fail-closed sequencer leverage gate. Mainnet needs, for every lane (this profile
 * and each distinct-quorum sibling): the reviewed runtime config bytes, the lane's
 * workload environment (BOND_PERPS_ENV, quote domain, its own database) and the
 * immutable Trading image it boots. Unresolved (null) values are reported by name.
 */
export function assertSequencerLeverageEvidence(profile: PerpdexNetworkProfile): void {
  const gate = profile.sequencerLeverageEvidence;
  if (!gate.required) {
    // Only the tracked testnet may skip the gate; any externally reviewed
    // (mainnet) profile that turns it off is refused, not silently passed.
    if (profile.approvalMode !== 'tracked_red_testnet_approval') {
      throw new Error(`${profile.name} sequencer leverage evidence gate must stay required`);
    }
    return;
  }
  const evidence = gate.evidence;
  if (evidence === null) {
    throw new Error(
      `${profile.name} backend sequencer ${profile.riskModel.maximumLeverage}x runtime config evidence is unresolved`
    );
  }
  requireGitObject(evidence.commit, 'sequencer runtime config commit');
  requireGitObject(evidence.tree, 'sequencer runtime config tree');
  const lanes = evidence.lanes.map((lane) => lane.deployment).sort();
  const expectedLanes = [profile.name, ...profile.distinctVerifierQuorumFrom].sort();
  if (
    typeof evidence.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(evidence.repository) ||
    evidence.maxLeverage !== Number(profile.riskModel.maximumLeverage) ||
    !Number.isSafeInteger(evidence.shortOpeningCollateralPpb) ||
    evidence.shortOpeningCollateralPpb < profile.riskModel.weights.shortWeightInitial - 1_000_000_000 ||
    evidence.shortAdmissionBasis !== 'post_fill_initial_health_at_oracle_mark' ||
    evidence.feesReservedSeparately !== true ||
    JSON.stringify(lanes) !== JSON.stringify(expectedLanes) ||
    evidence.lanes.some(
      (lane) =>
        !Array.isArray(lane.files) ||
        lane.files.length === 0 ||
        new Set(lane.files.map((file) => file.path)).size !== lane.files.length ||
        lane.files.some((file) => !safeRepoPath(file.path))
    )
  ) {
    throw new Error(`${profile.name} sequencer runtime config evidence does not preserve the reviewed leverage cap`);
  }
  for (const lane of evidence.lanes) {
    for (const file of lane.files) {
      requireGitObject(file.blob, `${lane.deployment} ${file.path} blob`);
      requireSha256(file.sha256, `${lane.deployment} ${file.path} SHA-256`);
    }
  }
  assertSequencerLaneBindings(profile, evidence.lanes);
}

function assertSequencerLaneBindings(profile: PerpdexNetworkProfile, lanes: readonly SequencerLaneEvidence[]): void {
  const unresolved: string[] = [];
  const configs = new Map<string, string>();
  const configBytes = new Map<string, string>();
  const databases = new Map<string, string>();
  const iamUsers = new Map<string, string>();
  for (const lane of lanes) {
    const id = `${profile.name} sequencer lane ${lane.deployment}`;
    const laneProfile = PERPDEX_NETWORK_PROFILES[lane.deployment];
    const mismatch = (what: string): never => {
      throw new Error(`${id} ${what}`);
    };
    // Runtime config: one listed file, inside this lane's own directory.
    const runtime =
      (safeRepoPath(lane.runtimeConfigPath) && lane.files.find((file) => file.path === lane.runtimeConfigPath)) ||
      mismatch('runtime config is not one of its reviewed files');
    if (!lane.runtimeConfigPath.split('/').slice(0, -1).includes(lane.deployment)) {
      mismatch(`runtime config ${lane.runtimeConfigPath} is not under a ${lane.deployment} lane directory`);
    }
    if (configs.has(lane.runtimeConfigPath) || configBytes.has(runtime.blob)) {
      mismatch(
        `runtime config is shared with lane ${configs.get(lane.runtimeConfigPath) ?? configBytes.get(runtime.blob)}`
      );
    }
    configs.set(lane.runtimeConfigPath, lane.deployment);
    configBytes.set(runtime.blob, lane.deployment);

    // Workload environment: production, this lane's own quote domain.
    const env = lane.environment;
    if (env === null || typeof env !== 'object') mismatch('workload environment is missing');
    if (env.bondPerpsEnv !== 'prod') mismatch(`BOND_PERPS_ENV must be prod, not ${JSON.stringify(env.bondPerpsEnv)}`);
    if (env.quoteDomain !== laneProfile.collateral.assetId) {
      mismatch(
        `quote domain ${JSON.stringify(env.quoteDomain)} does not match its collateral ${
          laneProfile.collateral.assetId
        }`
      );
    }
    if (env.separateQuoteBooksEnabled !== (env.quoteDomain !== DEFAULT_QUOTE_DOMAIN)) {
      mismatch('PERPDEX_SEPARATE_QUOTE_BOOKS_ENABLED must be true exactly for a non-USDCE quote domain');
    }
    if (env.database === null) {
      unresolved.push(`${lane.deployment} DATABASE_URL identity`);
    } else {
      const { name, iamUser, url } = env.database;
      const parsed = typeof url === 'string' ? IAM_DATABASE_URL.exec(url) : null;
      if (
        typeof name !== 'string' ||
        !POSTGRES_IDENTIFIER.test(name) ||
        parsed === null ||
        parsed[1] !== iamUser ||
        parsed[2] !== name
      ) {
        mismatch('DATABASE_URL is not a passwordless Cloud SQL IAM URL for its named database');
      }
      if (SEQUENCER_RESERVED_TRADING_DATABASES.includes(name)) {
        mismatch(`database ${name} belongs to the live private-beta lineage`);
      }
      if (databases.has(name)) mismatch(`database ${name} is shared with lane ${databases.get(name)}`);
      if (iamUsers.has(iamUser)) mismatch(`database IAM user is shared with lane ${iamUsers.get(iamUser)}`);
      databases.set(name, lane.deployment);
      iamUsers.set(iamUser, lane.deployment);
    }

    // Immutable Trading artifact at or after the engine floor.
    const artifact = lane.tradingArtifact;
    if (artifact === null || typeof artifact !== 'object') mismatch('Trading artifact is missing');
    if (artifact.repository !== SEQUENCER_TRADING_IMAGE_REPOSITORY) {
      mismatch(`Trading image repository must be ${SEQUENCER_TRADING_IMAGE_REPOSITORY}`);
    }
    const artifactFields = [artifact.digest, artifact.sourceCommit, artifact.sourceTree, artifact.publicationRunId];
    if (artifactFields.some((value) => value === null)) {
      if (artifactFields.some((value) => value !== null)) {
        mismatch(
          'Trading artifact is partially resolved; digest, source commit, tree and publication run bind together'
        );
      }
      unresolved.push(
        `${lane.deployment} Trading image digest (>= ${SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT.slice(0, 8)})`
      );
      continue;
    }
    if (typeof artifact.digest !== 'string' || !IMAGE_DIGEST.test(artifact.digest)) {
      mismatch('Trading image digest must be sha256:<64 lowercase hex>');
    }
    requireGitObject(String(artifact.sourceCommit), `${lane.deployment} Trading image source commit`);
    requireGitObject(String(artifact.sourceTree), `${lane.deployment} Trading image source tree`);
    if (!/^[1-9][0-9]{0,19}$/.test(String(artifact.publicationRunId))) {
      mismatch('Trading image publication run must be an Actions run id');
    }
  }
  if (unresolved.length > 0) {
    throw new Error(`${profile.name} sequencer lane evidence is unresolved: ${unresolved.join('; ')}`);
  }
}

export function collectGalileoStaticReleasePolicy(input: { repoRoot?: string } = {}): GalileoStaticReleasePolicy {
  assertSequencerLeverageEvidence(PERPDEX_NETWORK);
  const repoRoot = input.repoRoot || path.resolve(__dirname, '..');
  const tracked = loadTrackedStorkDeploymentPolicy(repoRoot);
  if (tracked.policy.coherence.maxSignedTimestampSpreadSeconds === null) {
    throw new Error('cross-feed signed timestamp spread policy is unresolved; release preparation remains blocked');
  }
  if (
    tracked.policy.backend.runtimeRelease.sourceCommit === null ||
    tracked.policy.backend.runtimeRelease.artifactManifestSha256 === null
  ) {
    throw new Error(
      'final immutable backend artifact/source binding is unresolved; release preparation remains blocked'
    );
  }
  const collateral = loadTrackedCollateralProvenance(repoRoot);
  return {
    ...tracked,
    collateralProvenance: collateral.provenance,
    collateralProvenanceFile: collateral.provenanceFile,
    collateralProvenanceSha256: collateral.provenanceSha256,
  };
}

export type GalileoStorkReleasePreflight = ReturnType<typeof loadAndVerifyStorkDeploymentSnapshot> & {
  collateralProvenance: CollateralProvenance;
  collateralProvenanceFile: string;
  collateralProvenanceSha256: string;
};

export function collectGalileoStorkReleasePreflight(
  input: {
    policyFile?: string;
    snapshotFile?: string;
    repoRoot?: string;
    nowNs?: bigint;
    requireFresh?: boolean;
  } = {}
): GalileoStorkReleasePreflight {
  const repoRoot = input.repoRoot || path.resolve(__dirname, '..');
  // Resolve the tracked policy first so an unset coherence decision stops even
  // before looking for dynamic evidence or touching a provider.
  const staticPolicy = collectGalileoStaticReleasePolicy({ repoRoot });
  const verified = loadAndVerifyStorkDeploymentSnapshot({
    policyFile: input.policyFile,
    snapshotFile: input.snapshotFile,
    repoRoot,
  });
  if (input.requireFresh !== false) {
    assertStorkDeploymentSnapshotFresh(verified.snapshot, verified.policy, input.nowNs);
  }
  assertNoStorkSecretMaterial(verified.snapshot);
  return {
    ...verified,
    collateralProvenance: staticPolicy.collateralProvenance,
    collateralProvenanceFile: staticPolicy.collateralProvenanceFile,
    collateralProvenanceSha256: staticPolicy.collateralProvenanceSha256,
  };
}

export async function executeAfterGalileoStorkPreflight<TResult>(
  verify: () => GalileoStorkReleasePreflight,
  providerOrTransactionAction: (evidence: GalileoStorkReleasePreflight) => Promise<TResult>
): Promise<TResult> {
  const evidence = verify();
  return providerOrTransactionAction(evidence);
}

type RawStorkPriceData = {
  timestamp: string;
  asset_id: string;
  signature_type: string;
  price: string;
  stork_signed_price: {
    public_key: string;
    encoded_asset_id: string;
    price: string;
    timestamped_signature: {
      signature: { r: string; s: string; v: string | number };
      timestamp: string;
      msg_hash: string;
    };
    publisher_merkle_root: string;
    calculation_alg: { type: string; version: string; checksum: string };
  };
};

function parseExactRawStorkResponse(raw: string): Record<string, RawStorkPriceData> {
  const exact = raw.replace(/("timestamp"\s*:\s*)([0-9]{16,})(?=\s*[,}])/g, '$1"$2"');
  const parsed = JSON.parse(exact) as { data: { value?: Record<string, RawStorkPriceData> } & Record<string, unknown> };
  const direct = parsed.data?.value || (parsed.data as unknown as Record<string, RawStorkPriceData>);
  if (!direct || typeof direct !== 'object') throw new Error('raw Stork response has no data map');
  return direct;
}

function signatureV(value: string | number): number {
  if (typeof value === 'number') return value;
  return value.startsWith('0x') || value.startsWith('0X') ? Number.parseInt(value.slice(2), 16) : Number(value);
}

export function createStorkDeploymentSnapshotFromRaw(input: {
  rawResponseText: string;
  observationBlock: { number: number; hash: string; timestamp: number };
  capturedAtNs: string;
  policy: StorkDeploymentPolicy;
  policySha256: string;
}): StorkDeploymentSnapshot {
  const data = parseExactRawStorkResponse(input.rawResponseText);
  const feeds = input.policy.feeds.map((expected) => {
    const raw = data[expected.feedId];
    if (!raw) throw new Error(`raw Stork response is missing ${expected.feedId}`);
    if (raw.asset_id !== expected.feedId) {
      throw new Error(`raw Stork response asset_id mismatch for ${expected.feedId}`);
    }
    const signed = raw.stork_signed_price;
    if (raw.price !== signed.price) throw new Error(`${expected.feedId} envelope/signed price mismatch`);
    return {
      ...expected,
      envelopeTimestampNs: String(raw.timestamp),
      assetId: raw.asset_id,
      signatureType: raw.signature_type,
      priceX18: signed.price,
      proof: {
        publicKey: signed.public_key,
        encodedAssetId: signed.encoded_asset_id,
        signedTimestampNs: String(signed.timestamped_signature.timestamp),
        messageHash: signed.timestamped_signature.msg_hash,
        signature: {
          r: signed.timestamped_signature.signature.r,
          s: signed.timestamped_signature.signature.s,
          v: signatureV(signed.timestamped_signature.signature.v),
        },
        publisherMerkleRoot: signed.publisher_merkle_root,
        calculationAlgorithm: {
          type: signed.calculation_alg.type,
          version: signed.calculation_alg.version,
          checksum: signed.calculation_alg.checksum,
        },
      },
    };
  });
  return {
    schemaVersion: 1,
    chainId: PERPDEX_CHAIN_ID,
    backendProtocolBaselineCommit: BACKEND_PROTOCOL_BASELINE_COMMIT,
    policySha256: requireSha256(input.policySha256, 'policy SHA-256'),
    capturedAtNs: requireDecimalInteger(input.capturedAtNs, 'capture timestamp').toString(),
    observationBlock: input.observationBlock,
    feeds,
  };
}

export function storkPricesByProductId(snapshot: VerifiedStorkDeploymentSnapshot): ReadonlyMap<number, string> {
  return new Map(snapshot.feeds.map((feed) => [feed.productId, feed.priceX18]));
}

export function assertNoStorkSecretMaterial(value: unknown): void {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of ['api_key', 'apikey', 'authorization', 'private_key', 'privatekey', 'secret']) {
    if (serialized.includes(forbidden)) throw new Error(`Stork snapshot must not contain secret field ${forbidden}`);
  }
}
