import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import {
  ACTIVE_RELEASE_STATUS,
  bindGalileoBackendRuntime,
  GALILEO_BACKEND_BUILDER_IMAGE_DIGEST,
  GALILEO_BACKEND_RUNTIME_SOURCE_ARCHIVE_SHA256,
  GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
  GALILEO_BACKEND_RUNTIME_SOURCE_TREE,
} from '../scripts/bind-galileo-backend-runtime';

const sourceRoot = path.resolve(__dirname, '..');
const services = ['market-data', 'mm-bot', 'price-oracle', 'settlement', 'trading'];

function approvedPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'bond-perpdex-testnet-reviewed-artifact-policy',
    status: 'approved',
    backendSource: {
      repository: 'https://github.com/Bond-xyz/perpdex-rust-backend',
      commit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
      tree: GALILEO_BACKEND_RUNTIME_SOURCE_TREE,
      archiveSha256: GALILEO_BACKEND_RUNTIME_SOURCE_ARCHIVE_SHA256,
    },
    target: { os: 'linux', arch: 'amd64' },
    services: Object.fromEntries(
      services.map((service, index) => [
        service,
        {
          artifactSha256: (index + 1).toString(16).repeat(64),
          builderImageDigest: GALILEO_BACKEND_BUILDER_IMAGE_DIGEST,
          recipeSha256: (index + 10).toString(16).slice(-1).repeat(64),
          sourcePath: `services/${service}`,
        },
      ])
    ),
    retentionBuild: {
      authorization: 'post_money_path_source_hashes_reviewed_for_non_committed_retention',
      authorized: true,
      backendSourceCommit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
    },
    approval: {
      decision: 'approve_exact_linux_amd64_artifact_hashes',
      reviewer: 'spyda600',
      reviewedAt: '2026-07-12T23:30:00Z',
    },
  };
}

function writePolicy(root: string, policy: unknown, name = 'testnet-publisher-artifact-policy.json') {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { file, sha256 };
}

function fixture(policy: unknown = approvedPolicy(), name?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galileo-runtime-binding-'));
  fs.mkdirSync(path.join(root, 'config'));
  for (const configName of ['galileo.stork-deployment-policy.json', 'galileo.release-policy.json']) {
    fs.copyFileSync(path.join(sourceRoot, 'config', configName), path.join(root, 'config', configName));
  }
  const artifactPolicy = writePolicy(root, policy, name);
  return { root, ...artifactPolicy };
}

function input(root: string, file: string, sha256: string) {
  return {
    repoRoot: root,
    artifactPolicyFile: file,
    reviewedArtifactPolicySha256: sha256,
    sourceCommit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
  };
}

