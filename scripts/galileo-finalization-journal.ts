import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BigNumber, ContractReceipt, providers, Signer, utils } from 'ethers';

export type FinalizationStepPlan = {
  id: string;
  kind: 'endpoint_initialize' | 'perp_add_product';
  symbol?: string;
  productId?: number;
  from: string;
  to: string;
  nonce: number;
  value: '0';
  calldata: string;
  selector: string;
  argsSha256: string;
};

export type FinalizationReceiptEvidence = {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: 1;
};

export type FinalizationJournalStep = FinalizationStepPlan & {
  state: 'planned' | 'broadcast_intent' | 'broadcast' | 'confirmed' | 'finalized';
  attemptHashes: string[];
  broadcastOwnership?: BroadcastOwnership;
  broadcastOwnershipSha256?: string;
  receipt?: FinalizationReceiptEvidence;
  finality?: {
    confirmationsRequired: number;
    confirmationsObserved: number;
    observedHeadBlock: number;
    recordedAt: string;
  };
};

export type FinalizationJournal = {
  schemaVersion: 1;
  release: string;
  chainId: number;
  preparedFileSha256: string;
  snapshotSha256: string;
  manifestReference: string;
  deployer: string;
  startingNonce: number;
  scanFromBlock: number;
  preparationBoundaryBlockHash: string;
  releaseStateHostIdentity: string;
  leaseScope: 'single_host_local_eoa_no_cross_host';
  finalityConfirmations: 12;
  planSha256: string;
  status: 'active' | 'complete' | 'abandoned';
  steps: FinalizationJournalStep[];
  terminal?: { stepId: string; outcome: string; recordedAt: string };
};

type FinalizationProvider = Pick<
  providers.Provider,
  | 'getBlockNumber'
  | 'getBlockWithTransactions'
  | 'getTransaction'
  | 'getTransactionReceipt'
  | 'getTransactionCount'
  | 'getBlock'
  | 'waitForTransaction'
>;

export type FinalizationRunInput = {
  journalFile: string;
  manifestFile: string;
  expected: Omit<FinalizationJournal, 'status' | 'steps' | 'terminal' | 'planSha256'> & {
    steps: FinalizationStepPlan[];
  };
  provider: FinalizationProvider;
  signer: Pick<Signer, 'sendTransaction'>;
  assertFreshBeforeBroadcast: (step: FinalizationStepPlan) => Promise<void> | void;
  verifyConfirmedStep: (
    step: FinalizationStepPlan,
    receipt: providers.TransactionReceipt,
    block: providers.Block
  ) => Promise<void>;
  testOnlyAfterSendBeforePersist?: (step: FinalizationStepPlan, transactionHash: string) => void;
  testOnlyAfterIntentBeforeSend?: (step: FinalizationStepPlan) => void;
  testOnlyAfterBroadcastPersist?: (step: FinalizationStepPlan, transactionHash: string) => void;
  testOnlyBeforeFinality?: (journal: FinalizationJournal) => void;
  commitAcceptedEvidence?: (accepted: { journal: FinalizationJournal; journalSha256: string }) => Promise<void>;
  testOnlyLockRoot?: string;
  testOnlyAfterBoundaryLeaseAcquired?: (leaseFile: string) => void;
  testOnlyAfterAcceptedEvidenceCommit?: () => void;
  testOnlyPreserveBoundaryLeaseOnExit?: boolean;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

export const deterministicSha256 = (value: unknown): string =>
  crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');

const fileSha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export type BroadcastOwnership = {
  schemaVersion: 1;
  boundaryIdentitySha256: string;
  journalIdentitySha256: string;
  preparedFileSha256: string;
  snapshotSha256: string;
  planSha256: string;
  releaseStateHostIdentity: string;
  stepId: string;
  stepPlanSha256: string;
  ownerPid: number;
  ownerToken: string;
  claimedAt: string;
};

const activeBroadcastOwners = new Set<string>();
const PRODUCTION_RELEASE_LOCK_ROOT = path.join(
  os.homedir(),
  '.local',
  'state',
  'bond-perpdex',
  'galileo-release-locks'
);

export type ReleaseStateOptions = { testOnlyLockRoot?: string };
export type JournalValidationOptions = ReleaseStateOptions & { requireRuntimeOwnership?: boolean };

type BoundaryLease = {
  schemaVersion: 1;
  boundaryIdentitySha256: string;
  releaseStateHostIdentity: string;
  ownerPid: number;
  ownerToken: string;
  acquiredAt: string;
  phase: 'finalization_active' | 'acceptance_commit_indeterminate';
  acceptanceStartedAt?: string;
};

type AcceptedBoundaryRecord = {
  schemaVersion: 1;
  boundaryIdentitySha256: string;
  journalIdentitySha256: string;
  release: string;
  chainId: number;
  deployer: string;
  startingNonce: number;
  preparedFileSha256: string;
  snapshotSha256: string;
  planSha256: string;
  releaseStateHostIdentity: string;
  journalArtifactName: string;
  manifestArtifactName: string;
  journalSha256: string;
  manifestSha256: string;
  journalBytesBase64: string;
  manifestBytesBase64: string;
  acceptedAt: string;
};

const normalizedAddress = (value: string, label: string): string => {
  if (!utils.isAddress(value)) throw new Error(`${label} is not an address`);
  return utils.getAddress(value);
};

export function assertProductionFinalizationEntryState(input: {
  journalFile: string;
  endpointOwner: string;
  endpointSequencer: string;
  expectedOwner: string;
  expectedSequencer: string;
  productIds: number[];
}): 'fresh' | 'recovery' {
  const owner = normalizedAddress(input.endpointOwner, 'Endpoint owner');
  const sequencer = normalizedAddress(input.endpointSequencer, 'Endpoint sequencer');
  const expectedOwner = normalizedAddress(input.expectedOwner, 'expected Endpoint owner');
  const expectedSequencer = normalizedAddress(input.expectedSequencer, 'expected Endpoint sequencer');
  const zero = utils.getAddress('0x0000000000000000000000000000000000000000');
  if (
    !Array.isArray(input.productIds) ||
    input.productIds.some((productId) => !Number.isSafeInteger(productId) || productId < 0)
  ) {
    throw new Error('PerpEngine product IDs are invalid at finalization entry');
  }
  if (expectedOwner === zero || expectedSequencer === zero) {
    throw new Error('expected Endpoint owner/sequencer must not be zero');
  }
  const blankGraph = owner === zero && sequencer === zero && input.productIds.length === 0;
  const canonicalPrefix = GALILEO_FINALIZATION_PRODUCT_IDS.slice(0, input.productIds.length);
  const exactRecoveryGraph =
    owner === expectedOwner &&
    sequencer === expectedSequencer &&
    input.productIds.length <= GALILEO_FINALIZATION_PRODUCT_IDS.length &&
    canonicalJson(input.productIds) === canonicalJson(canonicalPrefix);
  const journalExists = fs.existsSync(input.journalFile);
  if (journalExists) {
    if (!blankGraph && !exactRecoveryGraph) {
      throw new Error('journal recovery graph owner/sequencer/products do not match one canonical finalization prefix');
    }
    return 'recovery';
  }
  if (!blankGraph) {
    throw new Error('prepared graph was already finalized or received an unreviewed price write');
  }
  return 'fresh';
}

const GALILEO_FINALIZATION_PRODUCT_IDS = [2, 4, 6, 8] as const;

export function assertCanonicalGalileoProductPrefix(
  actualProductIds: number[],
  currentProductId: number,
  label: string
): void {
  const currentIndex = GALILEO_FINALIZATION_PRODUCT_IDS.indexOf(
    currentProductId as typeof GALILEO_FINALIZATION_PRODUCT_IDS[number]
  );
  const canonicalPrefix = GALILEO_FINALIZATION_PRODUCT_IDS.slice(0, actualProductIds.length);
  if (
    currentIndex < 0 ||
    actualProductIds.length < currentIndex + 1 ||
    actualProductIds.length > GALILEO_FINALIZATION_PRODUCT_IDS.length ||
    actualProductIds.some((productId) => !Number.isSafeInteger(productId) || productId < 0) ||
    canonicalJson(actualProductIds) !== canonicalJson(canonicalPrefix)
  ) {
    throw new Error(`${label} PerpEngine product set is not a canonical launch prefix containing the verified step`);
  }
}

export function portableArtifactReference(fromFile: string, toFile: string): string {
  const fromDirectory = path.dirname(path.resolve(fromFile));
  const resolvedTarget = path.resolve(toFile);
  if (path.dirname(resolvedTarget) !== fromDirectory) {
    throw new Error('release journal and manifest must be in the same canonical packet directory');
  }
  const reference = path.basename(resolvedTarget);
  if (!reference || reference === '.' || reference === '..' || reference.includes('/') || reference.includes('\\')) {
    throw new Error('release artifact reference must be one portable basename');
  }
  return reference;
}

export function resolvePortableArtifactReference(fromFile: string, reference: string): string {
  if (
    !reference ||
    reference === '.' ||
    reference === '..' ||
    path.isAbsolute(reference) ||
    reference.includes('/') ||
    reference.includes('\\')
  ) {
    throw new Error('release artifact reference must be one portable basename');
  }
  const resolved = path.resolve(path.dirname(path.resolve(fromFile)), reference);
  if (path.dirname(resolved) !== path.dirname(path.resolve(fromFile))) {
    throw new Error('release artifact reference escaped its canonical packet directory');
  }
  return resolved;
}

const exactPlan = (step: FinalizationStepPlan): FinalizationStepPlan => {
  if (!step.id || !['endpoint_initialize', 'perp_add_product'].includes(step.kind)) {
    throw new Error('finalization step identity is invalid');
  }
  if (!Number.isSafeInteger(step.nonce) || step.nonce < 0) throw new Error(`${step.id} nonce is invalid`);
  if (!utils.isHexString(step.calldata) || step.calldata.length < 10) {
    throw new Error(`${step.id} calldata is invalid`);
  }
  if (step.selector.toLowerCase() !== step.calldata.slice(0, 10).toLowerCase()) {
    throw new Error(`${step.id} selector does not match calldata`);
  }
  if (!/^[0-9a-f]{64}$/i.test(step.argsSha256)) throw new Error(`${step.id} args SHA-256 is invalid`);
  if (step.value !== '0') throw new Error(`${step.id} must not transfer native value`);
  const plan: FinalizationStepPlan = {
    id: step.id,
    kind: step.kind,
    from: normalizedAddress(step.from, `${step.id} signer`),
    to: normalizedAddress(step.to, `${step.id} target`),
    nonce: step.nonce,
    value: step.value,
    calldata: step.calldata.toLowerCase(),
    selector: step.selector.toLowerCase(),
    argsSha256: step.argsSha256.toLowerCase(),
  };
  if (step.symbol !== undefined) plan.symbol = step.symbol;
  if (step.productId !== undefined) plan.productId = step.productId;
  return plan;
};

export function finalizationPlanSha256(steps: FinalizationStepPlan[]): string {
  return deterministicSha256(steps.map(exactPlan));
}

function fsyncDirectory(directoryPath: string): void {
  try {
    const directory = fs.openSync(directoryPath, 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } catch {
    // Some filesystems do not permit directory fsync. The file itself is still fsynced.
  }
}

function atomicWriteJson(file: string, value: unknown, exclusive = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exclusive) {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(file));
    return;
  }
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file));
}

