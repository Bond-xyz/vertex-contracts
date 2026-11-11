import { expect } from 'chai';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveNetworkProfile } from '../scripts/deployment-config';
import {
  assertBackendRuntimeReleaseBinding,
  loadOgMainnetBackendArtifactManifest,
  OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE,
  OG_MAINNET_BACKEND_SERVICES,
  OgMainnetBackendArtifactManifest,
  validateOgMainnetBackendArtifactManifest,
  verifyOgMainnetPublicationEvidence,
} from '../scripts/og-mainnet-backend-artifact-manifest';
import { StorkDeploymentPolicy } from '../scripts/stork-deployment-snapshot';

const root = path.resolve(__dirname, '..');
const SOURCE_COMMIT = 'f16045451a96ad3ac77299903fdde200b2ac0044';
const SOURCE_TREE = 'bc5fdc649e3e31c3f280d3b0b53d1f318dc346d9';
const PUBLISHED_DIGESTS = {
  'market-data': 'sha256:cee9696489ba9c8af8a9794e0047546b184bb9132eb8fca81383179b31630f8f',
  'mm-bot': 'sha256:8f8b243ecebdde44e84407451054aad3a7966dc5e8cd4aaacf43e6e68ed1d803',
  'price-oracle': 'sha256:15ae4c5d422c22e01ac62c1e35e068d1020abdcfa45a601d4d4d5eaf391222b7',
  settlement: 'sha256:f1149f646b3cb4ff5a562e218dde70385891dde413eb495126ed10fb08f67efe',
  trading: 'sha256:914762fd8d5868dbea330716bdc2a398812c5a18e8a820beddd0b00508c09bd4',
};
const mainnet = resolveNetworkProfile('og-mainnet');
const usdz = resolveNetworkProfile('og-mainnet-usdz');
const galileo = resolveNetworkProfile('galileo');

const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as T;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const trackedManifest = () => readJson<OgMainnetBackendArtifactManifest>(OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE);
const storkPolicy = (name: string) => readJson<StorkDeploymentPolicy>(`config/${name}.stork-deployment-policy.json`);

// A repo root holding only the manifest, so tests can mutate its bytes.
function manifestRoot(bytes: string | null): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'og-mainnet-manifest-'));
  fs.mkdirSync(path.join(directory, 'config'));
  if (bytes !== null) fs.writeFileSync(path.join(directory, OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE), bytes);
  return directory;
}

// Synthetic publication evidence shaped like bond-perpdex's development-plan-evidence
// artifact (the real one names a masked GCS bucket, so it is not committed). Returns
// the evidence dir and a manifest copy whose receipt/signature hashes bind it.
function publicationEvidence(edit: (receipt: any, verifies: Record<string, any>) => void = () => undefined) {
  const manifest = clone(trackedManifest());
  const pub = manifest.publication;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'og-mainnet-publication-'));
  fs.mkdirSync(path.join(directory, 'publication/material'), { recursive: true });
  const payload = '{"payload":"fixture"}\n';
  fs.writeFileSync(path.join(directory, 'publication/payload.json'), payload);
  manifest.publication.payloadSha256 = sha256(payload);
  const verifies: Record<string, any> = {};
  for (const service of OG_MAINNET_BACKEND_SERVICES) {
    const { repository, digest } = manifest.services[service];
    verifies[service] = {
      claims: [
        {
          critical: {
            identity: { 'docker-reference': repository },
            image: { 'docker-manifest-digest': digest },
            type: 'cosign container image signature',
          },
          optional: { 'bond-perpdex.source-commit': SOURCE_COMMIT, 'bond-perpdex.source-tree': SOURCE_TREE },
        },
      ],
      image: { digest, repository },
      kind: 'bond-perpdex-cosign-signature-verification',
      kmsIdentity: pub.signingKey,
      schemaVersion: 1,
    };
  }
  const receipt: any = {
    build: {
      buildId: pub.cloudBuildId,
      executionTag: `github-${pub.buildRunId}-1-${SOURCE_COMMIT.slice(0, 12)}`,
      location: pub.location,
      projectId: pub.projectId,
      serviceAccount: pub.buildServiceAccount,
      triggerId: pub.cloudBuildTriggerId,
    },
    pendingEvidence: [],
    publication: { object: { sha256: `sha256:${sha256(payload)}` }, state: 'finalized' },
    services: {},
    source: { repository: 'Bond-xyz/bond-perpdex', ref: 'refs/heads/main', sha: SOURCE_COMMIT, tree: SOURCE_TREE },
  };
  edit(receipt, verifies);
  for (const service of OG_MAINNET_BACKEND_SERVICES) {
    const bytes = `${JSON.stringify(verifies[service], null, 2)}\n`;
    fs.mkdirSync(path.join(directory, 'publication/material', service));
    fs.writeFileSync(path.join(directory, 'publication/material', service, 'signature.verify.json'), bytes);
    manifest.services[service].signatureVerificationSha256 = sha256(bytes);
    receipt.services[service] = receipt.services[service] ?? {
      digest: manifest.services[service].digest,
      evidenceBuildId: pub.cloudBuildId,
      imageSignature: { verification: { sha256: `sha256:${sha256(bytes)}` } },
      kmsIdentity: pub.signingKey,
    };
  }
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'publication/receipt.json'), receiptBytes);
  manifest.publication.receiptSha256 = sha256(receiptBytes);
  return { directory, manifest };
}

