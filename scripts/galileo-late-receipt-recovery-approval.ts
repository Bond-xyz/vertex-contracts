import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';
import { GALILEO_CHAIN_ID, GALILEO_PROJECT_ID, GALILEO_RELEASE_ID } from './deployment-config';
import type { FinalizationJournal } from './galileo-finalization-journal';
import { deterministicSha256, repositoryRoot, sha256File } from './release-evidence';

export const TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL = 'config/galileo.late-receipt-recovery-approval.json';
export const GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL_SCHEMA_VERSION = 1;
export const GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL_DECISION = 'authorize_exact_read_only_late_receipt_recovery';
export const INITIAL_LATE_RECEIPT_RECOVERY_COMMIT = '40438aebba30f6b409cf46819317669a778c2393';

export const AUTHORIZED_LATE_RECEIPT_RECOVERY_SOURCE_FILES = [
  'hardhat.config.ts',
  'package.json',
  'scripts/galileo-finalization-journal.ts',
  'scripts/galileo-late-receipt-recovery-approval.ts',
  'scripts/galileo-late-receipt-recovery.ts',
  'scripts/recover-galileo-late-receipts.ts',
  'scripts/red-testnet-approval.ts',
  'scripts/verify-galileo-deployment.ts',
  'test/galileo-late-receipt-recovery.test.ts',
] as const;

export type GalileoLateReceiptRecoveryApproval = {
  schemaVersion: 1;
  approvalId: 'bond-perpdex-red-galileo-v2-late-receipt-recovery';
  scope: 'exact_galileo_testnet_late_receipt_recovery_only';
  projectId: string;
  releaseId: string;
  chainId: number;
  approver: { name: 'Red'; role: 'product_and_release_owner' };
  decision: typeof GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL_DECISION;
  approvedAt: string;
  mainnetExternalReviewWaived: false;
  candidateApproval: {
    file: 'config/galileo.red-testnet-approval.json';
    sha256: string;
    digest: string;
    releaseCommit: string;
    sourceTree: string;
    deploymentIntentId: string;
  };
  recoverySource: {
    initialRecoveryCommit: string;
    implementationCommit: string;
    implementationTree: string;
    authorizedFiles: Array<{ file: string; sha256: string }>;
  };
  deployment: {
    deployer: string;
    preparedFileName: 'prepared.local.json';
    preparedFileSha256: string;
    snapshotFileName: 'galileo.stork-deployment-snapshot.local.json';
    snapshotFileSha256: string;
    snapshotEvidenceSha256: string;
    abandonedJournalFileName: 'finalization.local.json';
    abandonedJournalSha256: string;
    finalizationPlanSha256: string;
    startingNonce: number;
    originalTerminal: { stepId: 'endpoint.initialize'; outcome: string; recordedAt: string };
    transactionHashes: string[];
    confirmationsRequired: 12;
  };
  controls: {
    noTransactionSigning: true;
    noTransactionBroadcast: true;
    originalJournalImmutable: true;
    recoveredPacketWrittenSeparately: true;
  };
};

export type VerifiedGalileoLateReceiptRecoveryApproval = {
  approval: GalileoLateReceiptRecoveryApproval;
  approvalFile: string;
  approvalSha256: string;
  approvalDigest: string;
};

export type RedCandidateApprovalBinding = {
  approvalFile: string;
  approvalSha256: string;
  approvalDigest: string;
  releaseCommit: string;
  sourceTree: string;
  deploymentIntentId: string;
};

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitBytes(repoRoot: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitObject(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value || '')) throw new Error(`${label} must be a 40-character Git object`);
  return value.toLowerCase();
}

function sha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value || '')) throw new Error(`${label} must be one SHA-256`);
  return value.toLowerCase();
}