function releaseLockRoot(options: ReleaseStateOptions = {}): string {
  return options.testOnlyLockRoot ? path.resolve(options.testOnlyLockRoot) : PRODUCTION_RELEASE_LOCK_ROOT;
}

function readReleaseStateHostIdentity(options: ReleaseStateOptions = {}): string {
  const file = path.join(releaseLockRoot(options), 'host-identity.json');
  if (!fs.existsSync(file)) {
    throw new Error('durable local release-state host identity is missing; cross-host finalization is unsupported');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { schemaVersion?: number; hostIdentity?: string };
  if (value.schemaVersion !== 1 || !/^[0-9a-f]{64}$/i.test(value.hostIdentity || '')) {
    throw new Error('durable local release-state host identity is invalid');
  }
  return value.hostIdentity!.toLowerCase();
}

export function ensureLocalReleaseStateHostIdentity(options: ReleaseStateOptions = {}): string {
  const root = releaseLockRoot(options);
  const file = path.join(root, 'host-identity.json');
  if (!fs.existsSync(file)) {
    try {
      atomicWriteJson(
        file,
        { schemaVersion: 1, hostIdentity: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() },
        true
      );
    } catch {
      // Another preparation process may have won the exclusive host-identity creation race.
    }
  }
  return readReleaseStateHostIdentity(options);
}

function requireReleaseStateHostIdentity(expected: string, options: ReleaseStateOptions = {}): void {
  if (!/^[0-9a-f]{64}$/i.test(expected) || readReleaseStateHostIdentity(options) !== expected.toLowerCase()) {
    throw new Error(
      'prepared release host identity does not match durable local state; cross-host finalization requires an external shared lease'
    );
  }
}

function journalIdentitySha256(
  journal: Pick<
    FinalizationJournal,
    | 'release'
    | 'chainId'
    | 'preparedFileSha256'
    | 'snapshotSha256'
    | 'deployer'
    | 'startingNonce'
    | 'scanFromBlock'
    | 'preparationBoundaryBlockHash'
    | 'finalityConfirmations'
    | 'planSha256'
  >
): string {
  return deterministicSha256({
    release: journal.release,
    chainId: journal.chainId,
    preparedFileSha256: journal.preparedFileSha256,
    snapshotSha256: journal.snapshotSha256,
    deployer: utils.getAddress(journal.deployer),
    startingNonce: journal.startingNonce,
    scanFromBlock: journal.scanFromBlock,
    preparationBoundaryBlockHash: journal.preparationBoundaryBlockHash.toLowerCase(),
    finalityConfirmations: journal.finalityConfirmations,
    planSha256: journal.planSha256,
  });
}

function boundaryIdentitySha256(
  journal: Pick<FinalizationJournal, 'chainId' | 'deployer' | 'preparationBoundaryBlockHash'>
): string {
  if (!utils.isHexString(journal.preparationBoundaryBlockHash, 32)) {
    throw new Error('preparation boundary block hash must be exactly 32 bytes');
  }
  return deterministicSha256({
    chainId: journal.chainId,
    forkBoundaryBlockHash: journal.preparationBoundaryBlockHash.toLowerCase(),
    deployer: utils.getAddress(journal.deployer),
  });
}

function broadcastOwnershipFile(
  journal: FinalizationJournal,
  step: FinalizationStepPlan,
  options: ReleaseStateOptions = {}
): string {
  return path.join(
    releaseLockRoot(options),
    `galileo-${boundaryIdentitySha256(journal)}-${utils.getAddress(journal.deployer).toLowerCase()}-nonce-${
      step.nonce
    }.broadcast.json`
  );
}

function validateBroadcastOwnershipRecord(
  journal: FinalizationJournal,
  step: FinalizationStepPlan,
  ownership: BroadcastOwnership
): string {
  if (
    ownership.schemaVersion !== 1 ||
    ownership.boundaryIdentitySha256 !== boundaryIdentitySha256(journal) ||
    ownership.journalIdentitySha256 !== journalIdentitySha256(journal) ||
    ownership.preparedFileSha256 !== journal.preparedFileSha256 ||
    ownership.snapshotSha256 !== journal.snapshotSha256 ||
    ownership.planSha256 !== journal.planSha256 ||
    ownership.releaseStateHostIdentity !== journal.releaseStateHostIdentity ||
    ownership.stepId !== step.id ||
    ownership.stepPlanSha256 !== deterministicSha256(exactPlan(step)) ||
    !Number.isSafeInteger(ownership.ownerPid) ||
    ownership.ownerPid <= 0 ||
    !/^[0-9a-f]{32}$/i.test(ownership.ownerToken || '') ||
    !ownership.claimedAt
  ) {
    throw new Error(`${step.id} broadcast ownership tombstone is invalid or changed`);
  }
  return deterministicSha256(ownership);
}

function loadBroadcastOwnership(
  journal: FinalizationJournal,
  step: FinalizationStepPlan,
  options: ReleaseStateOptions = {}
): { file: string; ownership: BroadcastOwnership; sha256: string } | undefined {
  const file = broadcastOwnershipFile(journal, step, options);
  if (!fs.existsSync(file)) return undefined;
  const ownership = JSON.parse(fs.readFileSync(file, 'utf8')) as BroadcastOwnership;
  return { file, ownership, sha256: validateBroadcastOwnershipRecord(journal, step, ownership) };
}

function ownershipIsActive(ownership: BroadcastOwnership): boolean {
  if (ownership.ownerPid === process.pid) return activeBroadcastOwners.has(ownership.ownerToken);
  try {
    process.kill(ownership.ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimBroadcastOwnership(
  journal: FinalizationJournal,
  step: FinalizationStepPlan,
  options: ReleaseStateOptions = {}
): { file: string; ownership: BroadcastOwnership; sha256: string } {
  const file = broadcastOwnershipFile(journal, step, options);
  const ownership: BroadcastOwnership = {
    schemaVersion: 1,
    boundaryIdentitySha256: boundaryIdentitySha256(journal),
    journalIdentitySha256: journalIdentitySha256(journal),
    preparedFileSha256: journal.preparedFileSha256,
    snapshotSha256: journal.snapshotSha256,
    planSha256: journal.planSha256,
    releaseStateHostIdentity: journal.releaseStateHostIdentity,
    stepId: step.id,
    stepPlanSha256: deterministicSha256(exactPlan(step)),
    ownerPid: process.pid,
    ownerToken: crypto.randomBytes(16).toString('hex'),
    claimedAt: new Date().toISOString(),
  };
  atomicWriteJson(file, ownership, true);
  return { file, ownership, sha256: validateBroadcastOwnershipRecord(journal, step, ownership) };
}

function boundaryLeaseFile(
  boundary: Pick<FinalizationJournal, 'chainId' | 'deployer' | 'preparationBoundaryBlockHash' | 'startingNonce'>,
  options: ReleaseStateOptions = {}
): string {
  return path.join(
    releaseLockRoot(options),
    `galileo-${boundaryIdentitySha256(boundary)}-${utils.getAddress(boundary.deployer).toLowerCase()}-nonce-${
      boundary.startingNonce
    }.lease.json`
  );
}

function readBoundaryLease(file: string): BoundaryLease {
  const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as BoundaryLease;
  if (
    lease.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/i.test(lease.boundaryIdentitySha256 || '') ||
    !/^[0-9a-f]{64}$/i.test(lease.releaseStateHostIdentity || '') ||
    !Number.isSafeInteger(lease.ownerPid) ||
    lease.ownerPid <= 0 ||
    !/^[0-9a-f]{32}$/i.test(lease.ownerToken || '') ||
    !lease.acquiredAt ||
    !['finalization_active', 'acceptance_commit_indeterminate'].includes(lease.phase) ||
    (lease.phase === 'finalization_active' && lease.acceptanceStartedAt !== undefined) ||
    (lease.phase === 'acceptance_commit_indeterminate' && !lease.acceptanceStartedAt)
  ) {
    throw new Error('finalization boundary lease is invalid or changed');
  }
  return lease;
}

function acquireBoundaryLease(
  boundary: Pick<
    FinalizationJournal,
    'chainId' | 'deployer' | 'preparationBoundaryBlockHash' | 'startingNonce' | 'releaseStateHostIdentity'
  >,
  options: ReleaseStateOptions = {}
): { file: string; lease: BoundaryLease } {
  const file = boundaryLeaseFile(boundary, options);
  const lease: BoundaryLease = {
    schemaVersion: 1,
    boundaryIdentitySha256: boundaryIdentitySha256(boundary),
    releaseStateHostIdentity: boundary.releaseStateHostIdentity,
    ownerPid: process.pid,
    ownerToken: crypto.randomBytes(16).toString('hex'),
    acquiredAt: new Date().toISOString(),
    phase: 'finalization_active',
  };
  try {
    atomicWriteJson(file, lease, true);
  } catch {
    const incumbent = readBoundaryLease(file);
    if (
      incumbent.boundaryIdentitySha256 !== lease.boundaryIdentitySha256 ||
      incumbent.releaseStateHostIdentity !== lease.releaseStateHostIdentity
    ) {
      throw new Error('finalization boundary lease identity mismatch');
    }
    throw new Error(
      'finalization boundary lease already exists; automatic active or stale lease takeover is forbidden'
    );
  }
  return { file, lease };
}

function markBoundaryAcceptanceIndeterminate(handle: { file: string; lease: BoundaryLease }): void {
  if (!fs.existsSync(handle.file)) throw new Error('finalization boundary lease disappeared before acceptance commit');
  const current = readBoundaryLease(handle.file);
  if (
    current.ownerToken !== handle.lease.ownerToken ||
    current.ownerPid !== process.pid ||
    canonicalJson(current) !== canonicalJson(handle.lease)
  ) {
    throw new Error('finalization boundary lease ownership changed before acceptance commit');
  }
  const marked: BoundaryLease = {
    ...current,
    phase: 'acceptance_commit_indeterminate',
    acceptanceStartedAt: new Date().toISOString(),
  };
  atomicWriteJson(handle.file, marked);
  handle.lease = readBoundaryLease(handle.file);
  if (handle.lease.ownerToken !== marked.ownerToken || handle.lease.phase !== 'acceptance_commit_indeterminate') {
    throw new Error('finalization boundary acceptance marker changed during durable readback');
  }
}

function releaseBoundaryLease(handle: { file: string; lease: BoundaryLease }): void {
  if (!fs.existsSync(handle.file)) throw new Error('finalization boundary lease disappeared before release');
  const current = readBoundaryLease(handle.file);
  if (
    current.ownerToken !== handle.lease.ownerToken ||
    current.ownerPid !== process.pid ||
    canonicalJson(current) !== canonicalJson(handle.lease)
  ) {
    throw new Error('finalization boundary lease ownership changed before release');
  }
  fs.unlinkSync(handle.file);
  fsyncDirectory(path.dirname(handle.file));
}

function acceptedBoundaryFile(
  boundary: Pick<FinalizationJournal, 'chainId' | 'deployer' | 'preparationBoundaryBlockHash' | 'startingNonce'>,
  options: ReleaseStateOptions = {}
): string {
  return path.join(
    releaseLockRoot(options),
    `galileo-${boundaryIdentitySha256(boundary)}-${utils.getAddress(boundary.deployer).toLowerCase()}-nonce-${
      boundary.startingNonce
    }.accepted.json`
  );
}

function exactBase64Bytes(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function sha256Bytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function expectedJournalIdentity(expected: FinalizationRunInput['expected']): string {
  return journalIdentitySha256({
    ...expected,
    planSha256: finalizationPlanSha256(expected.steps),
  });
}

function validateAcceptedBoundaryRecord(
  record: AcceptedBoundaryRecord,
  expected: FinalizationRunInput['expected']
): { journalBytes: Buffer; manifestBytes: Buffer } {
  const expectedPlanSha256 = finalizationPlanSha256(expected.steps);
  if (
    record.schemaVersion !== 1 ||
    record.boundaryIdentitySha256 !== boundaryIdentitySha256(expected) ||
    record.journalIdentitySha256 !== expectedJournalIdentity(expected) ||
    record.release !== expected.release ||
    record.chainId !== expected.chainId ||
    normalizedAddress(record.deployer, 'accepted boundary deployer') !==
      normalizedAddress(expected.deployer, 'expected deployer') ||
    record.startingNonce !== expected.startingNonce ||
    record.preparedFileSha256 !== expected.preparedFileSha256 ||
    record.snapshotSha256 !== expected.snapshotSha256 ||
    record.planSha256 !== expectedPlanSha256 ||
    record.releaseStateHostIdentity !== expected.releaseStateHostIdentity ||
    !/^[0-9a-f]{64}$/i.test(record.journalSha256 || '') ||
    !/^[0-9a-f]{64}$/i.test(record.manifestSha256 || '') ||
    !record.acceptedAt
  ) {
    throw new Error('accepted finalization boundary record is invalid or belongs to different evidence');
  }
  for (const [name, label] of [
    [record.journalArtifactName, 'accepted journal artifact name'],
    [record.manifestArtifactName, 'accepted manifest artifact name'],
  ] as const) {
    resolvePortableArtifactReference(path.join('/portable-packet', 'anchor'), name);
    if (path.basename(name) !== name) throw new Error(`${label} is not one portable basename`);
  }
  const journalBytes = exactBase64Bytes(record.journalBytesBase64, 'accepted journal bytes');
  const manifestBytes = exactBase64Bytes(record.manifestBytesBase64, 'accepted manifest bytes');
  if (sha256Bytes(journalBytes) !== record.journalSha256 || sha256Bytes(manifestBytes) !== record.manifestSha256) {
    throw new Error('accepted finalization boundary bytes do not match their immutable hashes');
  }
  const journal = JSON.parse(journalBytes.toString('utf8')) as FinalizationJournal;
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    finalization?: {
      journalReference?: string;
      journalSha256?: string;
      leaseScope?: string;
      planSha256?: string;
      status?: string;
      steps?: unknown;
    };
  };
  validateJournal(
    path.join('/portable-packet', record.journalArtifactName),
    journal,
    { ...expected, manifestReference: record.manifestArtifactName },
    {}
  );
  if (
    journal.status !== 'complete' ||
    journalIdentitySha256(journal) !== record.journalIdentitySha256 ||
    journal.manifestReference !== record.manifestArtifactName ||
    manifest.finalization?.journalReference !== record.journalArtifactName ||
    manifest.finalization?.journalSha256 !== record.journalSha256 ||
    manifest.finalization?.leaseScope !== journal.leaseScope ||
    manifest.finalization?.planSha256 !== journal.planSha256 ||
    manifest.finalization?.status !== journal.status ||
    canonicalJson(manifest.finalization?.steps) !== canonicalJson(journal.steps)
  ) {
    throw new Error('accepted finalization boundary packet bytes are not mutually bound');
  }
  return { journalBytes, manifestBytes };
}

function assertBoundaryNotAlreadyAccepted(
  expected: FinalizationRunInput['expected'],
  options: ReleaseStateOptions = {}
): void {
  const file = acceptedBoundaryFile(expected, options);
  if (!fs.existsSync(file)) return;
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as AcceptedBoundaryRecord;
  validateAcceptedBoundaryRecord(record, expected);
  throw new Error('finalization boundary already has one accepted immutable journal/manifest packet');
}

function persistAcceptedBoundaryRecord(input: {
  expected: FinalizationRunInput['expected'];
  journalFile: string;
  manifestFile: string;
  journalSha256: string;
  options?: ReleaseStateOptions;
}): void {
  const journalBytes = fs.readFileSync(input.journalFile);
  const manifestBytes = fs.readFileSync(input.manifestFile);
  if (sha256Bytes(journalBytes) !== input.journalSha256) {
    throw new Error('accepted journal bytes changed before boundary acceptance was persisted');
  }
  const journal = JSON.parse(journalBytes.toString('utf8')) as FinalizationJournal;
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    finalization?: {
      journalReference?: string;
      journalSha256?: string;
      leaseScope?: string;
      planSha256?: string;
      status?: string;
      steps?: unknown;
    };
  };
  validateJournal(input.journalFile, journal, input.expected, {
    ...input.options,
    requireRuntimeOwnership: true,
  });
  const record: AcceptedBoundaryRecord = {
    schemaVersion: 1,
    boundaryIdentitySha256: boundaryIdentitySha256(journal),
    journalIdentitySha256: journalIdentitySha256(journal),
    release: journal.release,
    chainId: journal.chainId,
    deployer: utils.getAddress(journal.deployer),
    startingNonce: journal.startingNonce,
    preparedFileSha256: journal.preparedFileSha256,
    snapshotSha256: journal.snapshotSha256,
    planSha256: journal.planSha256,
    releaseStateHostIdentity: journal.releaseStateHostIdentity,
    journalArtifactName: portableArtifactReference(input.manifestFile, input.journalFile),
    manifestArtifactName: portableArtifactReference(input.journalFile, input.manifestFile),
    journalSha256: input.journalSha256,
    manifestSha256: sha256Bytes(manifestBytes),
    journalBytesBase64: journalBytes.toString('base64'),
    manifestBytesBase64: manifestBytes.toString('base64'),
    acceptedAt: new Date().toISOString(),
  };
  if (
    journal.status !== 'complete' ||
    manifest.finalization?.journalReference !== record.journalArtifactName ||
    manifest.finalization?.journalSha256 !== record.journalSha256 ||
    manifest.finalization?.leaseScope !== journal.leaseScope ||
    manifest.finalization?.planSha256 !== journal.planSha256 ||
    manifest.finalization?.status !== journal.status ||
    canonicalJson(manifest.finalization?.steps) !== canonicalJson(journal.steps)
  ) {
    throw new Error('accepted journal and manifest are not mutually bound before stable acceptance');
  }
  validateAcceptedBoundaryRecord(record, input.expected);
  const file = acceptedBoundaryFile(journal, input.options);
  atomicWriteJson(file, record, true);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as AcceptedBoundaryRecord;
  const readback = validateAcceptedBoundaryRecord(persisted, input.expected);
  if (!readback.journalBytes.equals(journalBytes) || !readback.manifestBytes.equals(manifestBytes)) {
    throw new Error('accepted finalization boundary packet changed during stable readback');
  }
  if (
    !fs.readFileSync(input.journalFile).equals(journalBytes) ||
    !fs.readFileSync(input.manifestFile).equals(manifestBytes)
  ) {
    throw new Error('journal or manifest changed after stable boundary acceptance');
  }
}

export function commitAcceptedManifestExclusive(input: {
  manifestFile: string;
  journalFile: string;
  journalSha256: string;
  manifest: unknown;
}): string {
  if (fileSha256(input.journalFile) !== input.journalSha256) {
    throw new Error('finalization journal changed before manifest commit');
  }
  const journal = JSON.parse(fs.readFileSync(input.journalFile, 'utf8')) as FinalizationJournal;
  const manifest = input.manifest as {
    finalization?: {
      journalSha256?: string;
      journalReference?: string;
      leaseScope?: string;
      planSha256?: string;
      status?: string;
      steps?: unknown;
    };
  };
  const expectedJournalReference = portableArtifactReference(input.manifestFile, input.journalFile);
  const expectedManifestReference = portableArtifactReference(input.journalFile, input.manifestFile);
  if (
    journal.status !== 'complete' ||
    journal.manifestReference !== expectedManifestReference ||
    manifest.finalization?.journalSha256 !== input.journalSha256 ||
    manifest.finalization?.journalReference !== expectedJournalReference ||
    manifest.finalization?.leaseScope !== journal.leaseScope ||
    manifest.finalization?.planSha256 !== journal.planSha256 ||
    manifest.finalization?.status !== journal.status ||
    canonicalJson(manifest.finalization?.steps) !== canonicalJson(journal.steps)
  ) {
    throw new Error('deployment manifest is not bound to the final journal hash');
  }
  fs.mkdirSync(path.dirname(input.manifestFile), { recursive: true });
  const temporary = `${input.manifestFile}.commit-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const expectedManifestBytes = Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`);
  const expectedManifestSha256 = sha256Bytes(expectedManifestBytes);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, expectedManifestBytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, input.manifestFile);
    fsyncDirectory(path.dirname(input.manifestFile));
  } finally {
    fs.unlinkSync(temporary);
  }
  const firstRead = fileSha256(input.manifestFile);
  const secondRead = fileSha256(input.manifestFile);
  if (
    firstRead !== expectedManifestSha256 ||
    firstRead !== secondRead ||
    fileSha256(input.journalFile) !== input.journalSha256
  ) {
    throw new Error('accepted journal/manifest readback fence changed during commit');
  }
  return firstRead;
}

