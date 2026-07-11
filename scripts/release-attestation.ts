import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';
import type { Artifacts } from 'hardhat/types';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  GalileoProducts,
  loadProducts,
  loadVerifierConfig,
  VerifierConfig,
} from './deployment-config';
import {
  collectReleaseBuildEvidence,
  deterministicSha256,
  loadCurrentCleanSourceEvidence,
  loadReviewedSourceEvidence,
  releaseBuildEvidenceSha256,
  ReleaseBuildEvidence,
  repositoryRoot,
  ReviewedSourceEvidence,
  sha256File,
} from './release-evidence';

export const TRACKED_GALILEO_RELEASE_POLICY = 'config/galileo.release-policy.json';
export const RELEASE_ATTESTATION_SCHEMA_VERSION = 1;
export const ACTIVE_GALILEO_RELEASE_POLICY_STATUS = 'approved_for_galileo_testnet_release';

export type GalileoReleaseReviewer = {
  name: string;
  address: string;
};

export type GalileoReleasePolicy = {
  schemaVersion: number;
  policyId: string;
  policyVersion: number;
  attestationDomain: { name: string; version: string };
  chainId: number;
  collateral: { address: string; productId: number; symbol: string; decimals: number };
  requiredReviewerSignatures: number;
  reviewers: GalileoReleaseReviewer[];
  status: string;
};

export type ReleaseAttestationPayload = {
  schemaVersion: number;
  policyId: string;
  policyVersion: number;
  policySha256: string;
  chainId: number;
  collateralToken: string;
  collateralProductId: number;
  collateralSymbol: string;
  collateralDecimals: number;
  releaseCommit: string;
  sourceTree: string;
  buildEvidenceSha256: string;
  productConfigSha256: string;
  verifierConfigSha256: string;
  verifierSignerCount: number;
  verifierSignerBitmask: number;
};

export type SignedReleaseAttestation = {
  schemaVersion: number;
  payload: ReleaseAttestationPayload;
  signature: string;
};

export type VerifiedReleaseAttestation = {
  attestation: SignedReleaseAttestation;
  attestationDigest: string;
  reviewer: GalileoReleaseReviewer;
};

export type VerifiedReleaseEvidence = VerifiedReleaseAttestation & {
  policy: GalileoReleasePolicy;
  policyFile: string;
  policySha256: string;
  source: ReviewedSourceEvidence;
  build: ReleaseBuildEvidence;
  buildEvidenceSha256: string;
  products: GalileoProducts;
  productConfigSha256: string;
  verifierConfig: VerifierConfig;
  verifierConfigSha256: string;
};

export const RELEASE_ATTESTATION_TYPES = {
  ReleaseAttestation: [
    { name: 'schemaVersion', type: 'uint256' },
    { name: 'policyId', type: 'string' },
    { name: 'policyVersion', type: 'uint256' },
    { name: 'policySha256', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'collateralToken', type: 'address' },
    { name: 'collateralProductId', type: 'uint32' },
    { name: 'collateralSymbol', type: 'string' },
    { name: 'collateralDecimals', type: 'uint8' },
    { name: 'releaseCommit', type: 'string' },
    { name: 'sourceTree', type: 'string' },
    { name: 'buildEvidenceSha256', type: 'bytes32' },
    { name: 'productConfigSha256', type: 'bytes32' },
    { name: 'verifierConfigSha256', type: 'bytes32' },
    { name: 'verifierSignerCount', type: 'uint8' },
    { name: 'verifierSignerBitmask', type: 'uint8' },
  ],
};

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} schema keys mismatch`);
  }
}

function normalizedSha256(value: string, label: string): string {
  const stripped = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(stripped)) throw new Error(`${label} must be a 32-byte SHA-256`);
  return `0x${stripped.toLowerCase()}`;
}

function normalizedGitObject(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a 40-character Git object`);
  return value.toLowerCase();
}