const failed = (findings: { check: string; ok: boolean }[]) => findings.filter((f) => !f.ok).map((f) => f.check);

describe('og-mainnet backend artifact manifest', () => {
  it('tracks the exact published f1604545 linux/amd64 release for both lanes', () => {
    const { manifest, manifestSha256 } = loadOgMainnetBackendArtifactManifest(root);
    expect(manifest.source).to.deep.equal({
      repository: 'Bond-xyz/bond-perpdex',
      ref: 'refs/heads/main',
      commit: SOURCE_COMMIT,
      tree: SOURCE_TREE,
    });
    expect(manifest.target).to.deep.equal({ os: 'linux', arch: 'amd64' });
    expect(manifest.deployments).to.deep.equal(['og-mainnet', 'og-mainnet-usdz']);
    expect(manifest.publication.cloudBuildId).to.equal('54b23c18-04a1-400a-9dc2-411b756c498d');
    expect(manifest.publication.buildRunId).to.equal('42940453544');
    expect(manifest.publication.evidenceRunId).to.equal('42942405427');
    expect(manifest.publication.receiptSha256).to.equal(
      '37f4cf6de621fe92d05ab7a05632dc119ca43602b471cf46a0b3ba0e78d75acf'
    );
    for (const service of OG_MAINNET_BACKEND_SERVICES) {
      expect(manifest.services[service].digest).to.equal(PUBLISHED_DIGESTS[service]);
    }
    expect(manifestSha256).to.equal(
      sha256(fs.readFileSync(path.join(root, OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE)))
    );
  });

  it('binds both mainnet profiles to the manifest bytes and f1604545', () => {
    const manifestSha256 = sha256(fs.readFileSync(path.join(root, OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE)));
    for (const profile of [mainnet, usdz]) {
      const policy = storkPolicy(profile.name);
      expect(policy.backend.runtimeRelease).to.deep.equal({
        sourceCommit: SOURCE_COMMIT,
        artifactManifestSha256: manifestSha256,
        status: 'reviewed_immutable_backend_release',
      });
      expect(assertBackendRuntimeReleaseBinding(policy, root, profile)).to.deep.equal({
        manifestFile: path.join(root, OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE),
        manifestSha256,
      });
    }
  });

  it('keeps each product review bound to its exact Stork policy bytes', () => {
    for (const profile of [mainnet, usdz]) {
      const review = readJson<any>(profile.files.productReview);
      expect(review.initialPricePolicy.policyFile).to.equal(profile.files.storkPolicy);
      expect(review.initialPricePolicy.policySha256).to.equal(
        sha256(fs.readFileSync(path.join(root, profile.files.storkPolicy)))
      );
    }
  });

  it('leaves both mainnet release policies pending review', () => {
    for (const profile of [mainnet, usdz]) {
      const release = readJson<any>(profile.files.releasePolicy);
      expect(release.status).to.equal('pending_og_mainnet_review');
      expect(release.policyVersion).to.equal(1);
    }
  });

  it('leaves Galileo on its external artifact-policy binding', () => {
    const policy = storkPolicy('galileo');
    expect(policy.backend.runtimeRelease).to.deep.equal({
      sourceCommit: '4d479bd167d4cc98dce373af214a5d109b9cad33',
      artifactManifestSha256: '0dd777b345e85155aed5e1c735f21c5d1a445d0f78ccf98dcc427b3a5d908ec2',
      status: 'reviewed_immutable_backend_release',
    });
    expect(assertBackendRuntimeReleaseBinding(policy, manifestRoot(null), galileo)).to.equal(null);
  });

  describe('fails closed', () => {
    const bound = (edit: (runtime: StorkDeploymentPolicy['backend']['runtimeRelease']) => void) => {
      const policy = clone(storkPolicy('og-mainnet'));
      edit(policy.backend.runtimeRelease);
      return policy;
    };

    it('on a missing manifest', () => {
      for (const profile of [mainnet, usdz]) {
        expect(() =>
          assertBackendRuntimeReleaseBinding(storkPolicy(profile.name), manifestRoot(null), profile)
        ).to.throw('reviewed backend artifact manifest is missing');
      }
    });

    it('on manifest bytes that differ from the bound SHA-256 (even whitespace)', () => {
      const tracked = fs.readFileSync(path.join(root, OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE), 'utf8');
      const reformatted = manifestRoot(`${JSON.stringify(JSON.parse(tracked))}\n`);
      expect(() => assertBackendRuntimeReleaseBinding(storkPolicy('og-mainnet'), reformatted, mainnet)).to.throw(
        'artifact manifest SHA-256 does not match the tracked manifest bytes'
      );
    });

    it('on a mismatched or partial runtime binding', () => {
      const cases: [StorkDeploymentPolicy, string][] = [
        [bound((r) => (r.artifactManifestSha256 = '0'.repeat(64))), 'manifest SHA-256 does not match'],
        [bound((r) => (r.artifactManifestSha256 = null)), 'manifest SHA-256 does not match'],
        [bound((r) => (r.sourceCommit = '90c79ef4' + SOURCE_COMMIT.slice(8))), 'source commit does not match'],
        [bound((r) => (r.sourceCommit = null)), 'source commit does not match'],
        [
          bound((r) => (r.status = 'pending_final_immutable_backend_release')),
          'must be reviewed_immutable_backend_release',
        ],
      ];
      for (const [policy, message] of cases) {
        expect(() => assertBackendRuntimeReleaseBinding(policy, root, mainnet)).to.throw(message);
      }
    });

    it('on a manifest that drifts from the reviewed source, target, publication or lane image', () => {
      const edits: [(m: any) => void, string][] = [
        [(m) => (m.source.commit = '90c79ef4' + SOURCE_COMMIT.slice(8)), 'source does not match'],
        [(m) => (m.source.tree = '0'.repeat(40)), 'source does not match'],
        [(m) => (m.source.repository = 'Bond-xyz/perpdex-rust-backend'), 'source does not match'],
        [(m) => (m.target.arch = 'arm64'), 'linux/amd64'],
        [(m) => (m.status = 'approved_for_og_mainnet_release'), 'published signed og-mainnet backend release'],
        [(m) => (m.deployments = ['og-mainnet']), 'must serve exactly'],
        [(m) => (m.publication.cloudBuildId = '00000000-0000-0000-0000-000000000000'), 'publication cloudBuildId'],
        [(m) => (m.publication.buildRunId = '42942405427'), 'publication buildRunId'],
        [(m) => (m.publication.receiptSha256 = 'ABC'), 'receiptSha256 must be a lowercase SHA-256'],
        [(m) => delete m.services['mm-bot'], 'services must contain exactly'],
        [(m) => (m.services.settlement.digest = m.services.trading.digest), 'digest is reused'],
        [(m) => (m.services.trading.digest = `sha256:${'1'.repeat(64)}`), 'does not match sequencer lane og-mainnet'],
        [(m) => (m.services.trading.repository += '-v2'), 'repository is not exact'],
        [(m) => (m.extra = true), 'must contain exactly'],
      ];
      for (const [edit, message] of edits) {
        const manifest = clone(trackedManifest());
        edit(manifest);
        expect(() => validateOgMainnetBackendArtifactManifest(manifest)).to.throw(message);
      }
    });
  });

  describe('publication evidence replay', () => {
    it('accepts evidence whose receipt and cosign verifications match the manifest', () => {
      const { directory, manifest } = publicationEvidence();
      expect(failed(verifyOgMainnetPublicationEvidence(manifest, directory))).to.deep.equal([]);
    });

    it('rejects evidence for a different receipt, source, build, digest or signature', () => {
      const cases: [(receipt: any, verifies: Record<string, any>) => void, string][] = [
        [(r) => (r.source.sha = '90c79ef4' + SOURCE_COMMIT.slice(8)), 'receipt source'],
        [(r) => (r.build.executionTag = 'github-42942405427-1-f16045451a96'), 'receipt build'],
        [(r) => (r.build.buildId = 'other'), 'receipt build'],
        [(r) => (r.publication.state = 'pending'), 'receipt publication finalized'],
        [(r) => r.pendingEvidence.push('sbom'), 'receipt publication finalized'],
        [
          (r) =>
            (r.services.trading = {
              digest: `sha256:${'2'.repeat(64)}`,
              evidenceBuildId: '54b23c18-04a1-400a-9dc2-411b756c498d',
            }),
          'trading receipt digest',
        ],
        [
          (_, v) => (v['mm-bot'].claims[0].optional['bond-perpdex.source-commit'] = '0'.repeat(40)),
          'mm-bot signature verification',
        ],
        [(_, v) => (v.settlement.kmsIdentity = 'gcpkms://other'), 'settlement signature verification'],
      ];
      for (const [edit, check] of cases) {
        const { directory, manifest } = publicationEvidence(edit);
        expect(failed(verifyOgMainnetPublicationEvidence(manifest, directory))).to.include(check);
      }
    });

    it('rejects tampered receipt bytes and missing material', () => {
      const { directory, manifest } = publicationEvidence();
      fs.appendFileSync(path.join(directory, 'publication/receipt.json'), ' ');
      fs.rmSync(path.join(directory, 'publication/material/trading/signature.verify.json'));
      expect(failed(verifyOgMainnetPublicationEvidence(manifest, directory))).to.include.members([
        'receipt bytes',
        'trading signature verification',
      ]);
      expect(failed(verifyOgMainnetPublicationEvidence(manifest, manifestRoot(null)))).to.deep.equal([
        'receipt present',
      ]);
    });

    it('the tracked manifest does not accept synthetic evidence', () => {
      const { directory } = publicationEvidence();
      expect(failed(verifyOgMainnetPublicationEvidence(trackedManifest(), directory))).to.include('receipt bytes');
    });
  });
});