export function reserveFinalizationJournal(
  file: string,
  manifestFile: string,
  expected: FinalizationRunInput['expected'],
  options: JournalValidationOptions = {}
): FinalizationJournal {
  if (
    portableArtifactReference(file, manifestFile) !== expected.manifestReference ||
    resolvePortableArtifactReference(file, expected.manifestReference) !== path.resolve(manifestFile)
  ) {
    throw new Error('finalization journal manifest reference does not match the canonical packet target');
  }
  if (fs.existsSync(manifestFile)) {
    throw new Error(`refusing finalization because deployment manifest target already exists: ${manifestFile}`);
  }
  if (fs.existsSync(file)) return loadAndValidateFinalizationJournal(file, expected, options);
  const steps = expected.steps.map((step) => ({
    ...exactPlan(step),
    state: 'planned' as const,
    attemptHashes: [],
  }));
  const journal: FinalizationJournal = {
    ...expected,
    planSha256: finalizationPlanSha256(steps),
    status: 'active',
    steps,
  };
  validateJournal(file, journal, expected, options);
  atomicWriteJson(file, journal, true);
  return journal;
}

function immutableStep(step: FinalizationJournalStep): FinalizationStepPlan {
  const {
    state: _state,
    attemptHashes: _attemptHashes,
    broadcastOwnership: _broadcastOwnership,
    broadcastOwnershipSha256: _broadcastOwnershipSha256,
    receipt: _receipt,
    finality: _finality,
    ...plan
  } = step;
  return exactPlan(plan);
}

