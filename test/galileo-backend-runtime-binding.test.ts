import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import {
  ACTIVE_RELEASE_STATUS,
  bindGalileoBackendRuntime,
  GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
} from '../scripts/bind-galileo-backend-runtime';

const sourceRoot = path.resolve(__dirname, '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galileo-runtime-binding-'));
  fs.mkdirSync(path.join(root, 'config'));
  for (const name of ['galileo.stork-deployment-policy.json', 'galileo.release-policy.json']) {
    fs.copyFileSync(path.join(sourceRoot, 'config', name), path.join(root, 'config', name));
  }
  const manifest = path.join(root, 'retained-artifacts.json');
  fs.writeFileSync(manifest, '{"schemaVersion":1,"artifacts":[]}\n');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
  return { root, manifest, sha256 };
}

describe('Galileo backend runtime binding', () => {
  it('binds the exact reviewed runtime source and separately reviewed manifest bytes together', () => {
    const { root, manifest, sha256 } = fixture();
    const result = bindGalileoBackendRuntime({
      repoRoot: root,
      artifactManifestFile: manifest,
      reviewedArtifactManifestSha256: sha256,
      sourceCommit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
    });
    expect(result.artifactManifestSha256).to.equal(sha256);
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

  it('rejects any other backend source commit without changing either policy', () => {
    const { root, manifest, sha256 } = fixture();
    const storkFile = path.join(root, 'config/galileo.stork-deployment-policy.json');
    const releaseFile = path.join(root, 'config/galileo.release-policy.json');
    const before = [fs.readFileSync(storkFile), fs.readFileSync(releaseFile)];
    expect(() =>
      bindGalileoBackendRuntime({
        repoRoot: root,
        artifactManifestFile: manifest,
        reviewedArtifactManifestSha256: sha256,
        sourceCommit: 'ab'.repeat(20),
      })
    ).to.throw('backend runtime source must be exact reviewed commit');
    expect(fs.readFileSync(storkFile).equals(before[0])).to.equal(true);
    expect(fs.readFileSync(releaseFile).equals(before[1])).to.equal(true);
  });

  it('rejects artifact bytes that do not match the reviewed SHA-256 without changing policy', () => {
    const { root, manifest } = fixture();
    const storkFile = path.join(root, 'config/galileo.stork-deployment-policy.json');
    const before = fs.readFileSync(storkFile);
    expect(() =>
      bindGalileoBackendRuntime({
        repoRoot: root,
        artifactManifestFile: manifest,
        reviewedArtifactManifestSha256: 'cd'.repeat(32),
        sourceCommit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
      })
    ).to.throw('artifact manifest bytes do not match');
    expect(fs.readFileSync(storkFile).equals(before)).to.equal(true);
  });

  it('is idempotent for the same source and manifest and refuses replacement', () => {
    const { root, manifest, sha256 } = fixture();
    const input = {
      repoRoot: root,
      artifactManifestFile: manifest,
      reviewedArtifactManifestSha256: sha256,
      sourceCommit: GALILEO_BACKEND_RUNTIME_SOURCE_COMMIT,
    };
    bindGalileoBackendRuntime(input);
    bindGalileoBackendRuntime(input);
    const other = path.join(root, 'other.json');
    fs.writeFileSync(other, '{"different":true}\n');
    const otherSha = crypto.createHash('sha256').update(fs.readFileSync(other)).digest('hex');
    expect(() =>
      bindGalileoBackendRuntime({
        ...input,
        artifactManifestFile: other,
        reviewedArtifactManifestSha256: otherSha,
      })
    ).to.throw('refusing to replace a different or partially resolved backend runtime binding');
  });
});