export function validateReleasePolicy(policy: GalileoReleasePolicy): GalileoReleasePolicy {
  exactKeys(
    policy as unknown as Record<string, unknown>,
    [
      'schemaVersion',
      'policyId',
      'policyVersion',
      'attestationDomain',
      'chainId',
      'collateral',
      'requiredReviewerSignatures',
      'reviewers',
      'status',
    ],
    'release policy'
  );
  exactKeys(
    policy.attestationDomain as unknown as Record<string, unknown>,
    ['name', 'version'],
    'release policy attestation domain'
  );
  exactKeys(
    policy.collateral as unknown as Record<string, unknown>,
    ['address', 'productId', 'symbol', 'decimals'],
    'release policy collateral'
  );
  if (
    policy.schemaVersion !== 1 ||
    !policy.policyId ||
    !Number.isSafeInteger(policy.policyVersion) ||
    policy.policyVersion <= 0 ||
    !policy.attestationDomain?.name ||
    !policy.attestationDomain?.version ||
    !policy.status
  ) {
    throw new Error('release policy identity/version is invalid');
  }
  if (
    policy.chainId !== GALILEO_CHAIN_ID ||
    utils.getAddress(policy.collateral.address) !== GALILEO_USDCE_ADDRESS ||
    policy.collateral.productId !== 0 ||
    policy.collateral.symbol !== GALILEO_USDCE_SYMBOL ||
    policy.collateral.decimals !== GALILEO_USDCE_DECIMALS
  ) {
    throw new Error('release policy must pin exact Galileo USDC.e collateral');
  }
  if (policy.requiredReviewerSignatures !== 1) {
    throw new Error('release policy currently requires exactly one signed reviewer attestation');
  }
  if (!Array.isArray(policy.reviewers)) throw new Error('release policy reviewers must be an array');
  const normalizedReviewers = policy.reviewers.map((reviewer, index) => {
    exactKeys(reviewer as unknown as Record<string, unknown>, ['name', 'address'], `release reviewer ${index}`);
    if (!reviewer.name.trim()) throw new Error(`release reviewer ${index} must have a tracked name`);
    return { name: reviewer.name, address: utils.getAddress(reviewer.address) };
  });
  if (new Set(normalizedReviewers.map((reviewer) => reviewer.address)).size !== normalizedReviewers.length) {
    throw new Error('release policy reviewer addresses must be unique');
  }
  return { ...policy, reviewers: normalizedReviewers };
}

export function loadTrackedReleasePolicy(repoRoot = repositoryRoot()): {
  policy: GalileoReleasePolicy;
  policyFile: string;
  policySha256: string;
} {
  const policyFile = path.resolve(repoRoot, TRACKED_GALILEO_RELEASE_POLICY);
  if (!fs.existsSync(policyFile)) throw new Error(`tracked release policy is missing: ${policyFile}`);
  return {
    policy: validateReleasePolicy(readJson<GalileoReleasePolicy>(policyFile)),
    policyFile,
    policySha256: sha256File(policyFile),
  };
}

export function releaseAttestationDomain(policy: GalileoReleasePolicy) {
  return {
    name: policy.attestationDomain.name,
    version: policy.attestationDomain.version,
    chainId: policy.chainId,
  };
}

export function createReleaseAttestationPayload(input: {
  policy: GalileoReleasePolicy;
  policySha256: string;
  source: ReviewedSourceEvidence;
  buildEvidenceSha256: string;
  productConfigSha256: string;
  verifierConfigSha256: string;
  verifierConfig: VerifierConfig;
}): ReleaseAttestationPayload {
  return {
    schemaVersion: RELEASE_ATTESTATION_SCHEMA_VERSION,
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
    policySha256: normalizedSha256(input.policySha256, 'release policy SHA-256'),
    chainId: input.policy.chainId,
    collateralToken: utils.getAddress(input.policy.collateral.address),
    collateralProductId: input.policy.collateral.productId,
    collateralSymbol: input.policy.collateral.symbol,
    collateralDecimals: input.policy.collateral.decimals,
    releaseCommit: normalizedGitObject(input.source.releaseCommit, 'release commit'),
    sourceTree: normalizedGitObject(input.source.sourceTree, 'source tree'),
    buildEvidenceSha256: normalizedSha256(input.buildEvidenceSha256, 'build evidence SHA-256'),
    productConfigSha256: normalizedSha256(input.productConfigSha256, 'product config SHA-256'),
    verifierConfigSha256: normalizedSha256(input.verifierConfigSha256, 'verifier config SHA-256'),
    verifierSignerCount: input.verifierConfig.keys.length,
    verifierSignerBitmask: input.verifierConfig.signerBitmask,
  };
}

export function releaseAttestationDigest(policy: GalileoReleasePolicy, payload: ReleaseAttestationPayload): string {
  return utils._TypedDataEncoder.hash(releaseAttestationDomain(policy), RELEASE_ATTESTATION_TYPES, payload);
}