function validateJournal(
  journalFile: string,
  journal: FinalizationJournal,
  expected: FinalizationRunInput['expected'],
  options: JournalValidationOptions = {}
): void {
  if (
    journal.schemaVersion !== 1 ||
    journal.release !== expected.release ||
    journal.chainId !== expected.chainId ||
    journal.preparedFileSha256 !== expected.preparedFileSha256 ||
    journal.snapshotSha256 !== expected.snapshotSha256 ||
    journal.manifestReference !== expected.manifestReference ||
    resolvePortableArtifactReference(journalFile, journal.manifestReference) !==
      resolvePortableArtifactReference(journalFile, expected.manifestReference) ||
    normalizedAddress(journal.deployer, 'journal deployer') !== normalizedAddress(expected.deployer, 'deployer') ||
    journal.startingNonce !== expected.startingNonce ||
    journal.scanFromBlock !== expected.scanFromBlock ||
    journal.preparationBoundaryBlockHash?.toLowerCase() !== expected.preparationBoundaryBlockHash.toLowerCase() ||
    !utils.isHexString(journal.preparationBoundaryBlockHash || '', 32) ||
    journal.releaseStateHostIdentity !== expected.releaseStateHostIdentity ||
    !/^[0-9a-f]{64}$/i.test(journal.releaseStateHostIdentity || '') ||
    journal.leaseScope !== 'single_host_local_eoa_no_cross_host' ||
    expected.leaseScope !== 'single_host_local_eoa_no_cross_host' ||
    journal.finalityConfirmations !== 12 ||
    expected.finalityConfirmations !== 12
  ) {
    throw new Error('finalization journal identity does not match prepared graph and signed snapshot');
  }
  if (!['active', 'complete', 'abandoned'].includes(journal.status)) {
    throw new Error('finalization journal status is invalid');
  }
  if (
    (journal.status === 'abandoned' &&
      (!journal.terminal?.stepId || !journal.terminal.outcome || !journal.terminal.recordedAt)) ||
    (journal.status !== 'abandoned' && journal.terminal !== undefined)
  ) {
    throw new Error('finalization journal terminal outcome does not match status');
  }
  const expectedSteps = expected.steps.map(exactPlan);
  const actualSteps = journal.steps.map(immutableStep);
  const requiredMarkets = [
    ['BTCUSDCPERP', 2],
    ['ETHUSDCPERP', 4],
    ['SOLUSDCPERP', 6],
    ['0GUSDCPERP', 8],
  ] as const;
  if (
    expectedSteps.length !== 5 ||
    expectedSteps[0].id !== 'endpoint.initialize' ||
    expectedSteps[0].kind !== 'endpoint_initialize' ||
    expectedSteps[0].symbol !== undefined ||
    expectedSteps[0].productId !== undefined ||
    requiredMarkets.some(([symbol, productId], index) => {
      const step = expectedSteps[index + 1];
      return (
        step.id !== `perp.addProduct.${productId}` ||
        step.kind !== 'perp_add_product' ||
        step.symbol !== symbol ||
        step.productId !== productId ||
        step.to !== expectedSteps[1].to
      );
    }) ||
    expectedSteps.some(
      (step, index) => step.from !== expectedSteps[0].from || step.nonce !== expected.startingNonce + index
    ) ||
    expectedSteps[0].to === expectedSteps[1].to
  ) {
    throw new Error('finalization plan must be exactly Endpoint.initialize then addProduct 2,4,6,8');
  }
  if (
    journal.planSha256 !== finalizationPlanSha256(expectedSteps) ||
    canonicalJson(actualSteps) !== canonicalJson(expectedSteps)
  ) {
    throw new Error('finalization journal plan was changed or does not match exact calldata');
  }
  let encounteredUnconfirmed = false;
  let encounteredConfirmedButNotFinalized = false;
  for (const [index, step] of journal.steps.entries()) {
    if (step.nonce !== journal.startingNonce + index)
      throw new Error('finalization journal nonce sequence is not gap-free');
    if (!['planned', 'broadcast_intent', 'broadcast', 'confirmed', 'finalized'].includes(step.state)) {
      throw new Error(`${step.id} journal state is invalid`);
    }
    if (!Array.isArray(step.attemptHashes) || step.attemptHashes.some((hash) => !utils.isHexString(hash, 32))) {
      throw new Error(`${step.id} transaction attempt history is invalid`);
    }
    if (
      (step.state === 'planned' && step.attemptHashes.length !== 0) ||
      (step.state === 'broadcast_intent' && step.attemptHashes.length !== 0) ||
      (['broadcast', 'confirmed', 'finalized'].includes(step.state) && step.attemptHashes.length !== 1) ||
      new Set(step.attemptHashes.map((hash) => hash.toLowerCase())).size !== step.attemptHashes.length
    ) {
      throw new Error(`${step.id} transaction attempt history does not match state`);
    }
    if (
      (step.state === 'planned' &&
        (step.broadcastOwnership !== undefined || step.broadcastOwnershipSha256 !== undefined)) ||
      (step.state !== 'planned' &&
        (!step.broadcastOwnership || !/^[0-9a-f]{64}$/i.test(step.broadcastOwnershipSha256 || '')))
    ) {
      throw new Error(`${step.id} broadcast ownership evidence does not match state`);
    }
    if (step.broadcastOwnership && step.broadcastOwnershipSha256) {
      const embeddedSha256 = validateBroadcastOwnershipRecord(journal, step, step.broadcastOwnership);
      if (embeddedSha256 !== step.broadcastOwnershipSha256) {
        throw new Error(`${step.id} embedded broadcast ownership tombstone hash mismatch`);
      }
      if (options.requireRuntimeOwnership) {
        const ownership = loadBroadcastOwnership(journal, step, options);
        if (
          !ownership ||
          ownership.sha256 !== step.broadcastOwnershipSha256 ||
          canonicalJson(ownership.ownership) !== canonicalJson(step.broadcastOwnership)
        ) {
          throw new Error(`${step.id} broadcast ownership tombstone hash mismatch`);
        }
      }
      if (options.requireRuntimeOwnership && !fs.existsSync(broadcastOwnershipFile(journal, step, options))) {
        throw new Error(`${step.id} broadcast ownership tombstone hash mismatch`);
      }
    }
    if (step.state === 'confirmed' || step.state === 'finalized') {
      if (encounteredUnconfirmed) throw new Error(`${step.id} confirmed state is not a gap-free prefix`);
      if (
        !step.receipt ||
        step.receipt.status !== 1 ||
        !utils.isHexString(step.receipt.transactionHash, 32) ||
        !utils.isHexString(step.receipt.blockHash, 32) ||
        !Number.isSafeInteger(step.receipt.blockNumber) ||
        step.receipt.blockNumber < journal.scanFromBlock ||
        !step.attemptHashes.some(
          (transactionHash) => transactionHash.toLowerCase() === step.receipt!.transactionHash.toLowerCase()
        )
      ) {
        throw new Error(`${step.id} confirmed state has invalid immutable receipt evidence`);
      }
      if (step.state === 'confirmed') {
        encounteredConfirmedButNotFinalized = true;
        if (step.finality) throw new Error(`${step.id} confirmed state must not claim finality evidence`);
      } else if (
        encounteredConfirmedButNotFinalized ||
        !step.finality ||
        step.finality.confirmationsRequired !== 12 ||
        !Number.isSafeInteger(step.finality.confirmationsObserved) ||
        step.finality.confirmationsObserved < 12 ||
        !Number.isSafeInteger(step.finality.observedHeadBlock) ||
        step.finality.observedHeadBlock < step.receipt.blockNumber + 11 ||
        !step.finality.recordedAt
      ) {
        throw new Error(`${step.id} finalized state has invalid 12-confirmation evidence`);
      }
    } else {
      encounteredUnconfirmed = true;
      if (step.receipt || step.finality) {
        throw new Error(`${step.id} unconfirmed state must not contain receipt/finality evidence`);
      }
    }
  }
  if (journal.status === 'complete' && journal.steps.some((step) => step.state !== 'finalized')) {
    throw new Error('complete finalization journal requires all five steps finalized at 12 confirmations');
  }
}

