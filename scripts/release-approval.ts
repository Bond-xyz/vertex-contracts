import path from 'path';
import type { Artifacts } from 'hardhat/types';
import { GalileoProducts, PERPDEX_NETWORK, ReleaseApprovalMode, VerifierConfig } from './deployment-config';
import {
  assertIndependentReleaseReviewer,
  collectAndVerifyReleaseEvidence,
  GalileoDeploymentIntent,
  GalileoReleasePolicy,
  SignedReleaseAttestation,
} from './release-attestation';
import { ReleaseBuildEvidence, repositoryRoot, ReviewedSourceEvidence, sha256File } from './release-evidence';
import {
  collectAndVerifyRedTestnetReleaseEvidence,
  RedTestnetApproval,
  TRACKED_RED_GALILEO_APPROVAL,
} from './red-testnet-approval';
import {
  ProductReviewResult,
  TRACKED_GALILEO_PRODUCT_REVIEW,
  TRACKED_GALILEO_PRODUCTS,
  validateProductApprovalReview,
} from './validate-galileo-product-review';
import { GalileoStaticReleasePolicy } from './stork-deployment-snapshot';

// One verified release-approval shape for both approval modes: the tracked Red
// testnet artifact (Galileo) and a signed external reviewer attestation (mainnet).
export type VerifiedReleaseApproval = {
  mode: ReleaseApprovalMode;
  approvalFile: string;
  approvalSha256: string;
  approvalDigest: string;
  approval: RedTestnetApproval | SignedReleaseAttestation;
  approver: { name: string; address: string | null; role: string; mode: string };
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

export type ReleaseApprovalInput = {
  artifacts: Artifacts;
  productsFile: string;
  productReviewFile: string;
  verifierFile: string;
  deploymentIntentFile: string;
  approvalFile?: string;
  attestationFile?: string;
  repoRoot?: string;
};

function requireTrackedFile(repoRoot: string, supplied: string, tracked: string, label: string): string {
  const expected = path.resolve(repoRoot, tracked);
  if (path.resolve(supplied) !== expected)
    throw new Error(`${label} must be the tracked repository artifact ${tracked}`);
  return expected;
}

export async function collectAndVerifyReleaseApproval(input: ReleaseApprovalInput): Promise<VerifiedReleaseApproval> {
  const repoRoot = input.repoRoot || repositoryRoot();
  if (PERPDEX_NETWORK.approvalMode === 'tracked_red_testnet_approval') {
    const red = await collectAndVerifyRedTestnetReleaseEvidence({ ...input, repoRoot });
    return {
      ...red,
      mode: 'tracked_red_testnet_approval',
      approver: {
        name: 'Red',
        address: null,
        role: 'product_and_release_owner',
        mode: 'tracked_galileo_testnet_artifact',
      },
    };
  }
  const productsFile = requireTrackedFile(repoRoot, input.productsFile, TRACKED_GALILEO_PRODUCTS, 'products');
  const productReviewFile = requireTrackedFile(
    repoRoot,
    input.productReviewFile,
    TRACKED_GALILEO_PRODUCT_REVIEW,
    'product review'
  );
  const attestationFile = path.resolve(
    input.attestationFile || path.join(repoRoot, PERPDEX_NETWORK.files.releaseAttestation)
  );
  // Verifies the reviewer signature over the exact clean commit/tree, build,
  // products, Stork policy, collateral provenance, verifier quorum and intent.
  const verified = await collectAndVerifyReleaseEvidence({
    artifacts: input.artifacts,
    productsFile,
    verifierFile: input.verifierFile,
    attestationFile,
    deploymentIntentFile: input.deploymentIntentFile,
    repoRoot,
  });
  assertIndependentReleaseReviewer(
    verified.reviewer.address,
    verified.deploymentIntent.deployer,
    verified.deploymentIntent.sequencer
  );
  const productReview = validateProductApprovalReview(repoRoot, { requireApproved: true });
  return {
    mode: 'external_reviewer_signature',
    approvalFile: attestationFile,
    approvalSha256: sha256File(attestationFile),
    approvalDigest: verified.attestationDigest,
    approval: verified.attestation,
    approver: {
      name: verified.reviewer.name,
      address: verified.reviewer.address,
      role: 'external_release_reviewer',
      mode: 'external_reviewer_signature',
    },
    policy: verified.policy,
    policyFile: verified.policyFile,
    policySha256: verified.policySha256,
    source: verified.source,
    build: verified.build,
    buildEvidenceSha256: verified.buildEvidenceSha256,
    products: verified.products,
    productConfigSha256: verified.productConfigSha256,
    productReview,
    productReviewSha256: sha256File(productReviewFile),
    staticPolicy: verified.staticPolicy,
    verifierConfig: verified.verifierConfig,
    verifierConfigSha256: verified.verifierConfigSha256,
    deploymentIntent: verified.deploymentIntent,
  };
}

export function assertSameReleaseApproval(before: VerifiedReleaseApproval, after: VerifiedReleaseApproval): void {
  for (const [label, first, second] of [
    ['approval mode', before.mode, after.mode],
    ['approval SHA-256', before.approvalSha256, after.approvalSha256],
    ['approval digest', before.approvalDigest, after.approvalDigest],
    ['approver', before.approver.address || before.approver.name, after.approver.address || after.approver.name],
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

// Manifest key and record for the approval that authorized the deployment.
export function releaseApprovalManifestRecord(evidence: VerifiedReleaseApproval) {
  const redMode = evidence.mode === 'tracked_red_testnet_approval';
  return {
    key: redMode ? ('redTestnetApproval' as const) : ('externalReviewerApproval' as const),
    record: {
      policyFile: PERPDEX_NETWORK.files.releasePolicy,
      policyId: evidence.policy.policyId,
      policyVersion: evidence.policy.policyVersion,
      policySha256: evidence.policySha256,
      approvalFile: redMode ? TRACKED_RED_GALILEO_APPROVAL : PERPDEX_NETWORK.files.releaseAttestation,
      approvalSha256: evidence.approvalSha256,
      digest: evidence.approvalDigest,
      approval: evidence.approval,
    },
  };
}
