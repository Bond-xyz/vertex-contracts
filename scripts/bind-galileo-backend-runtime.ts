import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GalileoReleasePolicy, validateReleasePolicy } from './release-attestation';
import { validateStorkDeploymentPolicy, StorkDeploymentPolicy } from './stork-deployment-snapshot';

export const GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT = '4d479bd167d4cc98dce373af214a5d109b9cad33';
export const PENDING_RELEASE_STATUS = 'blocked_pending_final_backend_and_release_evidence';
export const ACTIVE_RELEASE_STATUS = 'approved_for_galileo_testnet_release';

type BindInput = {
  repoRoot: string;
  artifactManifestFile: string;
  reviewedArtifactManifestSha256: string;
  sourceCommit: string;
};

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const requireSha256 = (value: string, label: string): string => {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) throw new Error(`${label} must be a SHA-256`);
  return normalized.toLowerCase();
};

const requireGitCommit = (value: string, label: string): string => {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a 40-character Git commit`);
  return value.toLowerCase();
};

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.next`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  fs.renameSync(temporary, file);
}

export function bindGalileoBackendRuntime(input: BindInput): {
  sourceCommit: string;
  artifactManifestSha256: string;
  storkPolicyFile: string;
  releasePolicyFile: string;
} {
  const repoRoot = path.resolve(input.repoRoot);
  const artifactManifestFile = path.resolve(input.artifactManifestFile);
  const sourceCommit = requireGitCommit(input.sourceCommit, 'backend runtime source commit');
  if (sourceCommit !== GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT) {
    throw new Error(`backend runtime source must be exact reviewed commit ${GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT}`);
  }
  if (!fs.statSync(artifactManifestFile).isFile() || fs.statSync(artifactManifestFile).size === 0) {
    throw new Error('immutable backend artifact manifest must be a non-empty regular file');
  }
  const artifactManifestSha256 = sha256File(artifactManifestFile);
  if (
    artifactManifestSha256 !==
    requireSha256(input.reviewedArtifactManifestSha256, 'reviewed backend artifact manifest SHA-256')
  ) {
    throw new Error('backend artifact manifest bytes do not match the separately reviewed SHA-256');
  }

  const storkPolicyFile = path.join(repoRoot, 'config/galileo.stork-deployment-policy.json');
  const releasePolicyFile = path.join(repoRoot, 'config/galileo.release-policy.json');
  const storkPolicy = validateStorkDeploymentPolicy(readJson<StorkDeploymentPolicy>(storkPolicyFile));
  const releasePolicy = validateReleasePolicy(readJson<GalileoReleasePolicy>(releasePolicyFile));
  const runtime = storkPolicy.backend.runtimeRelease;
  const alreadyBound =
    runtime.sourceCommit?.toLowerCase() === sourceCommit &&
    runtime.artifactManifestSha256?.toLowerCase() === artifactManifestSha256 &&
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
      artifactManifestSha256,
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

  return { sourceCommit, artifactManifestSha256, storkPolicyFile, releasePolicyFile };
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
    artifactManifestFile: required(
      process.env.PERPDEX_BACKEND_ARTIFACT_MANIFEST_FILE,
      'PERPDEX_BACKEND_ARTIFACT_MANIFEST_FILE'
    ),
    reviewedArtifactManifestSha256: required(
      process.env.PERPDEX_REVIEWED_BACKEND_ARTIFACT_MANIFEST_SHA256,
      'PERPDEX_REVIEWED_BACKEND_ARTIFACT_MANIFEST_SHA256'
    ),
    sourceCommit: required(process.env.PERPDEX_BACKEND_RUNTIME_SOURCE_COMMIT, 'PERPDEX_BACKEND_RUNTIME_SOURCE_COMMIT'),
  });
  console.log(`bound Galileo backend runtime source ${result.sourceCommit}`);
  console.log(`bound immutable artifact manifest SHA-256 ${result.artifactManifestSha256}`);
  console.log('Review and commit only the two tracked policy files; no deployment was performed.');
}

if (require.main === module) main();