export function loadAndValidateFinalizationJournal(
  file: string,
  expected: FinalizationRunInput['expected'],
  options: JournalValidationOptions = {}
): FinalizationJournal {
  if (options.requireRuntimeOwnership) {
    requireReleaseStateHostIdentity(expected.releaseStateHostIdentity, options);
  }
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as FinalizationJournal;
  validateJournal(file, journal, expected, options);
  return journal;
}

function persist(file: string, journal: FinalizationJournal): void {
  atomicWriteJson(file, journal);
}

function abandon(file: string, journal: FinalizationJournal, stepId: string, outcome: string): never {
  journal.status = 'abandoned';
  journal.terminal = { stepId, outcome, recordedAt: new Date().toISOString() };
  persist(file, journal);
  throw new Error(`finalization abandoned at ${stepId}: ${outcome}`);
}

function transactionMatchesPlan(transaction: providers.TransactionResponse, step: FinalizationStepPlan): boolean {
  return (
    utils.getAddress(transaction.from) === utils.getAddress(step.from) &&
    !!transaction.to &&
    utils.getAddress(transaction.to) === utils.getAddress(step.to) &&
    transaction.nonce === step.nonce &&
    transaction.data.toLowerCase() === step.calldata.toLowerCase() &&
    BigNumber.from(transaction.value).isZero()
  );
}

