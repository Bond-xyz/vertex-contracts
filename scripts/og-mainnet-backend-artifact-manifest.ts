// Reviewed immutable backend runtime release for the 0G mainnet lanes.
//
// Galileo binds an external, separately reviewed artifact policy (see
// bind-galileo-backend-runtime.ts). Mainnet's images are published by
// bond-perpdex protected main publication, whose signed receipt lives in GCS
// and in the run's evidence artifact, never in the source commit it describes.
// The reviewed manifest is therefore tracked here, next to the Stork policies:
// `backend.runtimeRelease.artifactManifestSha256` is the SHA-256 of these exact
// file bytes, and verifyOgMainnetPublicationEvidence() replays the manifest
// against the downloaded publication evidence (receipt + cosign verifications).
//
//   PERPDEX_BACKEND_PUBLICATION_EVIDENCE=/path/to/development-plan-evidence-1 \
//     yarn verify:og-mainnet:backend-manifest
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE,
  PERPDEX_NETWORK,
  PerpdexNetworkName,
  PerpdexNetworkProfile,
} from './deployment-config';
import type { StorkDeploymentPolicy } from './stork-deployment-snapshot';

export const OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE = 'config/og-mainnet.backend-artifact-manifest.json';
export const OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_KIND = 'bond-perpdex-og-mainnet-backend-artifact-manifest';
export const OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_STATUS = 'published_signed_immutable_backend_release';
export const OG_MAINNET_BACKEND_SERVICES = ['market-data', 'mm-bot', 'price-oracle', 'settlement', 'trading'] as const;
export const OG_MAINNET_BACKEND_IMAGE_REGISTRY = 'us-central1-docker.pkg.dev/g-bond/bond-perpdex-services';

// Protected main publication of bond-perpdex f1604545. The images were built by
// Cloud Build 54b23c18 under trigger bond-perpdex-main, dispatched from Actions run
// 42940453544 (receipt executionTag github-42940453544-1-f16045451a96). The signed
// receipt and cosign verifications were retrieved by run 42942405427 into its
// development-plan-evidence-1 artifact; that run's later delivery-lease refusal is
// downstream of, and does not affect, the publication.
export const OG_MAINNET_BACKEND_PUBLICATION = {
  projectId: 'g-bond',
  location: 'us-central1',
  cloudBuildId: '54b23c18-04a1-400a-9dc2-411b756c498d',
  cloudBuildTriggerId: '3122e39d-b0e1-4e26-bc0d-39f37b496ef3',
  buildServiceAccount: 'projects/g-bond/serviceAccounts/bond-perpdex-ci-main@g-bond.iam.gserviceaccount.com',
  buildRunId: '42940453544',
  evidenceRunId: '42942405427',
  evidenceArtifact: 'development-plan-evidence-1',
  signingKey:
    'gcpkms://projects/g-bond/locations/us-central1/keyRings/bond-perpdex-artifact-signing/cryptoKeys/bond-perpdex-artifact-signing-key/versions/1',
} as const;

// Profiles whose runtime release must bind this manifest. Galileo keeps its own
// external artifact-policy binding and is deliberately absent.
const MANIFEST_BOUND_PROFILES: readonly PerpdexNetworkName[] = ['og-mainnet', 'og-mainnet-usdz'];

