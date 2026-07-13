import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GalileoReleasePolicy, validateReleasePolicy } from './release-attestation';
import { validateStorkDeploymentPolicy, StorkDeploymentPolicy } from './stork-deployment-snapshot';

export const GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT = '4d479bd167d4cc98dce373af214a5d109b9cad33';
export const GALILEO_BACKEND_RUNTIME_SOURCE_TREE = '5d33e2f52f74cf2c2c51a91b53dcc2a21d7068f0';
export const GALILEO_BACKEND_RUNTIME_SOURCE_ARCHIVE_SHA256 =
  'ae23d847e09679226eade064adb7f9b5f7698d1ae1b325dfbf3a383539c9101e';
export const GALILEO_BACKEND_BUILDER_IMAGE_DIGEST =
  'sha256:3f6e6f8d8725a65a2db964bb828850f888d430c68784d661f753144e5d787207';
export const PENDING_RELEASE_STATUS = 'blocked_pending_final_backend_and_release_evidence';
export const ACTIVE_RELEASE_STATUS = 'approved_for_galileo_testnet_release';

const GALILEO_BACKEND_REPOSITORY = 'https://github.com/Bond-xyz/perpdex-rust-backend';
const GALILEO_BACKEND_ARTIFACT_POLICY_KIND = 'bond-perpdex-testnet-reviewed-artifact-policy';
const GALILEO_BACKEND_ARTIFACT_POLICY_APPROVAL = 'approve_exact_linux_amd64_artifact_hashes';
const GALILEO_BACKEND_ARTIFACT_POLICY_REVIEWER = 'spyda600';
const GALILEO_BACKEND_RETENTION_AUTHORIZATION = 'post_money_path_source_hashes_reviewed_for_non_committed_retention';
const GALILEO_BACKEND_SERVICES = ['market-data', 'mm-bot', 'price-oracle', 'settlement', 'trading'] as const;

type BindInput = {
  repoRoot: string;
  artifactPolicyFile: string;
  reviewedArtifactPolicySha256: string;
  sourceCommit: string;
};

type JsonRecord = Record<string, unknown>;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

const requireSha256 = (value: string, label: string): string => {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new Error(`${label} must be a SHA-256`);
  return normalized.toLowerCase();
};

const requireGitCommit = (value: string, label: string): string => {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a 40-character Git commit`);
  return value.toLowerCase();
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireExactKeys(value: unknown, expected: readonly string[], label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
  return value;
}

function requireLowerSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

/**
 * Validate the exact tracked policy consumed by the clean-v1 GCP publisher.
 * Phase-B evidence.json is deliberately not accepted as a substitute: the
 * contract release binds the separately reviewed allowlist policy bytes.
 */
export function validateGalileoBackendArtifactPolicy(value: unknown): void {
  const policy = requireExactKeys(
    value,
    ['approval', 'backendSource', 'kind', 'retentionBuild', 'schemaVersion', 'services', 'status', 'target'],
    'backend artifact policy'
  );
  if (
    policy.schemaVersion !== 1 ||
    policy.kind !== GALILEO_BACKEND_ARTIFACT_POLICY_KIND ||
    policy.status !== 'approved'
  ) {
    throw new Error('backend artifact policy must be the approved Bond PerpDex testnet artifact policy');
  }

  const backendSource = requireExactKeys(
    policy.backendSource,
    ['archiveSha256', 'commit', 'repository', 'tree'],
    'backend artifact policy source'
  );
  if (
    backendSource.repository !== GALILEO_BACKEND_REPOSITORY ||
    backendSource.commit !== GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT ||
    backendSource.tree !== GALILEO_BACKEND_RUNTIME_SOURCE_TREE ||
    backendSource.archiveSha256 !== GALILEO_BACKEND_RUNTIME_SOURCE_ARCHIVE_SHA256
  ) {
    throw new Error('backend artifact policy source does not match the exact reviewed backend source');
  }

  const target = requireExactKeys(policy.target, ['arch', 'os'], 'backend artifact policy target');
  if (target.os !== 'linux' || target.arch !== 'amd64') {
    throw new Error('backend artifact policy target must be linux/amd64');
  }

  const retentionBuild = requireExactKeys(
    policy.retentionBuild,
    ['authorization', 'authorized', 'backendSourceCommit'],
    'backend artifact policy retentionBuild'
  );
  if (
    retentionBuild.authorization !== GALILEO_BACKEND_RETENTION_AUTHORIZATION ||
    retentionBuild.authorized !== true ||
    retentionBuild.backendSourceCommit !== GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT
  ) {
    throw new Error('backend artifact policy retentionBuild is not authorized for the exact reviewed source');
  }

  const approval = requireExactKeys(
    policy.approval,
    ['decision', 'reviewedAt', 'reviewer'],
    'backend artifact policy approval'
  );
  if (
    approval.decision !== GALILEO_BACKEND_ARTIFACT_POLICY_APPROVAL ||
    approval.reviewer !== GALILEO_BACKEND_ARTIFACT_POLICY_REVIEWER ||
    typeof approval.reviewedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(approval.reviewedAt) ||
    Number.isNaN(Date.parse(approval.reviewedAt))
  ) {
    throw new Error('backend artifact policy lacks the exact reviewer approval');
  }

  const services = requireExactKeys(policy.services, GALILEO_BACKEND_SERVICES, 'backend artifact policy services');
  for (const service of GALILEO_BACKEND_SERVICES) {
    const artifact = requireExactKeys(
      services[service],
      ['artifactSha256', 'builderImageDigest', 'recipeSha256', 'sourcePath'],
      `backend artifact policy service ${service}`
    );
    requireLowerSha256(artifact.artifactSha256, `backend artifact policy ${service} artifactSha256`);
    requireLowerSha256(artifact.recipeSha256, `backend artifact policy ${service} recipeSha256`);
    if (artifact.builderImageDigest !== GALILEO_BACKEND_BUILDER_IMAGE_DIGEST) {
      throw new Error(`backend artifact policy ${service} builderImageDigest is not the pinned builder`);
    }
    if (artifact.sourcePath !== `services/${service}`) {
      throw new Error(`backend artifact policy ${service} sourcePath is not exact`);
    }
  }
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.next`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  fs.renameSync(temporary, file);
}