async function findTransactionByNonce(
  provider: FinalizationProvider,
  journal: FinalizationJournal,
  step: FinalizationStepPlan
): Promise<providers.TransactionResponse | undefined> {
  const latest = await provider.getBlockNumber();
  if (latest - journal.scanFromBlock > 512) {
    throw new Error('finalization nonce reconciliation exceeds the 512-block fail-closed scan window');
  }
  let found: providers.TransactionResponse | undefined;
  for (let blockNumber = journal.scanFromBlock; blockNumber <= latest; blockNumber += 1) {
    const block = await provider.getBlockWithTransactions(blockNumber);
    for (const transaction of block.transactions) {
      if (utils.getAddress(transaction.from) !== utils.getAddress(step.from) || transaction.nonce !== step.nonce)
        continue;
      if (found && found.hash.toLowerCase() !== transaction.hash.toLowerCase()) {
        throw new Error(`${step.id} has multiple canonical transactions for one signer nonce`);
      }
      found = transaction;
    }
  }
  return found;
}

async function exactReceipt(
  provider: FinalizationProvider,
  step: FinalizationStepPlan,
  transactionHash: string
): Promise<
  | { transaction: providers.TransactionResponse; receipt: providers.TransactionReceipt; block: providers.Block }
  | undefined
> {
  const transaction = await provider.getTransaction(transactionHash);
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt) return undefined;
  if (!transaction || !transactionMatchesPlan(transaction, step)) {
    throw new Error(`${step.id} transaction signer/target/nonce/selector/arguments mismatch`);
  }
  if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new Error(`${step.id} receipt transaction hash mismatch`);
  }
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block?.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error(`${step.id} receipt block is unavailable or reorged`);
  }
  return { transaction, receipt, block };
}

