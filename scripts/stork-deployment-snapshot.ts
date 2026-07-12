import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BigNumber, utils } from 'ethers';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
} from './deployment-config';

export const BACKEND_BETA_COMMIT = '1d174da2f130cf6f4f03b29029a002d92acc76f8';
export const TRACKED_STORK_DEPLOYMENT_POLICY = 'config/galileo.stork-deployment-policy.json';
export const TRACKED_COLLATERAL_PROVENANCE = 'config/galileo.collateral-provenance.json';
export const DEFAULT_STORK_DEPLOYMENT_SNAPSHOT = 'config/galileo.stork-deployment-snapshot.local.json';

const STORK_AGGREGATOR = '0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44';
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
    storkBehaviorCommit: string;
    verifierSourceFile: string;
    runtimeConfigFile: string;
  };
  verifier: {
    provider: string;
    restUrl: string;
    aggregatorPublicKey: string;
    calculationAlgorithm: { type: string; version: string; checksum: string };
    maxAgeSeconds: number;
    maxFutureSkewSeconds: number;
  };
  coherence: { maxSignedTimestampSpreadSeconds: number | null; decision: string };
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
  backendBetaCommit: string;
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
    policy.policyId !== 'bond-perpdex-galileo-stork-deployment-prices' ||
    policy.chainId !== GALILEO_CHAIN_ID ||
    policy.backend.repository !== 'Bond-xyz/perpdex-rust-backend' ||
    policy.backend.releaseCommit !== BACKEND_BETA_COMMIT ||
    policy.backend.storkBehaviorCommit !== '6576efbbfaa74a0babe442be1f8aa029912893f2' ||
    policy.backend.verifierSourceFile !== 'services/price-oracle/src/stork.rs' ||
    policy.backend.runtimeConfigFile !== 'services/price-oracle/config/default.toml'
  ) {
    throw new Error('Stork deployment policy is not bound to the accepted backend beta');
  }
  requireGitObject(policy.backend.releaseCommit, 'backend beta commit');
  requireGitObject(policy.backend.storkBehaviorCommit, 'Stork behavior commit');
  const verifier = policy.verifier;
  if (
    verifier.provider !== 'stork' ||
    verifier.restUrl !== 'https://rest.jp.stork-oracle.network' ||
    utils.getAddress(verifier.aggregatorPublicKey) !== utils.getAddress(STORK_AGGREGATOR) ||
    verifier.calculationAlgorithm.type !== 'median' ||
    verifier.calculationAlgorithm.version !== 'v1' ||
    requireSha256(verifier.calculationAlgorithm.checksum, 'Stork calculation checksum') !== STORK_CHECKSUM ||
    verifier.maxAgeSeconds !== 30 ||
    verifier.maxFutureSkewSeconds !== 2
  ) {
    throw new Error('Stork deployment policy verifier does not match accepted beta constraints');
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
  const expected = [
    ['BTC/USD', 'BTCUSDCPERP', 2, 'BTCUSD'],
    ['ETH/USD', 'ETHUSDCPERP', 4, 'ETHUSD'],
    ['SOL/USD', 'SOLUSDCPERP', 6, 'SOLUSD'],
    ['0G/USD', '0GUSDCPERP', 8, '0GUSD'],
  ];
  const actual = policy.feeds.map((feed) => [feed.pair, feed.symbol, feed.productId, feed.feedId]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Stork deployment policy must contain exact BTC/ETH/SOL/0G feed mappings');
  }
  if (
    policy.coherence.maxSignedTimestampSpreadSeconds !== null &&
    (!Number.isSafeInteger(policy.coherence.maxSignedTimestampSpreadSeconds) ||
      policy.coherence.maxSignedTimestampSpreadSeconds < 0)
  ) {
    throw new Error('cross-feed signed timestamp spread must be null or a non-negative reviewed integer');
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

export function loadTrackedCollateralProvenance(repoRoot = path.resolve(__dirname, '..')): {
  provenance: CollateralProvenance;
  provenanceFile: string;
  provenanceSha256: string;
} {
  const provenanceFile = path.resolve(repoRoot, TRACKED_COLLATERAL_PROVENANCE);
  const provenance = readJson<CollateralProvenance>(provenanceFile);
  const env = provenance.sources.bondEnvironments;
  const app = provenance.sources.bondSuperApp;
  if (
    provenance.schemaVersion !== 1 ||
    provenance.provenanceId !== 'bond-galileo-usdce-product-zero' ||
    provenance.chainId !== GALILEO_CHAIN_ID ||
    utils.getAddress(provenance.collateral.address) !== GALILEO_USDCE_ADDRESS ||
    provenance.collateral.symbol !== GALILEO_USDCE_SYMBOL ||
    provenance.collateral.decimals !== GALILEO_USDCE_DECIMALS ||
    provenance.collateral.productId !== 0 ||
    provenance.selection.mode !== 'static_pinned' ||
    provenance.selection.runtimeRegistryLookup !== false ||
    provenance.selection.aliasSubstitutionAllowed !== false ||
    provenance.selection.mockOrReplacementDeploymentAllowed !== false ||
    provenance.selection.provenanceOnly !== true
  ) {
    throw new Error('collateral provenance must statically pin exact Galileo USDC.e product 0');
  }
  if (
    provenance.normalizedCarriedFieldTupleSha256 !== 'b385d558b2000cf9cba3db74746e855fddc546464e7c172b338b662823719f7a'
  ) {
    throw new Error('normalized collateral carried-field tuple binding mismatch');
  }
  if (
    env.repository !== 'Bond-xyz/bond-environments' ||
    env.commit !== 'a54d8d3723beced7fc5838a83a63b4fb9070641d' ||
    env.tree !== 'b62d8dc7e029138073ff44b57a3f25e7d41b6013' ||
    env.file !== 'envs/og-testnet-staging/assets.json' ||
    env.fileBlob !== '82434072f7ef8a0687bcd352ac5fb7abe17e8171' ||
    env.fileSha256 !== 'e5deda5e8514919dfb8aa8da0266d7e37c453d23aec95316d28947e804ea08b6' ||
    env.perpdexFile !== 'envs/og-testnet-staging/perpdex.json' ||
    env.perpdexFileSha256 !== '61e152e8082c590ec8cf7f5778cd8903ff4842ea98235e94d5463b6d5184db53' ||
    env.assetId !== 'USDCE' ||
    env.lendingEnabled !== true ||
    env.ammEnabled !== true ||
    env.provisionMode !== 'existing' ||
    env.autoDeploy !== false
  ) {
    throw new Error('bond-environments collateral provenance mismatch');
  }
  if (
    app.repository !== 'Bond-xyz/bond-super-app' ||
    app.commit !== '65ad0d7ac03423d700c16b17f63f793ec9a2aeab' ||
    app.tree !== '53fd5289392b88269496664c5ee765547313179a' ||
    app.file !== 'packages/config/src/generated/registry.ts' ||
    app.fileBlob !== 'a1d23eeb3c7e55d48656262616210fe395f500a3' ||
    app.fileSha256 !== '9f4653bdee06f1a6789b6ccda91df6e177ea4acbf26eaf7c3bc3dd718d49084a' ||
    app.assetId !== 'USDCE' ||
    app.registryDomains.lending !== true ||
    app.registryDomains.amm !== true ||
    app.registryDomains.perpdex !== false ||
    app.perpdexLifecycle !== 'pending_fresh_deploy' ||
    app.perpdexEnabled !== false
  ) {
    throw new Error('Bond Super App collateral provenance mismatch');
  }
  return { provenance, provenanceFile, provenanceSha256: sha256File(provenanceFile) };
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
  if (publicKey !== utils.getAddress(verifier.aggregatorPublicKey)) {
    throw new Error(`${expected.feedId} Stork aggregator does not match accepted beta`);
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
    snapshot.chainId !== GALILEO_CHAIN_ID ||
    snapshot.backendBetaCommit !== BACKEND_BETA_COMMIT ||
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

export function collectGalileoStaticReleasePolicy(input: { repoRoot?: string } = {}): GalileoStaticReleasePolicy {
  const repoRoot = input.repoRoot || path.resolve(__dirname, '..');
  const tracked = loadTrackedStorkDeploymentPolicy(repoRoot);
  if (tracked.policy.coherence.maxSignedTimestampSpreadSeconds === null) {
    throw new Error('cross-feed signed timestamp spread policy is unresolved; release preparation remains blocked');
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
    chainId: GALILEO_CHAIN_ID,
    backendBetaCommit: BACKEND_BETA_COMMIT,
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
