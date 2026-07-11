import fs from 'fs';
import path from 'path';
import { BigNumber, BigNumberish, constants, utils } from 'ethers';
import type { Artifacts } from 'hardhat/types';
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
export const RELEASE_ATTESTATION_SCHEMA_VERSION = 2;
export const ACTIVE_GALILEO_RELEASE_POLICY_STATUS = 'approved_for_galileo_testnet_release';

export type GalileoReleaseReviewer = {
  name: string;
  address: string;
};

export type GalileoReleasePolicy = {
  schemaVersion: number;
  policyId: string;
  policyVersion: number;
  projectId: string;
  releaseId: string;
  attestationDomain: { name: string; version: string };
  chainId: number;
  collateral: { address: string; productId: number; symbol: string; decimals: number };
  approvalMode: 'external_reviewer_signature' | 'tracked_red_testnet_approval';
  requiredReviewerSignatures: number;
  reviewers: GalileoReleaseReviewer[];
  redApprovalArtifact: string | null;
  mainnetExternalReviewRequired: boolean;
  status: string;
};

export type GalileoDeploymentIntent = {
  schemaVersion: number;
  projectId: string;
  releaseId: string;
  chainId: number;
  deploymentId: string;
  deploymentNonce: string;
  expiresAt: number;
  deployer: string;
  sequencer: string;
  firstTransactionNonce: number;
  expectedFirstContract: string;
};

export type ReleaseAttestationPayload = {
  schemaVersion: number;
  policyId: string;
  policyVersion: number;
  policySha256: string;
  projectId: string;
  releaseId: string;
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
  deploymentId: string;
  deploymentNonce: string;
  expiresAt: number;
  deployer: string;
  sequencer: string;
  firstTransactionNonce: number;
  expectedFirstContract: string;
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
  deploymentIntent: GalileoDeploymentIntent;
};

