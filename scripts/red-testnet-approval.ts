import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';
import type { Artifacts } from 'hardhat/types';
import {
  GalileoDeploymentIntent,
  GalileoReleasePolicy,
  loadDeploymentIntent,
  loadTrackedReleasePolicy,
  validateDeploymentIntent,
} from './release-attestation';
import {
  collectReleaseBuildEvidence,
  deterministicSha256,
  loadCurrentCleanSourceEvidence,
  releaseBuildEvidenceSha256,
  ReleaseBuildEvidence,
  repositoryRoot,
  ReviewedSourceEvidence,
  sha256File,
} from './release-evidence';
import {
  GALILEO_CHAIN_ID,
  GALILEO_PROJECT_ID,
  GALILEO_RELEASE_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  GalileoProducts,
  loadProducts,
  loadVerifierConfig,
  VerifierConfig,
} from './deployment-config';
import {
  ProductReviewResult,
  TRACKED_GALILEO_PRODUCT_REVIEW,
  TRACKED_GALILEO_PRODUCTS,
  validateProductApprovalReview,
} from './validate-galileo-product-review';
import {
  BACKEND_BETA_COMMIT,
  collectGalileoStaticReleasePolicy,
  GalileoStaticReleasePolicy,
} from './stork-deployment-snapshot';
import {
  assertGalileoLateReceiptRecoveryCandidateBinding,
  loadAndValidateGalileoLateReceiptRecoveryApproval,
  VerifiedGalileoLateReceiptRecoveryApproval,
} from './galileo-late-receipt-recovery-approval';

export const TRACKED_RED_GALILEO_APPROVAL = 'config/galileo.red-testnet-approval.json';
export const RED_TESTNET_APPROVAL_SCHEMA_VERSION = 1;
export const RED_TESTNET_APPROVAL_DECISION = 'approve_exact_galileo_testnet_release';
export const ACTIVE_RED_TESTNET_POLICY_STATUS = 'approved_for_galileo_testnet_release';

export type DeterministicCiEvidence = {
  provider: 'github_actions';
  repository: 'Bond-xyz/vertex-contracts';
  workflow: 'Galileo deterministic release gate';
  runUrl: string;
  headSha: string;
  conclusion: 'success';
  checks: string[];
};

export type IndependentAgentReviewEvidence = {
  agent: string;
  reviewedCommit: string;
  conclusion: 'approved';
  evidenceSha256: string;
  summary: string;
};

export type RedTestnetApproval = {
  schemaVersion: number;
  approvalId: 'bond-perpdex-galileo-red-testnet-release';
  scope: 'galileo_testnet_only';
  projectId: string;
  releaseId: string;
  chainId: number;
  collateral: { address: string; productId: number; symbol: string; decimals: number };
  approver: { name: 'Red'; role: 'product_and_release_owner' };
  decision: 'pending_red_approval' | typeof RED_TESTNET_APPROVAL_DECISION;
  approvedAt: string | null;
  mainnetExternalReviewWaived: false;
  candidate: {
    releaseCommit: string;
    sourceTree: string;
    buildEvidenceSha256: string;
    productConfigSha256: string;
    productReviewSha256: string;
    backendBetaCommit: string;
    storkPolicySha256: string;
    collateralProvenanceSha256: string;
    verifierConfigSha256: string;
    verifierSignerCount: number;
    verifierSignerBitmask: number;
    deploymentIntentId: string;
    deploymentNonce: string;
    expiresAt: number;
    deployer: string;
    sequencer: string;
    firstTransactionNonce: number;
    expectedFirstContract: string;
  };
  deterministicCi: DeterministicCiEvidence;
  independentAgentReviews: IndependentAgentReviewEvidence[];
};

export type VerifiedRedTestnetReleaseEvidence = {
  approval: RedTestnetApproval;
  approvalFile: string;
  approvalSha256: string;
  approvalDigest: string;
  policy: GalileoReleasePolicy;
  policyFile: string;
  policySha256: string;
  source: ReviewedSourceEvidence;
  build: ReleaseBuildEvidence;
  buildEvidenceSha256: string;
  products: GalileoProducts;
  productConfigSha256: string;
  productReview: ProductReviewResult;
  productReviewSha256: string;
  staticPolicy: GalileoStaticReleasePolicy;
  verifierConfig: VerifierConfig;
  verifierConfigSha256: string;
  deploymentIntent: GalileoDeploymentIntent;
};

export type VerifiedRedTestnetRecoveryEvidence = VerifiedRedTestnetReleaseEvidence & {
  lateReceiptRecoveryApproval: VerifiedGalileoLateReceiptRecoveryApproval;
};