describe('Galileo backend runtime binding', () => {
  it('binds the exact approved policy file bytes and reviewed runtime source together', () => {
    const { root, file, sha256 } = fixture();
    const result = bindGalileoBackendRuntime(input(root, file, sha256));
    expect(result.artifactPolicySha256).to.equal(sha256);
    const stork = JSON.parse(fs.readFileSync(path.join(root, 'config/galileo.stork-deployment-policy.json'), 'utf8'));
    expect(stork.backend.runtimeRelease).to.deep.equal({
      sourceCommit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
      artifactManifestSha256: sha256,
      status: 'reviewed_immutable_backend_release',
    });
    const release = JSON.parse(fs.readFileSync(path.join(root, 'config/galileo.release-policy.json'), 'utf8'));
    expect(release.policyVersion).to.equal(4);
    expect(release.status).to.equal(ACTIVE_RELEASE_STATUS);
  });

  it('rejects Phase-B evidence.json even when its byte hash is supplied', () => {
    const evidence = {
      schemaVersion: 1,
      kind: 'bond-perpdex-linux-amd64-retention-evidence',
      backendSource: { commit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT },
      artifacts: [],
    };
    const { root, file, sha256 } = fixture(evidence, 'evidence.json');
    expect(() => bindGalileoBackendRuntime(input(root, file, sha256))).to.throw(
      'backend artifact policy must contain exactly'
    );
  });

  it('rejects a pending or otherwise non-approved artifact policy', () => {
    const policy = approvedPolicy();
    policy.status = 'blocked_pending_reviewed_linux_amd64_build';
    const { root, file, sha256 } = fixture(policy);
    expect(() => bindGalileoBackendRuntime(input(root, file, sha256))).to.throw(
      'must be the approved Bond PerpDex testnet artifact policy'
    );
  });

  it('rejects an artifact policy for any other backend source', () => {
    const policy = approvedPolicy();
    (policy.backendSource as Record<string, unknown>).commit = 'ab'.repeat(20);
    const { root, file, sha256 } = fixture(policy);
    expect(() => bindGalileoBackendRuntime(input(root, file, sha256))).to.throw(
      'source does not match the exact reviewed backend source'
    );
  });

  it('rejects an artifact policy missing one of the exact five services', () => {
    const policy = approvedPolicy();
    delete (policy.services as Record<string, unknown>).settlement;
    const { root, file, sha256 } = fixture(policy);
    expect(() => bindGalileoBackendRuntime(input(root, file, sha256))).to.throw(
      'backend artifact policy services must contain exactly'
    );
  });

  it('rejects malformed service hashes and a builder other than the pinned digest', () => {
    const malformedHash = approvedPolicy();
    ((malformedHash.services as Record<string, unknown>).trading as Record<string, unknown>).artifactSha256 =
      'not-a-hash';
    let current = fixture(malformedHash);
    expect(() => bindGalileoBackendRuntime(input(current.root, current.file, current.sha256))).to.throw(
      'trading artifactSha256 must be a lowercase SHA-256'
    );

    const wrongBuilder = approvedPolicy();
    (
      (wrongBuilder.services as Record<string, unknown>).trading as Record<string, unknown>
    ).builderImageDigest = `sha256:${'f'.repeat(64)}`;
    current = fixture(wrongBuilder);
    expect(() => bindGalileoBackendRuntime(input(current.root, current.file, current.sha256))).to.throw(
      'trading builderImageDigest is not the pinned builder'
    );
  });

  it('rejects any other runtime source argument without changing either release policy', () => {
    const { root, file, sha256 } = fixture();
    const storkFile = path.join(root, 'config/galileo.stork-deployment-policy.json');
    const releaseFile = path.join(root, 'config/galileo.release-policy.json');
    const before = [fs.readFileSync(storkFile), fs.readFileSync(releaseFile)];
    expect(() =>
      bindGalileoBackendRuntime({
        ...input(root, file, sha256),
        sourceCommit: 'ab'.repeat(20),
      })
    ).to.throw('backend runtime source must be exact reviewed commit');
    expect(fs.readFileSync(storkFile).equals(before[0])).to.equal(true);
    expect(fs.readFileSync(releaseFile).equals(before[1])).to.equal(true);
  });

  it('rejects policy bytes that do not match the separately reviewed hash without changing policy', () => {
    const { root, file } = fixture();
    const storkFile = path.join(root, 'config/galileo.stork-deployment-policy.json');
    const before = fs.readFileSync(storkFile);
    expect(() => bindGalileoBackendRuntime(input(root, file, 'cd'.repeat(32)))).to.throw(
      'artifact policy bytes do not match'
    );
    expect(fs.readFileSync(storkFile).equals(before)).to.equal(true);
  });

  it('is idempotent for the same policy bytes and refuses a different approved policy', () => {
    const { root, file, sha256 } = fixture();
    const exactInput = input(root, file, sha256);
    bindGalileoBackendRuntime(exactInput);
    bindGalileoBackendRuntime(exactInput);

    const otherPolicy = approvedPolicy();
    (otherPolicy.approval as Record<string, unknown>).reviewedAt = '2026-07-12T23:31:00Z';
    const other = writePolicy(root, otherPolicy, 'other-approved-policy.json');
    expect(() => bindGalileoBackendRuntime(input(root, other.file, other.sha256))).to.throw(
      'refusing to replace a different or partially resolved backend runtime binding'
    );
  });
});