export const RELEASE_ATTESTATION_TYPES = {
  ReleaseAttestation: [
    { name: 'schemaVersion', type: 'uint256' },
    { name: 'policyId', type: 'string' },
    { name: 'policyVersion', type: 'uint256' },
    { name: 'policySha256', type: 'bytes32' },
    { name: 'projectId', type: 'string' },
    { name: 'releaseId', type: 'string' },
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
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'deploymentNonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'deployer', type: 'address' },
    { name: 'sequencer', type: 'address' },
    { name: 'firstTransactionNonce', type: 'uint64' },
    { name: 'expectedFirstContract', type: 'address' },
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

function normalizedUintString(value: BigNumberish, label: string, allowZero = false): string {
  let parsed: BigNumber;
  try {
    parsed = BigNumber.from(value);
  } catch {
    throw new Error(`${label} must be an unsigned integer`);
  }
  if (parsed.lt(0) || (!allowZero && parsed.isZero())) {
    throw new Error(`${label} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  if (parsed.gt(BigNumber.from(2).pow(256).sub(1))) throw new Error(`${label} exceeds uint256`);
  return parsed.toString();
}

function safeUintNumber(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
  return value;
}

function nonzeroAddress(value: string, label: string): string {
  const address = utils.getAddress(value);
  if (address === constants.AddressZero) throw new Error(`${label} must not be the zero address`);
  return address;
}

type DeploymentIntentIdentity = Omit<GalileoDeploymentIntent, 'schemaVersion' | 'deploymentId'>;

export function deploymentIntentId(intent: DeploymentIntentIdentity): string {
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['string', 'string', 'uint256', 'uint256', 'uint64', 'address', 'address', 'uint64', 'address'],
      [
        intent.projectId,
        intent.releaseId,
        intent.chainId,
        intent.deploymentNonce,
        intent.expiresAt,
        intent.deployer,
        intent.sequencer,
        intent.firstTransactionNonce,
        intent.expectedFirstContract,
      ]
    )
  );
}

export function createGalileoDeploymentIntent(input: {
  deploymentNonce: BigNumberish;
  expiresAt: number;
  deployer: string;
  sequencer: string;
  firstTransactionNonce: number;
}): GalileoDeploymentIntent {
  const deployer = nonzeroAddress(input.deployer, 'deployment intent deployer');
  const sequencer = nonzeroAddress(input.sequencer, 'deployment intent sequencer');
  const firstTransactionNonce = safeUintNumber(
    input.firstTransactionNonce,
    'deployment intent first transaction nonce',
    true
  );
  const identity: DeploymentIntentIdentity = {
    projectId: GALILEO_PROJECT_ID,
    releaseId: GALILEO_RELEASE_ID,
    chainId: GALILEO_CHAIN_ID,
    deploymentNonce: normalizedUintString(input.deploymentNonce, 'deployment intent nonce'),
    expiresAt: safeUintNumber(input.expiresAt, 'deployment intent expiry'),
    deployer,
    sequencer,
    firstTransactionNonce,
    expectedFirstContract: utils.getContractAddress({ from: deployer, nonce: firstTransactionNonce }),
  };
  return {
    schemaVersion: 1,
    ...identity,
    deploymentId: deploymentIntentId(identity),
  };
}

export function validateDeploymentIntent(intent: GalileoDeploymentIntent): GalileoDeploymentIntent {
  exactKeys(
    intent as unknown as Record<string, unknown>,
    [
      'schemaVersion',
      'projectId',
      'releaseId',
      'chainId',
      'deploymentId',
      'deploymentNonce',
      'expiresAt',
      'deployer',
      'sequencer',
      'firstTransactionNonce',
      'expectedFirstContract',
    ],
    'deployment intent'
  );
  if (
    intent.schemaVersion !== 1 ||
    intent.projectId !== GALILEO_PROJECT_ID ||
    intent.releaseId !== GALILEO_RELEASE_ID ||
    intent.chainId !== GALILEO_CHAIN_ID
  ) {
    throw new Error('deployment intent project/release/chain identity mismatch');
  }
  const normalized = createGalileoDeploymentIntent({
    deploymentNonce: intent.deploymentNonce,
    expiresAt: intent.expiresAt,
    deployer: intent.deployer,
    sequencer: intent.sequencer,
    firstTransactionNonce: intent.firstTransactionNonce,
  });
  if (utils.getAddress(intent.expectedFirstContract) !== normalized.expectedFirstContract) {
    throw new Error('deployment intent expected first contract does not match deployer nonce');
  }
  if (!utils.isHexString(intent.deploymentId, 32) || intent.deploymentId.toLowerCase() !== normalized.deploymentId) {
    throw new Error('deployment intent ID does not match its canonical identity');
  }
  return normalized;
}

export function loadDeploymentIntent(file: string): GalileoDeploymentIntent {
  return validateDeploymentIntent(readJson<GalileoDeploymentIntent>(path.resolve(file)));
}

export function assertDeploymentIntentAvailableForFirstTransaction(
  intent: GalileoDeploymentIntent,
  actual: {
    deployer: string;
    sequencer: string;
    pendingNonce: number;
    chainTimestamp: number;
    expectedFirstContractCode: string;
  }
): void {
  const expected = validateDeploymentIntent(intent);
  if (utils.getAddress(actual.deployer) !== expected.deployer) {
    throw new Error('deployment intent deployer does not match the transaction signer');
  }
  if (utils.getAddress(actual.sequencer) !== expected.sequencer) {
    throw new Error('deployment intent sequencer does not match the configured sequencer');
  }
  if (safeUintNumber(actual.pendingNonce, 'pending deployer nonce', true) !== expected.firstTransactionNonce) {
    throw new Error('deployment intent is stale or already consumed: deployer nonce changed');
  }
  if (safeUintNumber(actual.chainTimestamp, 'latest chain timestamp', true) >= expected.expiresAt) {
    throw new Error('deployment intent has expired');
  }
  if (actual.expectedFirstContractCode !== '0x') {
    throw new Error('deployment intent is already consumed: expected first contract address has bytecode');
  }
}

export function validateReleasePolicy(policy: GalileoReleasePolicy): GalileoReleasePolicy {
  exactKeys(
    policy as unknown as Record<string, unknown>,
    [
      'schemaVersion',
      'policyId',
      'policyVersion',
      'projectId',
      'releaseId',
      'attestationDomain',
      'chainId',
      'collateral',
      'approvalMode',
      'requiredReviewerSignatures',
      'reviewers',
      'redApprovalArtifact',
      'mainnetExternalReviewRequired',
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
    policy.projectId !== GALILEO_PROJECT_ID ||
    policy.releaseId !== GALILEO_RELEASE_ID ||
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
  if (!Array.isArray(policy.reviewers)) throw new Error('release policy reviewers must be an array');
  const normalizedReviewers = policy.reviewers.map((reviewer, index) => {
    exactKeys(reviewer as unknown as Record<string, unknown>, ['name', 'address'], `release reviewer ${index}`);
    if (!reviewer.name.trim()) throw new Error(`release reviewer ${index} must have a tracked name`);
    return { name: reviewer.name, address: utils.getAddress(reviewer.address) };
  });
  if (new Set(normalizedReviewers.map((reviewer) => reviewer.address)).size !== normalizedReviewers.length) {
    throw new Error('release policy reviewer addresses must be unique');
  }
  if (policy.mainnetExternalReviewRequired !== true) {
    throw new Error('Galileo testnet policy must not waive mainnet external review');
  }
  if (policy.approvalMode === 'external_reviewer_signature') {
    if (policy.requiredReviewerSignatures !== 1 || policy.redApprovalArtifact !== null) {
      throw new Error('external reviewer policy requires one signature and no Red approval artifact');
    }
  } else if (policy.approvalMode === 'tracked_red_testnet_approval') {
    if (
      policy.chainId !== GALILEO_CHAIN_ID ||
      policy.requiredReviewerSignatures !== 0 ||
      normalizedReviewers.length !== 0 ||
      policy.redApprovalArtifact !== 'config/galileo.red-testnet-approval.json'
    ) {
      throw new Error('tracked Red approval is restricted to Galileo testnet with no synthetic reviewer wallet');
    }
  } else {
    throw new Error(`unsupported release approval mode: ${policy.approvalMode}`);
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
  deploymentIntent: GalileoDeploymentIntent;
}): ReleaseAttestationPayload {
  const deploymentIntent = validateDeploymentIntent(input.deploymentIntent);
  if (
    deploymentIntent.projectId !== input.policy.projectId ||
    deploymentIntent.releaseId !== input.policy.releaseId ||
    deploymentIntent.chainId !== input.policy.chainId
  ) {
    throw new Error('deployment intent does not match tracked release policy identity');
  }
  return {
    schemaVersion: RELEASE_ATTESTATION_SCHEMA_VERSION,
    policyId: input.policy.policyId,
    policyVersion: input.policy.policyVersion,
    policySha256: normalizedSha256(input.policySha256, 'release policy SHA-256'),
    projectId: input.policy.projectId,
    releaseId: input.policy.releaseId,
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
    deploymentId: deploymentIntent.deploymentId,
    deploymentNonce: deploymentIntent.deploymentNonce,
    expiresAt: deploymentIntent.expiresAt,
    deployer: deploymentIntent.deployer,
    sequencer: deploymentIntent.sequencer,
    firstTransactionNonce: deploymentIntent.firstTransactionNonce,
    expectedFirstContract: deploymentIntent.expectedFirstContract,
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
  if (policy.approvalMode !== 'external_reviewer_signature') {
    throw new Error('signed external reviewer attestations are not the configured Galileo testnet approval mode');
  }
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

function resolveDeploymentIntent(input: {
  deploymentIntent?: GalileoDeploymentIntent;
  deploymentIntentFile?: string;
}): GalileoDeploymentIntent {
  if ((input.deploymentIntent ? 1 : 0) + (input.deploymentIntentFile ? 1 : 0) !== 1) {
    throw new Error('exactly one deployment intent object or file is required');
  }
  return input.deploymentIntent
    ? validateDeploymentIntent(input.deploymentIntent)
    : loadDeploymentIntent(input.deploymentIntentFile as string);
}

export function assertManifestOperatorsMatchSignedIntent(
  evidence: VerifiedReleaseEvidence,
  manifest: { deployer: string; sequencer: string }
): void {
  const deployer = nonzeroAddress(manifest.deployer, 'deployment manifest deployer');
  const sequencer = nonzeroAddress(manifest.sequencer, 'deployment manifest sequencer');
  if (deployer !== evidence.deploymentIntent.deployer || sequencer !== evidence.deploymentIntent.sequencer) {
    throw new Error('deployment manifest operators do not match signed deployment intent');
  }
  assertIndependentReleaseReviewer(evidence.reviewer.address, deployer, sequencer);
}

export async function collectUnsignedReleaseReviewRequest(input: {
  artifacts: Artifacts;
  productsFile: string;
  verifierFile: string;
  deploymentIntent?: GalileoDeploymentIntent;
  deploymentIntentFile?: string;
  repoRoot?: string;
}) {
  const repoRoot = input.repoRoot || repositoryRoot();
  const { policy, policyFile, policySha256 } = loadTrackedReleasePolicy(repoRoot);
  const source = loadCurrentCleanSourceEvidence(repoRoot);
  const products = loadProducts(input.productsFile, { requireApproved: false });
  const verifierConfig = loadVerifierConfig(input.verifierFile);
  const deploymentIntent = resolveDeploymentIntent(input);
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
    deploymentIntent,
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
    deploymentIntent,
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
  deploymentIntent?: GalileoDeploymentIntent;
  deploymentIntentFile?: string;
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
  const deploymentIntent = resolveDeploymentIntent(input);
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
    deploymentIntent,
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
    deploymentIntent,
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
    ['deployment intent ID', preflight.deploymentIntent.deploymentId, postflight.deploymentIntent.deploymentId],
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