export type RedTestnetReleaseEvidenceInput = {
  artifacts: Artifacts;
  productsFile: string;
  productReviewFile: string;
  verifierFile: string;
  deploymentIntentFile: string;
  approvalFile?: string;
  repoRoot?: string;
};

const REQUIRED_CI_CHECKS = ['compile', 'contract-interface-diff', 'release-tests', 'gitleaks'];
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitObject(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a 40-character Git object`);
  return value.toLowerCase();
}

function sha256(value: string, label: string): string {
  const stripped = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(stripped)) throw new Error(`${label} must be a 32-byte SHA-256`);
  return stripped.toLowerCase();
}

function validateCiEvidence(evidence: DeterministicCiEvidence, releaseCommit: string): void {
  if (
    evidence.provider !== 'github_actions' ||
    evidence.repository !== 'Bond-xyz/vertex-contracts' ||
    evidence.workflow !== 'Galileo deterministic release gate' ||
    evidence.conclusion !== 'success' ||
    gitObject(evidence.headSha, 'CI head SHA') !== releaseCommit ||
    !/^https:\/\/github\.com\/Bond-xyz\/vertex-contracts\/actions\/runs\/\d+(?:\/job\/\d+)?$/.test(evidence.runUrl)
  ) {
    throw new Error('deterministic GitHub CI evidence is not bound to the approved release commit');
  }
  for (const check of REQUIRED_CI_CHECKS) {
    if (!evidence.checks.includes(check)) throw new Error(`deterministic CI evidence is missing ${check}`);
  }
}

function validateAgentReviews(reviews: IndependentAgentReviewEvidence[], releaseCommit: string): void {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    throw new Error('at least one independent agent review is required for Galileo testnet approval');
  }
  for (const [index, review] of reviews.entries()) {
    if (
      !review.agent.trim() ||
      review.conclusion !== 'approved' ||
      gitObject(review.reviewedCommit, `agent review ${index} commit`) !== releaseCommit ||
      !review.summary.trim()
    ) {
      throw new Error(`independent agent review ${index} is not an approval of the exact release commit`);
    }
    sha256(review.evidenceSha256, `agent review ${index} evidence SHA-256`);
  }
}

function validatePolicyForRedApproval(policy: GalileoReleasePolicy): void {
  if (
    policy.approvalMode !== 'tracked_red_testnet_approval' ||
    policy.redApprovalArtifact !== TRACKED_RED_GALILEO_APPROVAL ||
    policy.requiredReviewerSignatures !== 0 ||
    policy.reviewers.length !== 0 ||
    policy.mainnetExternalReviewRequired !== true
  ) {
    throw new Error('release policy is not the explicit tracked Red Galileo-testnet approval policy');
  }
}

function requireTrackedReleaseFile(repoRoot: string, supplied: string, tracked: string, label: string): string {
  const expected = path.resolve(repoRoot, tracked);
  if (path.resolve(supplied) !== expected) {
    throw new Error(`${label} must be the tracked repository artifact ${tracked}`);
  }
  return expected;
}

function currentCleanHead(repoRoot: string): string {
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) throw new Error('refusing Red release approval from a dirty source tree');
  return gitObject(git(repoRoot, ['rev-parse', 'HEAD']), 'current release commit');
}

function loadApprovedCandidateSource(repoRoot: string, approval: RedTestnetApproval): ReviewedSourceEvidence {
  const head = currentCleanHead(repoRoot);
  const releaseCommit = gitObject(approval.candidate.releaseCommit, 'approved release commit');
  const sourceTree = gitObject(approval.candidate.sourceTree, 'approved source tree');
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', releaseCommit, head], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch {
    throw new Error('approved release commit is not an ancestor of the deployment checkout');
  }
  const actualTree = gitObject(git(repoRoot, ['rev-parse', `${releaseCommit}^{tree}`]), 'candidate source tree');
  if (actualTree !== sourceTree) throw new Error('approved candidate source tree does not match its Git commit');
  const changed = git(repoRoot, ['diff', '--name-only', `${releaseCommit}..${head}`])
    .split('\n')
    .filter(Boolean);
  const unexpected = changed.filter((file) => file !== TRACKED_RED_GALILEO_APPROVAL);
  if (unexpected.length > 0) {
    throw new Error(`release changed after Red approval candidate: ${unexpected.join(', ')}`);
  }
  if (head === releaseCommit || !changed.includes(TRACKED_RED_GALILEO_APPROVAL)) {
    throw new Error('tracked Red approval must be committed after the exact reviewed candidate');
  }
  return { releaseCommit, sourceTree };
}

function validateApprovalIdentity(approval: RedTestnetApproval): void {
  if (
    approval.schemaVersion !== RED_TESTNET_APPROVAL_SCHEMA_VERSION ||
    approval.approvalId !== 'bond-perpdex-galileo-red-testnet-release' ||
    approval.scope !== 'galileo_testnet_only' ||
    approval.projectId !== GALILEO_PROJECT_ID ||
    approval.releaseId !== GALILEO_RELEASE_ID ||
    approval.chainId !== GALILEO_CHAIN_ID ||
    utils.getAddress(approval.collateral.address) !== GALILEO_USDCE_ADDRESS ||
    approval.collateral.productId !== 0 ||
    approval.collateral.symbol !== GALILEO_USDCE_SYMBOL ||
    approval.collateral.decimals !== GALILEO_USDCE_DECIMALS ||
    approval.approver.name !== 'Red' ||
    approval.approver.role !== 'product_and_release_owner' ||
    approval.mainnetExternalReviewWaived !== false
  ) {
    throw new Error('tracked Red approval identity or Galileo-only scope mismatch');
  }
}

export async function createRedTestnetApprovalDraft(input: {
  artifacts: Artifacts;
  productsFile: string;
  productReviewFile: string;
  verifierFile: string;
  deploymentIntentFile: string;
  deterministicCi: DeterministicCiEvidence;
  independentAgentReviews: IndependentAgentReviewEvidence[];
  repoRoot?: string;
}): Promise<RedTestnetApproval> {
  const repoRoot = input.repoRoot || repositoryRoot();
  const productsFile = requireTrackedReleaseFile(repoRoot, input.productsFile, TRACKED_GALILEO_PRODUCTS, 'products');
  const productReviewFile = requireTrackedReleaseFile(
    repoRoot,
    input.productReviewFile,
    TRACKED_GALILEO_PRODUCT_REVIEW,
    'product review'
  );
  const { policy } = loadTrackedReleasePolicy(repoRoot);
  const staticPolicy = collectGalileoStaticReleasePolicy({ repoRoot });
  validatePolicyForRedApproval(policy);
  if (policy.status !== ACTIVE_RED_TESTNET_POLICY_STATUS) {
    throw new Error(
      'activate the tracked Galileo testnet policy in the reviewed candidate before creating Red approval'
    );
  }
  const source = loadCurrentCleanSourceEvidence(repoRoot);
  const products = loadProducts(productsFile);
  validateProductApprovalReview(repoRoot, { requireApproved: true });
  const verifierConfig = loadVerifierConfig(input.verifierFile);
  const deploymentIntent = loadDeploymentIntent(input.deploymentIntentFile);
  if (
    deploymentIntent.backendBetaCommit !== BACKEND_BETA_COMMIT ||
    sha256(deploymentIntent.storkPolicySha256, 'intent Stork policy SHA-256') !== staticPolicy.policySha256 ||
    sha256(deploymentIntent.collateralProvenanceSha256, 'intent collateral provenance SHA-256') !==
      staticPolicy.collateralProvenanceSha256
  ) {
    throw new Error('deployment intent does not bind the reviewed backend, Stork policy, and collateral provenance');
  }
  const build = await collectReleaseBuildEvidence(input.artifacts);
  const releaseCommit = source.releaseCommit.toLowerCase();
  validateCiEvidence(input.deterministicCi, releaseCommit);
  validateAgentReviews(input.independentAgentReviews, releaseCommit);
  if (!products.approved) throw new Error('product config is not approved');
  return {
    schemaVersion: RED_TESTNET_APPROVAL_SCHEMA_VERSION,
    approvalId: 'bond-perpdex-galileo-red-testnet-release',
    scope: 'galileo_testnet_only',
    projectId: GALILEO_PROJECT_ID,
    releaseId: GALILEO_RELEASE_ID,
    chainId: GALILEO_CHAIN_ID,
    collateral: {
      address: GALILEO_USDCE_ADDRESS,
      productId: 0,
      symbol: GALILEO_USDCE_SYMBOL,
      decimals: GALILEO_USDCE_DECIMALS,
    },
    approver: { name: 'Red', role: 'product_and_release_owner' },
    decision: 'pending_red_approval',
    approvedAt: null,
    mainnetExternalReviewWaived: false,
    candidate: {
      releaseCommit,
      sourceTree: source.sourceTree.toLowerCase(),
      buildEvidenceSha256: releaseBuildEvidenceSha256(build),
      productConfigSha256: sha256File(productsFile),
      productReviewSha256: sha256File(productReviewFile),
      backendBetaCommit: BACKEND_BETA_COMMIT,
      storkPolicySha256: staticPolicy.policySha256,
      collateralProvenanceSha256: staticPolicy.collateralProvenanceSha256,
      verifierConfigSha256: sha256File(input.verifierFile),
      verifierSignerCount: verifierConfig.keys.length,
      verifierSignerBitmask: verifierConfig.signerBitmask,
      deploymentIntentId: deploymentIntent.deploymentId,
      deploymentNonce: deploymentIntent.deploymentNonce,
      expiresAt: deploymentIntent.expiresAt,
      deployer: deploymentIntent.deployer,
      sequencer: deploymentIntent.sequencer,
      firstTransactionNonce: deploymentIntent.firstTransactionNonce,
      expectedFirstContract: deploymentIntent.expectedFirstContract,
    },
    deterministicCi: input.deterministicCi,
    independentAgentReviews: input.independentAgentReviews,
  };
}

async function collectAndVerifyRedTestnetReleaseEvidenceInternal(
  input: RedTestnetReleaseEvidenceInput,
  recoveryApproval?: VerifiedGalileoLateReceiptRecoveryApproval
): Promise<VerifiedRedTestnetReleaseEvidence> {
  const repoRoot = input.repoRoot || repositoryRoot();
  const productsFile = requireTrackedReleaseFile(repoRoot, input.productsFile, TRACKED_GALILEO_PRODUCTS, 'products');
  const productReviewFile = requireTrackedReleaseFile(
    repoRoot,
    input.productReviewFile,
    TRACKED_GALILEO_PRODUCT_REVIEW,
    'product review'
  );
  const { policy, policyFile, policySha256 } = loadTrackedReleasePolicy(repoRoot);
  const staticPolicy = collectGalileoStaticReleasePolicy({ repoRoot });
  validatePolicyForRedApproval(policy);
  if (policy.status !== ACTIVE_RED_TESTNET_POLICY_STATUS) {
    throw new Error(`release policy status is not active: ${policy.status}`);
  }
  const approvalFile = path.resolve(input.approvalFile || path.join(repoRoot, TRACKED_RED_GALILEO_APPROVAL));
  if (approvalFile !== path.resolve(repoRoot, TRACKED_RED_GALILEO_APPROVAL)) {
    throw new Error('Red Galileo approval must be the tracked repository artifact');
  }
  const approval = readJson<RedTestnetApproval>(approvalFile);
  validateApprovalIdentity(approval);
  if (approval.decision !== RED_TESTNET_APPROVAL_DECISION || !approval.approvedAt) {
    throw new Error('tracked Red Galileo approval decision is not approved');
  }
  const approvedAt = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAt)) throw new Error('tracked Red approval timestamp is invalid');
  const source = recoveryApproval
    ? {
        releaseCommit: recoveryApproval.approval.candidateApproval.releaseCommit.toLowerCase(),
        sourceTree: recoveryApproval.approval.candidateApproval.sourceTree.toLowerCase(),
      }
    : loadApprovedCandidateSource(repoRoot, approval);
  validateCiEvidence(approval.deterministicCi, source.releaseCommit);
  validateAgentReviews(approval.independentAgentReviews, source.releaseCommit);
  const build = await collectReleaseBuildEvidence(input.artifacts);
  const buildEvidenceSha256 = releaseBuildEvidenceSha256(build);
  const products = loadProducts(productsFile);
  const productReview = validateProductApprovalReview(repoRoot, { requireApproved: true });
  const productConfigSha256 = sha256File(productsFile);
  const productReviewSha256 = sha256File(productReviewFile);
  const verifierConfig = loadVerifierConfig(input.verifierFile);
  const verifierConfigSha256 = sha256File(input.verifierFile);
  const deploymentIntent = validateDeploymentIntent(loadDeploymentIntent(input.deploymentIntentFile));
  const expected = approval.candidate;
  for (const [label, actual, recorded] of [
    ['build evidence', buildEvidenceSha256, expected.buildEvidenceSha256],
    ['product config', productConfigSha256, expected.productConfigSha256],
    ['product review', productReviewSha256, expected.productReviewSha256],
    ['Stork policy', staticPolicy.policySha256, expected.storkPolicySha256],
    ['collateral provenance', staticPolicy.collateralProvenanceSha256, expected.collateralProvenanceSha256],
    ['verifier config', verifierConfigSha256, expected.verifierConfigSha256],
  ] as const) {
    if (sha256(actual, `${label} SHA-256`) !== sha256(recorded, `approved ${label} SHA-256`)) {
      throw new Error(`${label} changed after tracked Red approval`);
    }
  }
  if (
    expected.backendBetaCommit !== BACKEND_BETA_COMMIT ||
    deploymentIntent.backendBetaCommit !== BACKEND_BETA_COMMIT ||
    sha256(deploymentIntent.storkPolicySha256, 'intent Stork policy SHA-256') !== staticPolicy.policySha256 ||
    sha256(deploymentIntent.collateralProvenanceSha256, 'intent collateral provenance SHA-256') !==
      staticPolicy.collateralProvenanceSha256 ||
    verifierConfig.keys.length !== expected.verifierSignerCount ||
    verifierConfig.signerBitmask !== expected.verifierSignerBitmask ||
    deploymentIntent.deploymentId.toLowerCase() !== expected.deploymentIntentId.toLowerCase() ||
    deploymentIntent.deploymentNonce !== expected.deploymentNonce ||
    deploymentIntent.expiresAt !== expected.expiresAt ||
    deploymentIntent.deployer !== utils.getAddress(expected.deployer) ||
    deploymentIntent.sequencer !== utils.getAddress(expected.sequencer) ||
    deploymentIntent.firstTransactionNonce !== expected.firstTransactionNonce ||
    deploymentIntent.expectedFirstContract !== utils.getAddress(expected.expectedFirstContract)
  ) {
    throw new Error('operators, verifier quorum, or single-use deployment intent changed after Red approval');
  }
  return {
    approval,
    approvalFile,
    approvalSha256: sha256File(approvalFile),
    approvalDigest: deterministicSha256(approval),
    policy,
    policyFile,
    policySha256,
    source,
    build,
    buildEvidenceSha256,
    products,
    productConfigSha256,
    productReview,
    productReviewSha256,
    staticPolicy,
    verifierConfig,
    verifierConfigSha256,
    deploymentIntent,
  };
}

export async function collectAndVerifyRedTestnetReleaseEvidence(
  input: RedTestnetReleaseEvidenceInput
): Promise<VerifiedRedTestnetReleaseEvidence> {
  return collectAndVerifyRedTestnetReleaseEvidenceInternal(input);
}

export async function collectAndVerifyRedTestnetRecoveryEvidence(
  input: RedTestnetReleaseEvidenceInput & { recoveryApprovalFile?: string }
): Promise<VerifiedRedTestnetRecoveryEvidence> {
  const repoRoot = input.repoRoot || repositoryRoot();
  const lateReceiptRecoveryApproval = loadAndValidateGalileoLateReceiptRecoveryApproval({
    repoRoot,
    approvalFile: input.recoveryApprovalFile,
  });
  const evidence = await collectAndVerifyRedTestnetReleaseEvidenceInternal(input, lateReceiptRecoveryApproval);
  assertGalileoLateReceiptRecoveryCandidateBinding(lateReceiptRecoveryApproval, {
    approvalFile: evidence.approvalFile,
    approvalSha256: evidence.approvalSha256,
    approvalDigest: evidence.approvalDigest,
    releaseCommit: evidence.source.releaseCommit,
    sourceTree: evidence.source.sourceTree,
    deploymentIntentId: evidence.deploymentIntent.deploymentId,
  });
  return { ...evidence, lateReceiptRecoveryApproval };
}

export function assertSameVerifiedRedTestnetReleaseEvidence(
  before: VerifiedRedTestnetReleaseEvidence,
  after: VerifiedRedTestnetReleaseEvidence
): void {
  for (const [label, first, second] of [
    ['approval SHA-256', before.approvalSha256, after.approvalSha256],
    ['approval digest', before.approvalDigest, after.approvalDigest],
    ['release commit', before.source.releaseCommit, after.source.releaseCommit],
    ['source tree', before.source.sourceTree, after.source.sourceTree],
    ['policy SHA-256', before.policySha256, after.policySha256],
    ['build evidence SHA-256', before.buildEvidenceSha256, after.buildEvidenceSha256],
    ['product config SHA-256', before.productConfigSha256, after.productConfigSha256],
    ['product review SHA-256', before.productReviewSha256, after.productReviewSha256],
    ['Stork policy SHA-256', before.staticPolicy.policySha256, after.staticPolicy.policySha256],
    [
      'collateral provenance SHA-256',
      before.staticPolicy.collateralProvenanceSha256,
      after.staticPolicy.collateralProvenanceSha256,
    ],
    ['verifier config SHA-256', before.verifierConfigSha256, after.verifierConfigSha256],
    ['deployment intent ID', before.deploymentIntent.deploymentId, after.deploymentIntent.deploymentId],
  ] as const) {
    if (first.toLowerCase() !== second.toLowerCase()) {
      throw new Error(`post-deploy provenance drift: ${label} changed`);
    }
  }
}