export function verifySignedReleaseAttestation(
  policy: GalileoReleasePolicy,
  expectedPayload: ReleaseAttestationPayload,
  attestation: SignedReleaseAttestation
): VerifiedReleaseAttestation {
  if (policy.status !== ACTIVE_GALILEO_RELEASE_POLICY_STATUS) {
    throw new Error(`release policy status is not active: ${policy.status}`);
  }
  if (policy.reviewers.length < policy.requiredReviewerSignatures) {
    throw new Error('release policy has no named allowlisted reviewer address; deployment remains blocked');
  }
  exactKeys(
    attestation as unknown as Record<string, unknown>,
    ['schemaVersion', 'payload', 'signature'],
    'signed release attestation'
  );
  if (attestation.schemaVersion !== RELEASE_ATTESTATION_SCHEMA_VERSION) {
    throw new Error('signed release attestation schema version mismatch');
  }
  if (deterministicSha256(attestation.payload) !== deterministicSha256(expectedPayload)) {
    throw new Error('signed release attestation payload is stale or does not match local reviewed evidence');
  }
  if (!utils.isHexString(attestation.signature, 65)) {
    throw new Error('signed release attestation is unsigned or has an invalid signature');
  }
  let recovered: string;
  try {
    recovered = utils.getAddress(
      utils.verifyTypedData(
        releaseAttestationDomain(policy),
        RELEASE_ATTESTATION_TYPES,
        attestation.payload,
        attestation.signature
      )
    );
  } catch (error) {
    throw new Error(
      `signed release attestation signature recovery failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const reviewer = policy.reviewers.find((candidate) => candidate.address === recovered);
  if (!reviewer) throw new Error(`release attestation signer ${recovered} is not allowlisted by tracked policy`);
  return {
    attestation,
    attestationDigest: releaseAttestationDigest(policy, expectedPayload),
    reviewer,
  };
}

export function assertIndependentReleaseReviewer(
  reviewerAddress: string,
  deployerAddress: string,
  sequencerAddress: string
): void {
  const reviewer = utils.getAddress(reviewerAddress);
  for (const [role, operatorAddress] of [
    ['deployer', deployerAddress],
    ['sequencer', sequencerAddress],
  ] as const) {
    if (reviewer === utils.getAddress(operatorAddress)) {
      throw new Error(`release reviewer must be independent from the ${role}`);
    }
  }
}

export async function collectUnsignedReleaseReviewRequest(input: {
  artifacts: Artifacts;
  productsFile: string;
  verifierFile: string;
  repoRoot?: string;
}) {
  const repoRoot = input.repoRoot || repositoryRoot();
  const { policy, policyFile, policySha256 } = loadTrackedReleasePolicy(repoRoot);
  const source = loadCurrentCleanSourceEvidence(repoRoot);
  const products = loadProducts(input.productsFile, { requireApproved: false });
  const verifierConfig = loadVerifierConfig(input.verifierFile);
  const build = await collectReleaseBuildEvidence(input.artifacts);
  const buildEvidenceSha256 = releaseBuildEvidenceSha256(build);
  const productConfigSha256 = sha256File(input.productsFile);
  const verifierConfigSha256 = sha256File(input.verifierFile);
  const payload = createReleaseAttestationPayload({
    policy,
    policySha256,
    source,
    buildEvidenceSha256,
    productConfigSha256,
    verifierConfigSha256,
    verifierConfig,
  });
  const blockers = [
    ...(policy.status !== ACTIVE_GALILEO_RELEASE_POLICY_STATUS
      ? [`release policy status is not ${ACTIVE_GALILEO_RELEASE_POLICY_STATUS}`]
      : []),
    ...(policy.reviewers.length < policy.requiredReviewerSignatures
      ? ['tracked release policy has no named allowlisted reviewer address']
      : []),
    ...(!products.approved ? ['product config approved=false'] : []),
  ];
  return {
    schemaVersion: RELEASE_ATTESTATION_SCHEMA_VERSION,
    requestType: 'unsigned_external_reviewer_signature_request',
    status: blockers.length === 0 ? 'ready_for_external_reviewer_signature' : 'blocked',
    blockers,
    policyFile: path.relative(repoRoot, policyFile).split(path.sep).join('/'),
    reviewerAllowlist: policy.reviewers,
    domain: releaseAttestationDomain(policy),
    types: RELEASE_ATTESTATION_TYPES,
    primaryType: 'ReleaseAttestation',
    payload,
    digest: releaseAttestationDigest(policy, payload),
    acceptedAttestation: false,
  };
}

function loadSignedAttestation(input: {
  attestation?: SignedReleaseAttestation;
  attestationFile?: string;
}): SignedReleaseAttestation {
  if ((input.attestation ? 1 : 0) + (input.attestationFile ? 1 : 0) !== 1) {
    throw new Error('exactly one signed release attestation object or file is required');
  }
  return input.attestation || readJson<SignedReleaseAttestation>(path.resolve(input.attestationFile as string));
}

export async function collectAndVerifyReleaseEvidence(input: {
  artifacts: Artifacts;
  productsFile: string;
  verifierFile: string;
  attestation?: SignedReleaseAttestation;
  attestationFile?: string;
  repoRoot?: string;
}): Promise<VerifiedReleaseEvidence> {
  const repoRoot = input.repoRoot || repositoryRoot();
  const { policy, policyFile, policySha256 } = loadTrackedReleasePolicy(repoRoot);
  if (policy.status !== ACTIVE_GALILEO_RELEASE_POLICY_STATUS) {
    throw new Error(`release policy status is not active: ${policy.status}`);
  }
  if (policy.reviewers.length < policy.requiredReviewerSignatures) {
    throw new Error('release policy has no named allowlisted reviewer address; deployment remains blocked');
  }
  const attestation = loadSignedAttestation(input);
  const source = loadReviewedSourceEvidence(
    repoRoot,
    attestation.payload?.releaseCommit,
    attestation.payload?.sourceTree
  );
  const products = loadProducts(input.productsFile);
  const verifierConfig = loadVerifierConfig(input.verifierFile);
  const build = await collectReleaseBuildEvidence(input.artifacts);
  const buildEvidenceSha256 = releaseBuildEvidenceSha256(build);
  const productConfigSha256 = sha256File(input.productsFile);
  const verifierConfigSha256 = sha256File(input.verifierFile);
  const expectedPayload = createReleaseAttestationPayload({
    policy,
    policySha256,
    source,
    buildEvidenceSha256,
    productConfigSha256,
    verifierConfigSha256,
    verifierConfig,
  });
  const verified = verifySignedReleaseAttestation(policy, expectedPayload, attestation);
  return {
    ...verified,
    policy,
    policyFile,
    policySha256,
    source,
    build,
    buildEvidenceSha256,
    products,
    productConfigSha256,
    verifierConfig,
    verifierConfigSha256,
  };
}

export function assertSameVerifiedReleaseEvidence(
  preflight: VerifiedReleaseEvidence,
  postflight: VerifiedReleaseEvidence
): void {
  for (const [label, before, after] of [
    ['attestation digest', preflight.attestationDigest, postflight.attestationDigest],
    ['attestation signature', preflight.attestation.signature, postflight.attestation.signature],
    ['reviewer', preflight.reviewer.address, postflight.reviewer.address],
    ['release commit', preflight.source.releaseCommit, postflight.source.releaseCommit],
    ['source tree', preflight.source.sourceTree, postflight.source.sourceTree],
    ['policy SHA-256', preflight.policySha256, postflight.policySha256],
    ['build evidence SHA-256', preflight.buildEvidenceSha256, postflight.buildEvidenceSha256],
    ['product config SHA-256', preflight.productConfigSha256, postflight.productConfigSha256],
    ['verifier config SHA-256', preflight.verifierConfigSha256, postflight.verifierConfigSha256],
  ] as const) {
    if (before.toLowerCase() !== after.toLowerCase()) {
      throw new Error(`post-deploy provenance drift: ${label} changed`);
    }
  }
}

export async function executeAfterVerifiedPreflight<TEvidence, TResult>(
  verify: () => Promise<TEvidence>,
  executeTransactions: (evidence: TEvidence) => Promise<TResult>
): Promise<TResult> {
  const evidence = await verify();
  return executeTransactions(evidence);
}

export async function writeAfterVerifiedPostflight<TEvidence, TResult>(
  verify: () => Promise<TEvidence>,
  writeManifest: (evidence: TEvidence) => Promise<TResult>
): Promise<TResult> {
  const evidence = await verify();
  return writeManifest(evidence);
}