export async function verifyCanonicalFinalizationEvidence(
  provider: FinalizationProvider,
  step: FinalizationStepPlan,
  evidence: FinalizationReceiptEvidence
): Promise<{
  transaction: providers.TransactionResponse;
  receipt: providers.TransactionReceipt;
  block: providers.Block;
}> {
  const confirmed = await exactReceipt(provider, exactPlan(step), evidence.transactionHash);
  if (
    !confirmed ||
    confirmed.receipt.status !== 1 ||
    confirmed.receipt.blockNumber !== evidence.blockNumber ||
    confirmed.receipt.blockHash.toLowerCase() !== evidence.blockHash.toLowerCase()
  ) {
    throw new Error(`${step.id} canonical transaction/receipt evidence mismatch`);
  }
  return confirmed;
}

async function reconcileOrBroadcast(
  input: FinalizationRunInput,
  journal: FinalizationJournal,
  step: FinalizationJournalStep
): Promise<string> {
  let ownership: ReturnType<typeof loadBroadcastOwnership>;
  try {
    ownership = loadBroadcastOwnership(journal, step, input);
  } catch (error) {
    return abandon(input.journalFile, journal, step.id, (error as Error).message);
  }
  const hadPriorBroadcastBoundary =
    step.state !== 'planned' || step.attemptHashes.length > 0 || ownership !== undefined;
  const recorded = step.attemptHashes[step.attemptHashes.length - 1];
  if (recorded) {
    const transaction = await input.provider.getTransaction(recorded);
    const receipt = await input.provider.getTransactionReceipt(recorded);
    if (transaction && !transactionMatchesPlan(transaction, step)) {
      return abandon(input.journalFile, journal, step.id, 'recorded transaction does not match exact plan');
    }
    if (transaction || receipt) return recorded;
  }

  let latestNonce: number | undefined;
  let pendingNonce: number | undefined;
  if (!hadPriorBroadcastBoundary) {
    [latestNonce, pendingNonce] = await Promise.all([
      input.provider.getTransactionCount(step.from, 'latest'),
      input.provider.getTransactionCount(step.from, 'pending'),
    ]);
  }

  // An untouched step with both canonical and pending account nonces exactly at
  // its planned nonce cannot already have a canonical transaction. Account
  // nonces are monotonic, so rescanning the preparation boundary is neither
  // necessary nor useful on this pristine path. Recovery and any observed nonce
  // advance still require the bounded canonical-history proof below.
  const observedNonceAdvance =
    latestNonce !== undefined && pendingNonce !== undefined && (latestNonce > step.nonce || pendingNonce > step.nonce);
  let discovered: providers.TransactionResponse | undefined;
  if (hadPriorBroadcastBoundary || observedNonceAdvance) {
    try {
      discovered = await findTransactionByNonce(input.provider, journal, step);
    } catch (error) {
      return abandon(input.journalFile, journal, step.id, (error as Error).message);
    }
  }
  if (discovered) {
    if (!transactionMatchesPlan(discovered, step)) {
      return abandon(input.journalFile, journal, step.id, 'signer nonce was consumed by different calldata');
    }
    if (recorded && recorded.toLowerCase() !== discovered.hash.toLowerCase()) {
      return abandon(
        input.journalFile,
        journal,
        step.id,
        'canonical transaction hash differs from the one recorded broadcast attempt'
      );
    }
    if (!ownership) {
      return abandon(input.journalFile, journal, step.id, 'canonical transaction has no exclusive broadcast ownership');
    }
    if (!recorded) {
      step.attemptHashes.push(discovered.hash);
    }
    step.broadcastOwnership = ownership.ownership;
    step.broadcastOwnershipSha256 = ownership.sha256;
    step.state = 'broadcast';
    persist(input.journalFile, journal);
    return discovered.hash;
  }

  if (hadPriorBroadcastBoundary) {
    if (ownership && ownershipIsActive(ownership.ownership)) {
      throw new Error(`${step.id} broadcast ownership is held by an active finalizer; no second send is permitted`);
    }
    return abandon(
      input.journalFile,
      journal,
      step.id,
      'prior broadcast intent/attempt has no exact canonical transaction; rebroadcast is forbidden'
    );
  }

  if (latestNonce === undefined || pendingNonce === undefined) {
    [latestNonce, pendingNonce] = await Promise.all([
      input.provider.getTransactionCount(step.from, 'latest'),
      input.provider.getTransactionCount(step.from, 'pending'),
    ]);
  }
  if (latestNonce > step.nonce || pendingNonce > step.nonce) {
    return abandon(
      input.journalFile,
      journal,
      step.id,
      'signer nonce was consumed but exact transaction is unavailable'
    );
  }
  if (latestNonce < step.nonce || pendingNonce < step.nonce) {
    return abandon(input.journalFile, journal, step.id, 'signer nonce has a gap before the planned transaction');
  }

  try {
    await input.assertFreshBeforeBroadcast(step);
  } catch (error) {
    return abandon(
      input.journalFile,
      journal,
      step.id,
      `signed Stork snapshot is not fresh: ${(error as Error).message}`
    );
  }
  let claimed: ReturnType<typeof claimBroadcastOwnership>;
  try {
    claimed = claimBroadcastOwnership(journal, step, input);
  } catch (error) {
    let racedOwnership: ReturnType<typeof loadBroadcastOwnership>;
    try {
      racedOwnership = loadBroadcastOwnership(journal, step, input);
    } catch (loadError) {
      return abandon(input.journalFile, journal, step.id, (loadError as Error).message);
    }
    if (racedOwnership && ownershipIsActive(racedOwnership.ownership)) {
      throw new Error(`${step.id} broadcast ownership was atomically claimed by another active finalizer`);
    }
    return abandon(
      input.journalFile,
      journal,
      step.id,
      `broadcast ownership could not be claimed without rebroadcast risk: ${(error as Error).message}`
    );
  }
  activeBroadcastOwners.add(claimed.ownership.ownerToken);
  try {
    step.broadcastOwnership = claimed.ownership;
    step.broadcastOwnershipSha256 = claimed.sha256;
    step.state = 'broadcast_intent';
    persist(input.journalFile, journal);
    input.testOnlyAfterIntentBeforeSend?.(step);
    const sent = await input.signer.sendTransaction({
      from: step.from,
      to: step.to,
      nonce: step.nonce,
      value: 0,
      data: step.calldata,
    });
    input.testOnlyAfterSendBeforePersist?.(step, sent.hash);
    if (!utils.isHexString(sent.hash, 32)) {
      return abandon(input.journalFile, journal, step.id, 'provider returned an invalid transaction hash');
    }
    step.attemptHashes.push(sent.hash);
    step.state = 'broadcast';
    persist(input.journalFile, journal);
    input.testOnlyAfterBroadcastPersist?.(step, sent.hash);
    return sent.hash;
  } finally {
    activeBroadcastOwners.delete(claimed.ownership.ownerToken);
  }
}