export function bindGalileoBackendRuntime(input: BindInput): {
  sourceCommit: string;
  artifactPolicySha256: string;
  storkPolicyFile: string;
  releasePolicyFile: string;
} {
  const repoRoot = path.resolve(input.repoRoot);
  const artifactPolicyFile = path.resolve(input.artifactPolicyFile);
  const sourceCommit = requireGitCommit(input.sourceCommit, 'backend runtime source commit');
  if (sourceCommit !== GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT) {
    throw new Error(`backend runtime source must be exact reviewed commit ${GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT}`);
  }
  if (!fs.statSync(artifactPolicyFile).isFile() || fs.statSync(artifactPolicyFile).size === 0) {
    throw new Error('reviewed backend artifact policy must be a non-empty regular file');
  }
  const artifactPolicyBytes = fs.readFileSync(artifactPolicyFile);
  const artifactPolicySha256 = crypto.createHash('sha256').update(artifactPolicyBytes).digest('hex');
  if (
    artifactPolicySha256 !==
    requireSha256(input.reviewedArtifactPolicySha256, 'reviewed backend artifact policy SHA-256')
  ) {
    throw new Error('backend artifact policy bytes do not match the separately reviewed SHA-256');
  }
  let artifactPolicy: unknown;
  try {
    artifactPolicy = JSON.parse(artifactPolicyBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('backend artifact policy must be valid JSON');
  }
  validateGalileoBackendArtifactPolicy(artifactPolicy);

  const storkPolicyFile = path.join(repoRoot, 'config/galileo.stork-deployment-policy.json');
  const releasePolicyFile = path.join(repoRoot, 'config/galileo.release-policy.json');
  const storkPolicy = validateStorkDeploymentPolicy(readJson<StorkDeploymentPolicy>(storkPolicyFile));
  const releasePolicy = validateReleasePolicy(readJson<GalileoReleasePolicy>(releasePolicyFile));
  const runtime = storkPolicy.backend.runtimeRelease;
  const alreadyBound =
    runtime.sourceCommit?.toLowerCase() === sourceCommit &&
    runtime.artifactManifestSha256?.toLowerCase() === artifactPolicySha256 &&
    runtime.status === 'reviewed_immutable_backend_release';
  const pending =
    runtime.sourceCommit === null &&
    runtime.artifactManifestSha256 === null &&
    runtime.status === 'pending_final_immutable_backend_release';
  if (!pending && !alreadyBound) {
    throw new Error('refusing to replace a different or partially resolved backend runtime binding');
  }
  if (
    releasePolicy.status !== PENDING_RELEASE_STATUS &&
    !(releasePolicy.status === ACTIVE_RELEASE_STATUS && alreadyBound)
  ) {
    throw new Error(`unexpected Galileo release policy status: ${releasePolicy.status}`);
  }

  if (!alreadyBound) {
    storkPolicy.backend.runtimeRelease = {
      sourceCommit,
      artifactManifestSha256: artifactPolicySha256,
      status: 'reviewed_immutable_backend_release',
    };
    validateStorkDeploymentPolicy(storkPolicy);
    // Write the runtime binding first. If the second write fails, the release
    // remains blocked rather than becoming active without an immutable artifact.
    writeJson(storkPolicyFile, storkPolicy);
  }
  if (releasePolicy.status !== ACTIVE_RELEASE_STATUS) {
    if (releasePolicy.policyVersion !== 3) {
      throw new Error(`expected pending Galileo release policy version 3, got ${releasePolicy.policyVersion}`);
    }
    releasePolicy.policyVersion = 4;
    releasePolicy.status = ACTIVE_RELEASE_STATUS;
    validateReleasePolicy(releasePolicy);
    writeJson(releasePolicyFile, releasePolicy);
  }

  return { sourceCommit, artifactPolicySha256, storkPolicyFile, releasePolicyFile };
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (dirty) throw new Error('tracked checkout must be clean before binding the backend runtime release');
  const result = bindGalileoBackendRuntime({
    repoRoot,
    artifactPolicyFile: required(
      process.env.PERPDEX_BACKEND_ARTIFACT_POLICY_FILE,
      'PERPDEX_BACKEND_ARTIFACT_POLICY_FILE'
    ),
    reviewedArtifactPolicySha256: required(
      process.env.PERPDEX_REVIEWED_BACKEND_ARTIFACT_POLICY_SHA256,
      'PERPDEX_REVIEWED_BACKEND_ARTIFACT_POLICY_SHA256'
    ),
    sourceCommit: required(process.env.PERPDEX_BACKEND_RUNTIME_SOURCE_COMMIT, 'PERPDEX_BACKEND_RUNTIME_SOURCE_COMMIT'),
  });
  console.log(`bound Galileo backend runtime source ${result.sourceCommit}`);
  console.log(`bound approved artifact-policy SHA-256 ${result.artifactPolicySha256}`);
  console.log('Review and commit only the two tracked policy files; no deployment was performed.');
}

if (require.main === module) main();
