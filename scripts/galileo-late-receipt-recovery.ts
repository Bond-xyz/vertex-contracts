import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { providers } from 'ethers';
import {
  FinalizationJournal,
  FinalizationProvider,
  FinalizationRunInput,
  FinalizationStepPlan,
  loadAndValidateFinalizationJournal,
  portableArtifactReference,
  validateFinalizationJournalValue,
  verifyCanonicalFinalizationEvidence,
} from './galileo-finalization-journal';

export const LATE_RECEIPT_VISIBILITY_OUTCOME =
  'no matching receipts found: this may indicate potential data corruption';
export const LATE_RECEIPT_RECOVERY_KIND = 'galileo_late_canonical_receipt_recovery';
export const LATE_RECEIPT_RECOVERY_EXPLANATION =
  'The original finalizer failed closed when its RPC could not see any receipt. No transaction was resent. This packet accepts only the five originally recorded hashes after canonical receipt, finality, signed-price freshness, and live-state verification.';

export type LateReceiptRecoveryEvidence = {
  schemaVersion: 1;
  kind: typeof LATE_RECEIPT_RECOVERY_KIND;
  explanation: typeof LATE_RECEIPT_RECOVERY_EXPLANATION;
  originalJournalReference: string;
  originalJournalSha256: string;
  originalTerminal: NonNullable<FinalizationJournal['terminal']>;
  preparedFileName: string;
  preparedFileSha256: string;
  snapshotFileName: string;
  snapshotFileSha256: string;
  snapshotEvidenceSha256: string;
  recoveredAt: string;
  canonicalHeadBlock: number;
  confirmationsRequired: 12;
  noTransactionsBroadcast: true;
  receiptBlocks: Array<{
    stepId: string;
    transactionHash: string;
    blockNumber: number;
    blockHash: string;
    confirmationsObserved: number;
  }>;
};

export type RecoveredFinalizationJournal = FinalizationJournal & {
  recovery: LateReceiptRecoveryEvidence;
};

export type LateReceiptRecoveryInput = {
  originalJournalFile: string;
  originalManifestFile: string;
  recoveredJournalFile: string;
  recoveredManifestFile: string;
  preparedFile: string;
  snapshotFile: string;
  snapshotEvidenceSha256: string;
  expected: FinalizationRunInput['expected'];
  provider: FinalizationProvider;
  verifyReceiptBlock: (
    step: FinalizationStepPlan,
    receipt: providers.TransactionReceipt,
    block: providers.Block
  ) => Promise<void>;
  verifyLiveState: (journal: RecoveredFinalizationJournal) => Promise<void>;
  buildManifest: (input: {
    journal: RecoveredFinalizationJournal;
    journalSha256: string;
    recovery: LateReceiptRecoveryEvidence;
  }) => Promise<Record<string, any>> | Record<string, any>;
  testOnlyLockRoot?: string;
  now?: () => Date;
};

type AcceptedRecoveryRecord = {
  schemaVersion: 1;
  kind: typeof LATE_RECEIPT_RECOVERY_KIND;
  originalJournalSha256: string;
  recoveredJournalFileName: string;
  recoveredManifestFileName: string;
  recoveredJournalSha256: string;
  recoveredManifestSha256: string;
  recoveredJournalBytesBase64: string;
  recoveredManifestBytesBase64: string;
  acceptedAt: string;
};

type RecoveryLease = {
  schemaVersion: 1;
  kind: typeof LATE_RECEIPT_RECOVERY_KIND;
  originalJournalSha256: string;
  ownerPid: number;
  ownerToken: string;
  acquiredAt: string;
};

const PRODUCTION_RELEASE_LOCK_ROOT = path.join(
  os.homedir(),
  '.local',
  'state',
  'bond-perpdex',
  'galileo-release-locks'
);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256Bytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file: string): string {
  return sha256Bytes(fs.readFileSync(file));
}

function requireSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value || '')) throw new Error(`${label} must be one SHA-256`);
  return value.toLowerCase();
}

function exactJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function fsyncDirectory(directoryPath: string): void {
  try {
    const descriptor = fs.openSync(directoryPath, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // The file itself is still fsynced on filesystems that reject directory fsync.
  }
}

function writeExclusiveBytes(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.recovery-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(path.dirname(file));
  } finally {
    fs.unlinkSync(temporary);
  }
  if (!fs.readFileSync(file).equals(bytes)) throw new Error(`exclusive recovery artifact readback failed: ${file}`);
}

function removeExactFile(file: string, expectedBytes: Buffer): void {
  if (!fs.existsSync(file)) return;
  const actual = fs.readFileSync(file);
  if (!actual.equals(expectedBytes)) {
    throw new Error(`refusing cleanup because recovery artifact bytes changed: ${file}`);
  }
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function releaseStateRoot(input: Pick<LateReceiptRecoveryInput, 'testOnlyLockRoot'>): string {
  return input.testOnlyLockRoot ? path.resolve(input.testOnlyLockRoot) : PRODUCTION_RELEASE_LOCK_ROOT;
}

function stateFile(input: LateReceiptRecoveryInput, originalJournalSha256: string, suffix: string): string {
  return path.join(releaseStateRoot(input), `galileo-late-receipts-${originalJournalSha256}.${suffix}.json`);
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  return decoded;
}

function validateAcceptedRecovery(record: AcceptedRecoveryRecord, originalJournalSha256: string): void {
  if (
    record.schemaVersion !== 1 ||
    record.kind !== LATE_RECEIPT_RECOVERY_KIND ||
    record.originalJournalSha256 !== originalJournalSha256 ||
    path.basename(record.recoveredJournalFileName || '') !== record.recoveredJournalFileName ||
    path.basename(record.recoveredManifestFileName || '') !== record.recoveredManifestFileName ||
    !record.acceptedAt
  ) {
    throw new Error('accepted late-receipt recovery record is invalid');
  }
  const journalBytes = decodeCanonicalBase64(record.recoveredJournalBytesBase64, 'accepted recovered journal bytes');
  const manifestBytes = decodeCanonicalBase64(record.recoveredManifestBytesBase64, 'accepted recovered manifest bytes');
  if (
    sha256Bytes(journalBytes) !== requireSha256(record.recoveredJournalSha256, 'accepted journal SHA-256') ||
    sha256Bytes(manifestBytes) !== requireSha256(record.recoveredManifestSha256, 'accepted manifest SHA-256')
  ) {
    throw new Error('accepted late-receipt recovery bytes do not match immutable hashes');
  }
}

function assertNoPriorRecovery(input: LateReceiptRecoveryInput, originalJournalSha256: string): void {
  const acceptedFile = stateFile(input, originalJournalSha256, 'accepted');
  if (!fs.existsSync(acceptedFile)) return;
  const accepted = JSON.parse(fs.readFileSync(acceptedFile, 'utf8')) as AcceptedRecoveryRecord;
  validateAcceptedRecovery(accepted, originalJournalSha256);
  throw new Error('the abandoned finalization journal already has one accepted late-receipt recovery packet');
}

function acquireLease(
  input: LateReceiptRecoveryInput,
  originalJournalSha256: string
): { file: string; lease: RecoveryLease } {
  const file = stateFile(input, originalJournalSha256, 'lease');
  const lease: RecoveryLease = {
    schemaVersion: 1,
    kind: LATE_RECEIPT_RECOVERY_KIND,
    originalJournalSha256,
    ownerPid: process.pid,
    ownerToken: crypto.randomBytes(16).toString('hex'),
    acquiredAt: new Date().toISOString(),
  };
  try {
    writeExclusiveBytes(file, exactJsonBytes(lease));
  } catch (error) {
    throw new Error(
      `late-receipt recovery lease already exists; automatic takeover is forbidden: ${(error as Error).message}`
    );
  }
  return { file, lease };
}

function releaseLease(handle: { file: string; lease: RecoveryLease }): void {
  const expected = exactJsonBytes(handle.lease);
  if (!fs.existsSync(handle.file) || !fs.readFileSync(handle.file).equals(expected)) {
    throw new Error('late-receipt recovery lease ownership changed before release');
  }
  fs.unlinkSync(handle.file);
  fsyncDirectory(path.dirname(handle.file));
}

function exactTerminalJournal(journal: FinalizationJournal): void {
  if (
    journal.status !== 'abandoned' ||
    journal.terminal?.stepId !== 'endpoint.initialize' ||
    journal.terminal.outcome !== LATE_RECEIPT_VISIBILITY_OUTCOME
  ) {
    throw new Error('late-receipt recovery is allowed only for the exact known receipt-visibility terminal outcome');
  }
  if (
    journal.steps.length !== 5 ||
    journal.steps.some(
      (step) =>
        step.state !== 'broadcast' ||
        step.attemptHashes.length !== 1 ||
        !step.broadcastOwnership ||
        !step.broadcastOwnershipSha256 ||
        step.receipt !== undefined ||
        step.finality !== undefined
    )
  ) {
    throw new Error(
      'late-receipt recovery requires all five original broadcasts with one owned hash and no receipt claim'
    );
  }
}

function assertPacketPaths(input: LateReceiptRecoveryInput): void {
  const original = path.resolve(input.originalJournalFile);
  const recoveredJournal = path.resolve(input.recoveredJournalFile);
  const recoveredManifest = path.resolve(input.recoveredManifestFile);
  if (
    new Set([original, recoveredJournal, recoveredManifest]).size !== 3 ||
    path.dirname(original) !== path.dirname(recoveredJournal) ||
    path.dirname(original) !== path.dirname(recoveredManifest)
  ) {
    throw new Error('original and recovered journal/manifest must be three distinct files in one packet directory');
  }
  if (fs.existsSync(recoveredJournal) || fs.existsSync(recoveredManifest)) {
    throw new Error('recovered journal/manifest target already exists; overwrite is forbidden');
  }
}

function validateManifestBinding(
  manifest: Record<string, any>,
  journal: RecoveredFinalizationJournal,
  journalSha256: string
): void {
  if (manifest.schemaVersion !== 9 || typeof manifest.finalization?.journalReference !== 'string') {
    throw new Error('recovered deployment manifest must retain schema version 9 and a journal reference');
  }
  if (
    manifest.finalization?.journalSha256 !== journalSha256 ||
    manifest.finalization?.planSha256 !== journal.planSha256 ||
    manifest.finalization?.status !== 'complete' ||
    manifest.finalization?.leaseScope !== journal.leaseScope ||
    manifest.finalization?.finalityConfirmations !== 12 ||
    manifest.finalization?.startingNonce !== journal.startingNonce ||
    manifest.finalization?.scanFromBlock !== journal.scanFromBlock ||
    canonicalJson(manifest.finalization?.steps) !== canonicalJson(journal.steps) ||
    canonicalJson(manifest.recovery) !== canonicalJson(journal.recovery)
  ) {
    throw new Error('recovered deployment manifest is not exactly bound to the recovered finalization journal');
  }
}

export function assertLateReceiptRecoveryLinkage(input: {
  manifestFile: string;
  manifest: Record<string, any>;
  journalFile: string;
  journal: RecoveredFinalizationJournal;
  originalJournalFile?: string;
  preparedFile?: string;
  snapshotFile?: string;
}): void {
  const recovery = input.journal.recovery;
  if (
    !recovery ||
    recovery.schemaVersion !== 1 ||
    recovery.kind !== LATE_RECEIPT_RECOVERY_KIND ||
    recovery.explanation !== LATE_RECEIPT_RECOVERY_EXPLANATION ||
    recovery.originalTerminal?.stepId !== 'endpoint.initialize' ||
    recovery.originalTerminal?.outcome !== LATE_RECEIPT_VISIBILITY_OUTCOME ||
    recovery.confirmationsRequired !== 12 ||
    recovery.noTransactionsBroadcast !== true ||
    !Number.isSafeInteger(recovery.canonicalHeadBlock) ||
    recovery.canonicalHeadBlock < 0 ||
    recovery.receiptBlocks?.length !== 5 ||
    recovery.receiptBlocks.some(
      (receipt, index) =>
        receipt.stepId !== input.journal.steps[index].id ||
        receipt.transactionHash.toLowerCase() !== input.journal.steps[index].receipt?.transactionHash.toLowerCase() ||
        receipt.blockNumber !== input.journal.steps[index].receipt?.blockNumber ||
        receipt.blockHash.toLowerCase() !== input.journal.steps[index].receipt?.blockHash.toLowerCase() ||
        receipt.confirmationsObserved < 12
    )
  ) {
    throw new Error('late-receipt recovery metadata is invalid or incomplete');
  }
  const expectedJournalReference = portableArtifactReference(input.manifestFile, input.journalFile);
  if (
    input.manifest.finalization?.journalReference !== expectedJournalReference ||
    input.journal.manifestReference !== portableArtifactReference(input.journalFile, input.manifestFile)
  ) {
    throw new Error('late-receipt recovery packet uses a non-portable journal/manifest reference');
  }
  validateManifestBinding(input.manifest, input.journal, sha256File(input.journalFile));
  if (input.originalJournalFile) {
    if (
      portableArtifactReference(input.journalFile, input.originalJournalFile) !== recovery.originalJournalReference ||
      sha256File(input.originalJournalFile) !== recovery.originalJournalSha256
    ) {
      throw new Error('late-receipt recovery original abandoned journal linkage changed');
    }
    const original = JSON.parse(fs.readFileSync(input.originalJournalFile, 'utf8')) as FinalizationJournal;
    exactTerminalJournal(original);
    if (
      original.steps.some(
        (step, index) =>
          step.id !== input.journal.steps[index].id ||
          step.attemptHashes[0].toLowerCase() !== input.journal.steps[index].attemptHashes[0].toLowerCase()
      )
    ) {
      throw new Error('late-receipt recovery hashes do not match the original abandoned journal');
    }
  }
  for (const [file, expectedSha256, label] of [
    [input.preparedFile, recovery.preparedFileSha256, 'prepared deployment'],
    [input.snapshotFile, recovery.snapshotFileSha256, 'signed Stork snapshot'],
  ] as const) {
    if (file && sha256File(file) !== expectedSha256) throw new Error(`late-receipt recovery ${label} linkage changed`);
  }
}

export async function recoverLateCanonicalReceipts(input: LateReceiptRecoveryInput): Promise<{
  journal: RecoveredFinalizationJournal;
  manifest: Record<string, any>;
  journalSha256: string;
  manifestSha256: string;
}> {
  assertPacketPaths(input);
  const originalBytes = fs.readFileSync(input.originalJournalFile);
  const originalJournalSha256 = sha256Bytes(originalBytes);
  const preparedFileSha256 = sha256File(input.preparedFile);
  const snapshotFileSha256 = sha256File(input.snapshotFile);
  const snapshotEvidenceSha256 = requireSha256(input.snapshotEvidenceSha256, 'snapshot evidence SHA-256');
  if (preparedFileSha256 !== input.expected.preparedFileSha256) {
    throw new Error('prepared deployment bytes do not match the terminal journal identity');
  }
  if (snapshotEvidenceSha256 !== input.expected.snapshotSha256) {
    throw new Error('signed Stork snapshot evidence does not match the terminal journal identity');
  }
  if (
    input.expected.manifestReference !==
    portableArtifactReference(input.originalJournalFile, input.originalManifestFile)
  ) {
    throw new Error('terminal journal expected manifest reference is not exact');
  }

  assertNoPriorRecovery(input, originalJournalSha256);
  const lease = acquireLease(input, originalJournalSha256);
  let operationFailed = false;
  try {
    assertNoPriorRecovery(input, originalJournalSha256);
    const runtimeValidation = { testOnlyLockRoot: input.testOnlyLockRoot, requireRuntimeOwnership: true };
    const original = loadAndValidateFinalizationJournal(input.originalJournalFile, input.expected, runtimeValidation);
    exactTerminalJournal(original);
    if (!fs.readFileSync(input.originalJournalFile).equals(originalBytes)) {
      throw new Error('original terminal journal changed during recovery preflight');
    }

    const canonical = [] as Array<{
      step: FinalizationStepPlan;
      receipt: providers.TransactionReceipt;
      block: providers.Block;
      confirmationsObserved: number;
    }>;
    for (const step of original.steps) {
      const transactionHash = step.attemptHashes[0];
      const waited = await input.provider.waitForTransaction(transactionHash, 12);
      if (!waited) throw new Error(`${step.id} canonical receipt is unavailable after waiting for finality`);
      const evidence = {
        transactionHash,
        blockNumber: waited.blockNumber,
        blockHash: waited.blockHash,
        status: 1 as const,
      };
      if (waited.status !== 1) throw new Error(`${step.id} recorded transaction reverted`);
      const confirmed = await verifyCanonicalFinalizationEvidence(input.provider, step, evidence);
      await input.verifyReceiptBlock(step, confirmed.receipt, confirmed.block);
      canonical.push({ step, ...confirmed, confirmationsObserved: 0 });
    }
    if (canonical.some((item, index) => index > 0 && item.block.number < canonical[index - 1].block.number)) {
      throw new Error('late-receipt recovery blocks do not preserve the exact signer nonce order');
    }
    const headBlock = await input.provider.getBlockNumber();
    for (const item of canonical) {
      item.confirmationsObserved = headBlock - item.receipt.blockNumber + 1;
      if (item.confirmationsObserved < 12) {
        throw new Error(`${item.step.id} has only ${item.confirmationsObserved}/12 canonical confirmations`);
      }
    }
    const recovery: LateReceiptRecoveryEvidence = {
      schemaVersion: 1,
      kind: LATE_RECEIPT_RECOVERY_KIND,
      explanation: LATE_RECEIPT_RECOVERY_EXPLANATION,
      originalJournalReference: portableArtifactReference(input.recoveredJournalFile, input.originalJournalFile),
      originalJournalSha256,
      originalTerminal: original.terminal!,
      preparedFileName: path.basename(input.preparedFile),
      preparedFileSha256,
      snapshotFileName: path.basename(input.snapshotFile),
      snapshotFileSha256,
      snapshotEvidenceSha256,
      recoveredAt: (input.now?.() || new Date()).toISOString(),
      canonicalHeadBlock: headBlock,
      confirmationsRequired: 12,
      noTransactionsBroadcast: true,
      receiptBlocks: canonical.map((item) => ({
        stepId: item.step.id,
        transactionHash: item.receipt.transactionHash,
        blockNumber: item.receipt.blockNumber,
        blockHash: item.receipt.blockHash,
        confirmationsObserved: item.confirmationsObserved,
      })),
    };
    const journal = {
      ...original,
      manifestReference: portableArtifactReference(input.recoveredJournalFile, input.recoveredManifestFile),
      status: 'complete' as const,
      steps: original.steps.map((step, index) => ({
        ...step,
        state: 'finalized' as const,
        receipt: {
          transactionHash: canonical[index].receipt.transactionHash,
          blockNumber: canonical[index].receipt.blockNumber,
          blockHash: canonical[index].receipt.blockHash,
          status: 1 as const,
        },
        finality: {
          confirmationsRequired: 12,
          confirmationsObserved: canonical[index].confirmationsObserved,
          observedHeadBlock: headBlock,
          recordedAt: recovery.recoveredAt,
        },
      })),
      recovery,
    } as RecoveredFinalizationJournal;
    delete journal.terminal;
    const recoveredExpected = {
      ...input.expected,
      manifestReference: portableArtifactReference(input.recoveredJournalFile, input.recoveredManifestFile),
    };
    validateFinalizationJournalValue(input.recoveredJournalFile, journal, recoveredExpected, runtimeValidation);
    await input.verifyLiveState(journal);

    // Re-read every receipt after live-state queries so a reorg between receipt
    // collection and acceptance cannot produce a packet.
    for (const [index, item] of canonical.entries()) {
      const reverified = await verifyCanonicalFinalizationEvidence(
        input.provider,
        item.step,
        journal.steps[index].receipt!
      );
      await input.verifyReceiptBlock(item.step, reverified.receipt, reverified.block);
    }
    if (!fs.readFileSync(input.originalJournalFile).equals(originalBytes)) {
      throw new Error('original terminal journal changed during late-receipt verification');
    }

    const journalBytes = exactJsonBytes(journal);
    const journalSha256 = sha256Bytes(journalBytes);
    const manifest = await input.buildManifest({ journal, journalSha256, recovery });
    manifest.recovery = recovery;
    if (
      manifest.finalization?.journalReference !==
      portableArtifactReference(input.recoveredManifestFile, input.recoveredJournalFile)
    ) {
      throw new Error('recovered manifest builder returned the wrong journal reference');
    }
    validateManifestBinding(manifest, journal, journalSha256);
    const manifestBytes = exactJsonBytes(manifest);
    const manifestSha256 = sha256Bytes(manifestBytes);
    const accepted: AcceptedRecoveryRecord = {
      schemaVersion: 1,
      kind: LATE_RECEIPT_RECOVERY_KIND,
      originalJournalSha256,
      recoveredJournalFileName: path.basename(input.recoveredJournalFile),
      recoveredManifestFileName: path.basename(input.recoveredManifestFile),
      recoveredJournalSha256: journalSha256,
      recoveredManifestSha256: manifestSha256,
      recoveredJournalBytesBase64: journalBytes.toString('base64'),
      recoveredManifestBytesBase64: manifestBytes.toString('base64'),
      acceptedAt: recovery.recoveredAt,
    };
    validateAcceptedRecovery(accepted, originalJournalSha256);
    const acceptedFile = stateFile(input, originalJournalSha256, 'accepted');
    const acceptedBytes = exactJsonBytes(accepted);
    let journalCommitted = false;
    let manifestCommitted = false;
    try {
      writeExclusiveBytes(input.recoveredJournalFile, journalBytes);
      journalCommitted = true;
      writeExclusiveBytes(input.recoveredManifestFile, manifestBytes);
      manifestCommitted = true;
      writeExclusiveBytes(acceptedFile, acceptedBytes);
    } catch (error) {
      if (manifestCommitted) removeExactFile(input.recoveredManifestFile, manifestBytes);
      if (journalCommitted) removeExactFile(input.recoveredJournalFile, journalBytes);
      throw error;
    }
    try {
      if (!fs.readFileSync(input.originalJournalFile).equals(originalBytes)) {
        throw new Error('original terminal journal changed after recovered packet commit');
      }
      assertLateReceiptRecoveryLinkage({
        manifestFile: input.recoveredManifestFile,
        manifest,
        journalFile: input.recoveredJournalFile,
        journal,
        originalJournalFile: input.originalJournalFile,
        preparedFile: input.preparedFile,
        snapshotFile: input.snapshotFile,
      });
    } catch (error) {
      removeExactFile(acceptedFile, acceptedBytes);
      removeExactFile(input.recoveredManifestFile, manifestBytes);
      removeExactFile(input.recoveredJournalFile, journalBytes);
      throw error;
    }
    return { journal, manifest, journalSha256, manifestSha256 };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      releaseLease(lease);
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}