type JsonRecord = Record<string, unknown>;
export type OgMainnetBackendArtifactManifest = {
  schemaVersion: 1;
  kind: string;
  manifestId: string;
  status: string;
  deployments: PerpdexNetworkName[];
  source: { repository: string; ref: string; commit: string; tree: string };
  target: { os: string; arch: string };
  publication: typeof OG_MAINNET_BACKEND_PUBLICATION & { receiptSha256: string; payloadSha256: string };
  services: Record<
    typeof OG_MAINNET_BACKEND_SERVICES[number],
    { repository: string; digest: string; signatureVerificationSha256: string }
  >;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function exactKeys(value: unknown, expected: readonly string[], label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
  return value;
}

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');

function lowerSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOWER_SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

/**
 * Validate the tracked manifest's shape and its identity against the already
 * reviewed lane evidence: same bond-perpdex source commit/tree, linux/amd64, the
 * exact protected publication, and the same Trading digest the sequencer lanes boot.
 */
export function validateOgMainnetBackendArtifactManifest(value: unknown): OgMainnetBackendArtifactManifest {
  const manifest = exactKeys(
    value,
    ['deployments', 'kind', 'manifestId', 'publication', 'schemaVersion', 'services', 'source', 'status', 'target'],
    'backend artifact manifest'
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_KIND ||
    manifest.status !== OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_STATUS ||
    manifest.manifestId !==
      `bond-perpdex-og-mainnet-backend-runtime-${OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE.commit.slice(0, 8)}`
  ) {
    throw new Error('backend artifact manifest is not the published signed og-mainnet backend release');
  }
  if (JSON.stringify(manifest.deployments) !== JSON.stringify(MANIFEST_BOUND_PROFILES)) {
    throw new Error(`backend artifact manifest must serve exactly ${MANIFEST_BOUND_PROFILES.join(', ')}`);
  }
  const source = exactKeys(
    manifest.source,
    ['commit', 'ref', 'repository', 'tree'],
    'backend artifact manifest source'
  );
  const lanes = OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE;
  if (
    source.repository !== lanes.repository ||
    source.ref !== 'refs/heads/main' ||
    source.commit !== lanes.commit ||
    source.tree !== lanes.tree
  ) {
    throw new Error('backend artifact manifest source does not match the reviewed bond-perpdex lane source');
  }
  const target = exactKeys(manifest.target, ['arch', 'os'], 'backend artifact manifest target');
  if (target.os !== 'linux' || target.arch !== 'amd64') {
    throw new Error('backend artifact manifest target must be linux/amd64');
  }
  const publication = exactKeys(
    manifest.publication,
    [...Object.keys(OG_MAINNET_BACKEND_PUBLICATION), 'payloadSha256', 'receiptSha256'],
    'backend artifact manifest publication'
  );
  for (const [key, wanted] of Object.entries(OG_MAINNET_BACKEND_PUBLICATION)) {
    if (publication[key] !== wanted) {
      throw new Error(`backend artifact manifest publication ${key} is not the protected main publication`);
    }
  }
  lowerSha256(publication.receiptSha256, 'backend artifact manifest receiptSha256');
  lowerSha256(publication.payloadSha256, 'backend artifact manifest payloadSha256');

  const services = exactKeys(manifest.services, OG_MAINNET_BACKEND_SERVICES, 'backend artifact manifest services');
  const digests = new Set<string>();
  for (const service of OG_MAINNET_BACKEND_SERVICES) {
    const entry = exactKeys(
      services[service],
      ['digest', 'repository', 'signatureVerificationSha256'],
      `backend artifact manifest service ${service}`
    );
    if (entry.repository !== `${OG_MAINNET_BACKEND_IMAGE_REGISTRY}/${service}`) {
      throw new Error(`backend artifact manifest ${service} repository is not exact`);
    }
    if (typeof entry.digest !== 'string' || !IMAGE_DIGEST.test(entry.digest)) {
      throw new Error(`backend artifact manifest ${service} digest must be sha256:<64 lowercase hex>`);
    }
    if (digests.has(entry.digest)) throw new Error(`backend artifact manifest ${service} digest is reused`);
    digests.add(entry.digest);
    lowerSha256(entry.signatureVerificationSha256, `backend artifact manifest ${service} signatureVerificationSha256`);
  }
  // Every lane boots the Trading image the manifest publishes, from the same source.
  const trading = services.trading as JsonRecord;
  for (const lane of lanes.lanes) {
    const artifact = lane.tradingArtifact;
    if (
      artifact.repository !== trading.repository ||
      artifact.digest !== trading.digest ||
      artifact.sourceCommit !== source.commit ||
      artifact.sourceTree !== source.tree ||
      artifact.publicationRunId !== publication.evidenceRunId
    ) {
      throw new Error(`backend artifact manifest Trading image does not match sequencer lane ${lane.deployment}`);
    }
  }
  return value as OgMainnetBackendArtifactManifest;
}

export function loadOgMainnetBackendArtifactManifest(repoRoot = path.resolve(__dirname, '..')): {
  manifest: OgMainnetBackendArtifactManifest;
  manifestFile: string;
  manifestSha256: string;
} {
  const manifestFile = path.resolve(repoRoot, OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE);
  if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) {
    throw new Error(`reviewed backend artifact manifest is missing: ${OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE}`);
  }
  const bytes = fs.readFileSync(manifestFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('reviewed backend artifact manifest must be valid JSON');
  }
  return { manifest: validateOgMainnetBackendArtifactManifest(parsed), manifestFile, manifestSha256: sha256(bytes) };
}