function sha256Bytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalTimestamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value || '')) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a real UTC timestamp`);
  const canonical = new Date(parsed).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function requireAncestor(repoRoot: string, ancestor: string, descendant: string, label: string): void {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch {
    throw new Error(label);
  }
}

function validateApprovalIdentity(approval: GalileoLateReceiptRecoveryApproval): void {
  if (
    approval.schemaVersion !== GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL_SCHEMA_VERSION ||
    approval.approvalId !== 'bond-perpdex-red-galileo-v2-late-receipt-recovery' ||
    approval.scope !== 'exact_galileo_testnet_late_receipt_recovery_only' ||
    approval.projectId !== GALILEO_PROJECT_ID ||
    approval.releaseId !== GALILEO_RELEASE_ID ||
    approval.chainId !== GALILEO_CHAIN_ID ||
    approval.approver?.name !== 'Red' ||
    approval.approver?.role !== 'product_and_release_owner' ||
    approval.decision !== GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL_DECISION ||
    approval.mainnetExternalReviewWaived !== false ||
    approval.candidateApproval?.file !== 'config/galileo.red-testnet-approval.json' ||
    approval.deployment?.preparedFileName !== 'prepared.local.json' ||
    approval.deployment?.snapshotFileName !== 'galileo.stork-deployment-snapshot.local.json' ||
    approval.deployment?.abandonedJournalFileName !== 'finalization.local.json' ||
    approval.deployment?.originalTerminal?.stepId !== 'endpoint.initialize' ||
    approval.deployment?.confirmationsRequired !== 12 ||
    approval.controls?.noTransactionSigning !== true ||
    approval.controls?.noTransactionBroadcast !== true ||
    approval.controls?.originalJournalImmutable !== true ||
    approval.controls?.recoveredPacketWrittenSeparately !== true
  ) {
    throw new Error('tracked Galileo late-receipt recovery approval identity or scope mismatch');
  }
  canonicalTimestamp(approval.approvedAt, 'late-receipt recovery approval timestamp');
  canonicalTimestamp(approval.deployment.originalTerminal.recordedAt, 'approved original terminal timestamp');
  utils.getAddress(approval.deployment.deployer);
  gitObject(approval.candidateApproval.releaseCommit, 'approved candidate release commit');
  gitObject(approval.candidateApproval.sourceTree, 'approved candidate source tree');
  gitObject(approval.recoverySource.initialRecoveryCommit, 'initial recovery commit');
  gitObject(approval.recoverySource.implementationCommit, 'recovery implementation commit');
  gitObject(approval.recoverySource.implementationTree, 'recovery implementation tree');
  for (const [value, label] of [
    [approval.candidateApproval.sha256, 'candidate approval'],
    [approval.candidateApproval.digest, 'candidate approval digest'],
    [approval.candidateApproval.deploymentIntentId.replace(/^0x/, ''), 'deployment intent'],
    [approval.deployment.preparedFileSha256, 'prepared deployment'],
    [approval.deployment.snapshotFileSha256, 'snapshot file'],
    [approval.deployment.snapshotEvidenceSha256, 'snapshot evidence'],
    [approval.deployment.abandonedJournalSha256, 'abandoned journal'],
    [approval.deployment.finalizationPlanSha256, 'finalization plan'],
  ] as const) {
    sha256(value, `${label} SHA-256`);
  }
  if (!Number.isSafeInteger(approval.deployment.startingNonce) || approval.deployment.startingNonce < 0) {
    throw new Error('approved late-receipt recovery starting nonce is invalid');
  }
  if (
    approval.deployment.transactionHashes.length !== 5 ||
    new Set(approval.deployment.transactionHashes.map((hash) => hash.toLowerCase())).size !== 5 ||
    approval.deployment.transactionHashes.some((hash) => !utils.isHexString(hash, 32))
  ) {
    throw new Error('approved late-receipt recovery must pin five distinct transaction hashes');
  }
}

function validateAuthorizedSource(repoRoot: string, approval: GalileoLateReceiptRecoveryApproval): void {
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) throw new Error('refusing late-receipt recovery from a dirty source tree');
  const head = gitObject(git(repoRoot, ['rev-parse', 'HEAD']), 'current recovery checkout commit');
  const releaseCommit = gitObject(approval.candidateApproval.releaseCommit, 'candidate release commit');
  const implementationCommit = gitObject(
    approval.recoverySource.implementationCommit,
    'recovery implementation commit'
  );
  const initialRecoveryCommit = gitObject(approval.recoverySource.initialRecoveryCommit, 'initial recovery commit');
  if (initialRecoveryCommit !== INITIAL_LATE_RECEIPT_RECOVERY_COMMIT) {
    throw new Error('tracked recovery approval does not bind the reviewed initial recovery commit');
  }
  requireAncestor(
    repoRoot,
    releaseCommit,
    initialRecoveryCommit,
    'initial recovery commit is not based on the release'
  );
  requireAncestor(
    repoRoot,
    initialRecoveryCommit,
    implementationCommit,
    'recovery implementation is not based on the reviewed initial recovery commit'
  );
  requireAncestor(repoRoot, implementationCommit, head, 'approved recovery implementation is not an ancestor of HEAD');
  const releaseTree = gitObject(git(repoRoot, ['rev-parse', `${releaseCommit}^{tree}`]), 'candidate release tree');
  const implementationTree = gitObject(
    git(repoRoot, ['rev-parse', `${implementationCommit}^{tree}`]),
    'recovery implementation tree'
  );
  if (
    releaseTree !== gitObject(approval.candidateApproval.sourceTree, 'recorded candidate source tree') ||
    implementationTree !== gitObject(approval.recoverySource.implementationTree, 'recorded recovery tree')
  ) {
    throw new Error('tracked recovery approval source tree does not match its Git commit');
  }
  const expectedFiles = [...AUTHORIZED_LATE_RECEIPT_RECOVERY_SOURCE_FILES].sort();
  const authorizedFiles = approval.recoverySource.authorizedFiles.map((record) => record.file);
  if (
    new Set(authorizedFiles).size !== authorizedFiles.length ||
    JSON.stringify([...authorizedFiles].sort()) !== JSON.stringify(expectedFiles)
  ) {
    throw new Error('tracked recovery approval does not authorize the exact recovery-only source set');
  }
  const changedAtImplementation = git(repoRoot, ['diff', '--name-only', `${releaseCommit}..${implementationCommit}`])
    .split('\n')
    .filter(Boolean)
    .sort();
  const expectedChanged = ['config/galileo.red-testnet-approval.json', ...expectedFiles].sort();
  if (JSON.stringify(changedAtImplementation) !== JSON.stringify(expectedChanged)) {
    throw new Error('recovery implementation changed files outside the exact authorized source set');
  }
  for (const record of approval.recoverySource.authorizedFiles) {
    if (path.posix.normalize(record.file) !== record.file || path.posix.isAbsolute(record.file)) {
      throw new Error('tracked recovery approval contains a non-portable source path');
    }
    const actual = sha256Bytes(gitBytes(repoRoot, ['show', `${implementationCommit}:${record.file}`]));
    if (actual !== sha256(record.sha256, `${record.file} recovery source`)) {
      throw new Error(`authorized recovery source hash mismatch: ${record.file}`);
    }
  }
  const afterImplementation = git(repoRoot, ['diff', '--name-only', `${implementationCommit}..${head}`])
    .split('\n')
    .filter(Boolean);
  if (
    head === implementationCommit ||
    afterImplementation.length !== 1 ||
    afterImplementation[0] !== TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL
  ) {
    throw new Error('only the tracked recovery approval may follow the exact recovery implementation commit');
  }
}

export function loadAndValidateGalileoLateReceiptRecoveryApproval(
  input: {
    repoRoot?: string;
    approvalFile?: string;
    expectedApprovalSha256?: string;
  } = {}
): VerifiedGalileoLateReceiptRecoveryApproval {
  const repoRoot = input.repoRoot || repositoryRoot();
  const approvalFile = path.resolve(
    input.approvalFile || path.join(repoRoot, TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL)
  );
  if (approvalFile !== path.resolve(repoRoot, TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL)) {
    throw new Error('Galileo late-receipt recovery approval must be the tracked repository artifact');
  }
  const approvalSha256 = sha256File(approvalFile);
  const expectedApprovalSha256 = input.expectedApprovalSha256 || process.env.PERPDEX_RECOVERY_AUTHORIZATION_SHA256;
  if (
    !expectedApprovalSha256 ||
    approvalSha256 !== sha256(expectedApprovalSha256, 'externally supplied recovery approval')
  ) {
    throw new Error(
      'PERPDEX_RECOVERY_AUTHORIZATION_SHA256 must externally pin the exact tracked recovery approval bytes'
    );
  }
  const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as GalileoLateReceiptRecoveryApproval;
  validateApprovalIdentity(approval);
  validateAuthorizedSource(repoRoot, approval);
  return {
    approval,
    approvalFile,
    approvalSha256,
    approvalDigest: deterministicSha256(approval),
  };
}

export function assertGalileoLateReceiptRecoveryCandidateBinding(
  verified: VerifiedGalileoLateReceiptRecoveryApproval,
  candidate: RedCandidateApprovalBinding
): void {
  const expected = verified.approval.candidateApproval;
  if (
    path.resolve(candidate.approvalFile) !==
      path.resolve(path.dirname(verified.approvalFile), 'galileo.red-testnet-approval.json') ||
    candidate.approvalSha256 !== expected.sha256 ||
    candidate.approvalDigest !== expected.digest ||
    candidate.releaseCommit.toLowerCase() !== expected.releaseCommit.toLowerCase() ||
    candidate.sourceTree.toLowerCase() !== expected.sourceTree.toLowerCase() ||
    candidate.deploymentIntentId.toLowerCase() !== expected.deploymentIntentId.toLowerCase()
  ) {
    throw new Error('late-receipt recovery approval is not bound to the exact tracked Red candidate approval');
  }
}

export function assertGalileoLateReceiptRecoveryInputs(
  verified: VerifiedGalileoLateReceiptRecoveryApproval,
  input: {
    preparedFile: string;
    snapshotFile: string;
    originalJournalFile: string;
    journal: FinalizationJournal;
  }
): void {
  const expected = verified.approval.deployment;
  if (
    path.basename(input.preparedFile) !== expected.preparedFileName ||
    path.basename(input.snapshotFile) !== expected.snapshotFileName ||
    path.basename(input.originalJournalFile) !== expected.abandonedJournalFileName ||
    sha256File(input.preparedFile) !== expected.preparedFileSha256 ||
    sha256File(input.snapshotFile) !== expected.snapshotFileSha256 ||
    sha256File(input.originalJournalFile) !== expected.abandonedJournalSha256 ||
    input.journal.release !== verified.approval.releaseId ||
    input.journal.chainId !== verified.approval.chainId ||
    utils.getAddress(input.journal.deployer) !== utils.getAddress(expected.deployer) ||
    input.journal.preparedFileSha256 !== expected.preparedFileSha256 ||
    input.journal.snapshotSha256 !== expected.snapshotEvidenceSha256 ||
    input.journal.planSha256 !== expected.finalizationPlanSha256 ||
    input.journal.startingNonce !== expected.startingNonce ||
    input.journal.status !== 'abandoned' ||
    JSON.stringify(input.journal.terminal) !== JSON.stringify(expected.originalTerminal) ||
    input.journal.steps.length !== 5 ||
    input.journal.steps.some(
      (step, index) =>
        step.attemptHashes?.length !== 1 ||
        step.attemptHashes[0].toLowerCase() !== expected.transactionHashes[index].toLowerCase()
    )
  ) {
    throw new Error('local Galileo recovery inputs do not match the externally approved Red v2 packet');
  }
}

export function isExactGalileoLateReceiptRecoveryDeployment(
  manifest: Record<string, any>,
  verified: VerifiedGalileoLateReceiptRecoveryApproval
): boolean {
  const expected = verified.approval;
  return (
    manifest?.release === expected.releaseId &&
    manifest?.network?.chainId === expected.chainId &&
    manifest?.deploymentIntent?.deploymentId?.toLowerCase() ===
      expected.candidateApproval.deploymentIntentId.toLowerCase() &&
    manifest?.deployer &&
    utils.getAddress(manifest.deployer) === utils.getAddress(expected.deployment.deployer) &&
    manifest?.preparation?.preparedFileSha256 === expected.deployment.preparedFileSha256 &&
    manifest?.finalization?.planSha256 === expected.deployment.finalizationPlanSha256 &&
    manifest?.finalization?.startingNonce === expected.deployment.startingNonce
  );
}

export function assertGalileoLateReceiptRecoveryManifestBinding(
  manifest: Record<string, any>,
  verified: VerifiedGalileoLateReceiptRecoveryApproval
): void {
  if (!isExactGalileoLateReceiptRecoveryDeployment(manifest, verified)) {
    throw new Error('deployment manifest is not the exact externally approved Red v2 recovery target');
  }
  const recorded = manifest.source?.lateReceiptRecoveryApproval;
  if (
    !manifest.recovery ||
    !recorded ||
    recorded.approvalFile !== TRACKED_GALILEO_LATE_RECEIPT_RECOVERY_APPROVAL ||
    recorded.approvalSha256 !== verified.approvalSha256 ||
    recorded.digest !== verified.approvalDigest ||
    JSON.stringify(recorded.approval) !== JSON.stringify(verified.approval) ||
    manifest.recovery.originalJournalSha256 !== verified.approval.deployment.abandonedJournalSha256 ||
    manifest.recovery.preparedFileName !== verified.approval.deployment.preparedFileName ||
    manifest.recovery.preparedFileSha256 !== verified.approval.deployment.preparedFileSha256 ||
    manifest.recovery.snapshotFileName !== verified.approval.deployment.snapshotFileName ||
    manifest.recovery.snapshotFileSha256 !== verified.approval.deployment.snapshotFileSha256 ||
    manifest.recovery.snapshotEvidenceSha256 !== verified.approval.deployment.snapshotEvidenceSha256 ||
    JSON.stringify(manifest.recovery.originalTerminal) !==
      JSON.stringify(verified.approval.deployment.originalTerminal) ||
    manifest.recovery.confirmationsRequired !== verified.approval.deployment.confirmationsRequired ||
    manifest.recovery.noTransactionsBroadcast !== true ||
    manifest.gates?.lateCanonicalReceiptRecoveryVerified !== true ||
    manifest.gates?.noRecoveryTransactionBroadcast !== true
  ) {
    throw new Error('exact Red v2 deployment requires the externally approved late-receipt recovery metadata');
  }
}