export async function runDurableFinalization(input: FinalizationRunInput): Promise<FinalizationJournal> {
  requireReleaseStateHostIdentity(input.expected.releaseStateHostIdentity, input);
  if (
    portableArtifactReference(input.journalFile, input.manifestFile) !== input.expected.manifestReference ||
    resolvePortableArtifactReference(input.journalFile, input.expected.manifestReference) !==
      path.resolve(input.manifestFile)
  ) {
    throw new Error('finalization packet journal/manifest binding is invalid');
  }
  const boundaryLease = acquireBoundaryLease(input.expected, input);
  let operationFailed = false;
  let acceptanceCommitStarted = false;
  let stableAcceptancePersisted = false;
  try {
    input.testOnlyAfterBoundaryLeaseAcquired?.(boundaryLease.file);
    assertBoundaryNotAlreadyAccepted(input.expected, input);
    const runtimeValidation = { testOnlyLockRoot: input.testOnlyLockRoot, requireRuntimeOwnership: true };
    const journal = reserveFinalizationJournal(
      input.journalFile,
      input.manifestFile,
      input.expected,
      runtimeValidation
    );
    if (journal.status === 'abandoned') {
      throw new Error(
        `finalization journal is terminally abandoned: ${journal.terminal?.outcome || 'unknown outcome'}`
      );
    }

    for (const step of journal.steps) {
      const wasFinalized = step.state === 'finalized';
      let transactionHash: string;
      if (step.state === 'confirmed' || step.state === 'finalized') {
        transactionHash = step.receipt!.transactionHash;
      } else {
        transactionHash = await reconcileOrBroadcast(input, journal, step);
      }

      let confirmed: Awaited<ReturnType<typeof exactReceipt>>;
      try {
        confirmed = await exactReceipt(input.provider, step, transactionHash);
        if (!confirmed) {
          await input.provider.waitForTransaction(transactionHash, 1);
          confirmed = await exactReceipt(input.provider, step, transactionHash);
        }
      } catch (error) {
        return abandon(input.journalFile, journal, step.id, (error as Error).message);
      }
      if (!confirmed) {
        throw new Error(`${step.id} is broadcast but has no confirmed receipt; rerun finalization to reconcile`);
      }
      if (confirmed.receipt.status !== 1) {
        return abandon(input.journalFile, journal, step.id, 'transaction reverted');
      }
      try {
        await input.verifyConfirmedStep(step, confirmed.receipt, confirmed.block);
      } catch (error) {
        return abandon(input.journalFile, journal, step.id, (error as Error).message);
      }
      if (!wasFinalized) {
        step.receipt = {
          transactionHash,
          blockNumber: confirmed.receipt.blockNumber,
          blockHash: confirmed.receipt.blockHash,
          status: 1,
        };
        step.state = 'confirmed';
        delete step.finality;
        persist(input.journalFile, journal);
      }
    }

    input.testOnlyBeforeFinality?.(journal);
    for (const step of journal.steps) {
      const transactionHash = step.receipt!.transactionHash;
      let confirmed: Awaited<ReturnType<typeof exactReceipt>>;
      try {
        if (step.state !== 'finalized') {
          await input.provider.waitForTransaction(transactionHash, journal.finalityConfirmations);
        }
        confirmed = await exactReceipt(input.provider, step, transactionHash);
      } catch (error) {
        return abandon(
          input.journalFile,
          journal,
          step.id,
          `failed finality reconciliation: ${(error as Error).message}`
        );
      }
      if (!confirmed) {
        return abandon(input.journalFile, journal, step.id, 'receipt disappeared before 12-confirmation finality');
      }
      const headBlock = await input.provider.getBlockNumber();
      const confirmationsObserved = headBlock - confirmed.receipt.blockNumber + 1;
      if (confirmationsObserved < journal.finalityConfirmations) {
        throw new Error(
          `${step.id} has ${confirmationsObserved}/${journal.finalityConfirmations} confirmations; rerun finalization`
        );
      }
      try {
        await input.verifyConfirmedStep(step, confirmed.receipt, confirmed.block);
      } catch (error) {
        return abandon(input.journalFile, journal, step.id, `finality evidence failed: ${(error as Error).message}`);
      }
      step.state = 'finalized';
      step.finality = {
        confirmationsRequired: journal.finalityConfirmations,
        confirmationsObserved,
        observedHeadBlock: headBlock,
        recordedAt: new Date().toISOString(),
      };
      persist(input.journalFile, journal);
    }

    journal.status = 'complete';
    delete journal.terminal;
    persist(input.journalFile, journal);
    const acceptedJournalSha256 = fileSha256(input.journalFile);
    if (input.commitAcceptedEvidence) {
      acceptanceCommitStarted = true;
      markBoundaryAcceptanceIndeterminate(boundaryLease);
      await input.commitAcceptedEvidence({ journal, journalSha256: acceptedJournalSha256 });
      input.testOnlyAfterAcceptedEvidenceCommit?.();
    }
    if (fileSha256(input.journalFile) !== acceptedJournalSha256) {
      throw new Error('finalization journal changed after accepted evidence commit');
    }
    if (input.commitAcceptedEvidence) {
      persistAcceptedBoundaryRecord({
        expected: input.expected,
        journalFile: input.journalFile,
        manifestFile: input.manifestFile,
        journalSha256: acceptedJournalSha256,
        options: input,
      });
      stableAcceptancePersisted = true;
    }
    return journal;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    const preserveIndeterminateAcceptance = acceptanceCommitStarted && !stableAcceptancePersisted;
    if (!input.testOnlyPreserveBoundaryLeaseOnExit && !preserveIndeterminateAcceptance) {
      try {
        releaseBoundaryLease(boundaryLease);
      } catch (releaseError) {
        if (!operationFailed) throw releaseError;
      }
    }
  }
}

export function assertSingleAddProductEvent(
  receipt: Pick<ContractReceipt, 'logs'>,
  perpEngine: string,
  productId: number
): void {
  const event = new utils.Interface(['event AddProduct(uint32 productId)']);
  const topic = event.getEventTopic('AddProduct').toLowerCase();
  const matching = receipt.logs.filter(
    (log) => utils.getAddress(log.address) === utils.getAddress(perpEngine) && log.topics[0]?.toLowerCase() === topic
  );
  if (matching.length !== 1) throw new Error(`product ${productId} receipt must contain exactly one AddProduct event`);
  const parsed = event.parseLog(matching[0]);
  if (!BigNumber.from(parsed.args.productId).eq(productId)) {
    throw new Error(`AddProduct event product ID mismatch for ${productId}`);
  }
}