/**
 * Release gate: a manifest-bound profile's runtime release must name the
 * manifest's source commit and the SHA-256 of the exact tracked manifest bytes.
 * Galileo (not manifest-bound) is returned unchanged as null.
 */
export function assertBackendRuntimeReleaseBinding(
  policy: StorkDeploymentPolicy,
  repoRoot = path.resolve(__dirname, '..'),
  profile: PerpdexNetworkProfile = PERPDEX_NETWORK
): { manifestFile: string; manifestSha256: string } | null {
  if (!MANIFEST_BOUND_PROFILES.includes(profile.name)) return null;
  const runtime = policy.backend.runtimeRelease;
  if (runtime.status !== 'reviewed_immutable_backend_release') {
    throw new Error(`${profile.name} backend runtime release must be reviewed_immutable_backend_release`);
  }
  const loaded = loadOgMainnetBackendArtifactManifest(repoRoot);
  if (runtime.sourceCommit !== loaded.manifest.source.commit) {
    throw new Error(`${profile.name} backend runtime source commit does not match the reviewed artifact manifest`);
  }
  if (runtime.artifactManifestSha256 !== loaded.manifestSha256) {
    throw new Error(
      `${profile.name} backend runtime artifact manifest SHA-256 does not match the tracked manifest bytes`
    );
  }
  return { manifestFile: loaded.manifestFile, manifestSha256: loaded.manifestSha256 };
}

export type PublicationFinding = { check: string; ok: boolean; detail: string };

function readEvidenceFile(directory: string, relative: string): Buffer | null {
  const file = path.join(directory, relative);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
}

/**
 * Replay the manifest against an unzipped bond-perpdex publication evidence
 * artifact (publication/receipt.json, publication/payload.json and
 * publication/material/<service>/signature.verify.json). Read-only. Every
 * finding must be ok for the manifest to describe that publication.
 */
export function verifyOgMainnetPublicationEvidence(
  manifest: OgMainnetBackendArtifactManifest,
  evidenceDirectory: string
): PublicationFinding[] {
  const findings: PublicationFinding[] = [];
  const add = (check: string, ok: boolean, detail: string) => findings.push({ check, ok, detail });
  const pub = manifest.publication;
  const receiptBytes = readEvidenceFile(evidenceDirectory, 'publication/receipt.json');
  if (receiptBytes === null) {
    add('receipt present', false, 'publication/receipt.json missing');
    return findings;
  }
  add('receipt bytes', sha256(receiptBytes) === pub.receiptSha256, `sha256 ${sha256(receiptBytes)}`);
  const payloadBytes = readEvidenceFile(evidenceDirectory, 'publication/payload.json');
  add(
    'payload bytes',
    payloadBytes !== null && sha256(payloadBytes) === pub.payloadSha256,
    payloadBytes === null ? 'publication/payload.json missing' : `sha256 ${sha256(payloadBytes)}`
  );
  let receipt: JsonRecord;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    add('receipt JSON', false, 'publication/receipt.json is not JSON');
    return findings;
  }
  const source = isRecord(receipt.source) ? receipt.source : {};
  add(
    'receipt source',
    source.repository === manifest.source.repository &&
      source.ref === manifest.source.ref &&
      source.sha === manifest.source.commit &&
      source.tree === manifest.source.tree,
    `${String(source.repository)}@${String(source.sha)} tree ${String(source.tree)}`
  );
  const build = isRecord(receipt.build) ? receipt.build : {};
  add(
    'receipt build',
    build.buildId === pub.cloudBuildId &&
      build.projectId === pub.projectId &&
      build.location === pub.location &&
      build.triggerId === pub.cloudBuildTriggerId &&
      build.serviceAccount === pub.buildServiceAccount &&
      build.executionTag === `github-${pub.buildRunId}-1-${manifest.source.commit.slice(0, 12)}`,
    `build ${String(build.buildId)} tag ${String(build.executionTag)}`
  );
  const publication = isRecord(receipt.publication) ? receipt.publication : {};
  const payloadObject = isRecord(publication.object) ? publication.object : {};
  add(
    'receipt publication finalized',
    publication.state === 'finalized' &&
      payloadObject.sha256 === `sha256:${pub.payloadSha256}` &&
      Array.isArray(receipt.pendingEvidence) &&
      receipt.pendingEvidence.length === 0,
    `state ${String(publication.state)}`
  );
  const services = isRecord(receipt.services) ? receipt.services : {};
  add(
    'receipt service set',
    JSON.stringify(Object.keys(services).sort()) === JSON.stringify([...OG_MAINNET_BACKEND_SERVICES]),
    Object.keys(services).sort().join(', ')
  );
  for (const service of OG_MAINNET_BACKEND_SERVICES) {
    const wanted = manifest.services[service];
    const entry = isRecord(services[service]) ? (services[service] as JsonRecord) : {};
    const signature = isRecord(entry.imageSignature) ? entry.imageSignature : {};
    const verification = isRecord(signature.verification) ? signature.verification : {};
    add(
      `${service} receipt digest`,
      entry.digest === wanted.digest &&
        entry.evidenceBuildId === pub.cloudBuildId &&
        entry.kmsIdentity === pub.signingKey &&
        verification.sha256 === `sha256:${wanted.signatureVerificationSha256}`,
      `${String(entry.digest)}`
    );
    const verifyBytes = readEvidenceFile(evidenceDirectory, `publication/material/${service}/signature.verify.json`);
    if (verifyBytes === null) {
      add(`${service} signature verification`, false, 'signature.verify.json missing');
      continue;
    }
    let verify: JsonRecord = {};
    try {
      verify = JSON.parse(verifyBytes.toString('utf8'));
    } catch {
      // Falls through to the failed comparison below.
    }
    const image = isRecord(verify.image) ? verify.image : {};
    const claims = Array.isArray(verify.claims) ? verify.claims : [];
    const claimsOk =
      claims.length > 0 &&
      claims.every((claim) => {
        if (!isRecord(claim) || !isRecord(claim.critical) || !isRecord(claim.optional)) return false;
        const critical = claim.critical;
        const identity = isRecord(critical.identity) ? critical.identity : {};
        const claimImage = isRecord(critical.image) ? critical.image : {};
        return (
          identity['docker-reference'] === wanted.repository &&
          claimImage['docker-manifest-digest'] === wanted.digest &&
          claim.optional['bond-perpdex.source-commit'] === manifest.source.commit &&
          claim.optional['bond-perpdex.source-tree'] === manifest.source.tree
        );
      });
    add(
      `${service} signature verification`,
      sha256(verifyBytes) === wanted.signatureVerificationSha256 &&
        image.digest === wanted.digest &&
        image.repository === wanted.repository &&
        verify.kmsIdentity === pub.signingKey &&
        claimsOk,
      `sha256 ${sha256(verifyBytes)}`
    );
  }
  return findings;
}

function main(): void {
  const evidence = process.env.PERPDEX_BACKEND_PUBLICATION_EVIDENCE;
  if (!evidence?.trim()) throw new Error('PERPDEX_BACKEND_PUBLICATION_EVIDENCE is required');
  const { manifest, manifestSha256 } = loadOgMainnetBackendArtifactManifest();
  const findings = verifyOgMainnetPublicationEvidence(manifest, path.resolve(evidence.trim()));
  for (const finding of findings) console.log(`${finding.ok ? 'ok  ' : 'FAIL'} ${finding.check}: ${finding.detail}`);
  console.log(`manifest ${OG_MAINNET_BACKEND_ARTIFACT_MANIFEST_FILE} sha256 ${manifestSha256}`);
  if (findings.some((finding) => !finding.ok)) process.exit(1);
}

if (require.main === module) main();
