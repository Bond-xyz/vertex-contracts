import { expect } from 'chai';
import { execFileSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '..');

// The selected profile is resolved once per process, so mainnet gates are
// exercised in a child process with PERPDEX_NETWORK set.
function underProfile(profile: string, body: string): string {
  return execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', body], {
    cwd: root,
    env: { ...process.env, PERPDEX_NETWORK: profile, TS_NODE_TRANSPILE_ONLY: '1' },
    encoding: 'utf8',
  }).trim();
}

const probe = `
const fs = require('fs');
const { validateReleasePolicy, createGalileoDeploymentIntent } = require('./scripts/release-attestation');
const { PERPDEX_NETWORK } = require('./scripts/deployment-config');
const policy = JSON.parse(fs.readFileSync(PERPDEX_NETWORK.files.releasePolicy, 'utf8'));
const results = {};
const attempt = (label, fn) => { try { fn(); results[label] = 'ok'; } catch (error) { results[label] = error.message; } };
attempt('trackedPolicy', () => validateReleasePolicy(policy));
attempt('foreignReviewer', () => validateReleasePolicy({ ...policy, reviewers: [{ name: 'Mallory', address: '0x00000000000000000000000000000000000000bb' }] }));
const intent = (deployer, sequencer) => createGalileoDeploymentIntent({
  deploymentNonce: '1', expiresAt: 2000000000, deployer, sequencer, firstTransactionNonce: 0,
  backendBetaCommit: '1d174da2f130cf6f4f03b29029a002d92acc76f8', storkPolicySha256: '0'.repeat(64), collateralProvenanceSha256: '0'.repeat(64),
});
const { validateDeploymentIntent } = require('./scripts/release-attestation');
attempt('pinnedIntent', () => validateDeploymentIntent(intent('0x07b735E020549ba56AAb8e3370d102C2Df6cabF7', '0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59')));
attempt('foreignDeployer', () => validateDeploymentIntent(intent('0x00000000000000000000000000000000000000aa', '0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59')));
attempt('foreignSequencer', () => validateDeploymentIntent(intent('0x07b735E020549ba56AAb8e3370d102C2Df6cabF7', '0x00000000000000000000000000000000000000aa')));
const { loadTrackedGalileoFeePolicy } = require('./scripts/galileo-fee-policy');
attempt('feePolicy', () => loadTrackedGalileoFeePolicy());
const { loadTrackedCollateralProvenance } = require('./scripts/stork-deployment-snapshot');
attempt('provenance', () => loadTrackedCollateralProvenance());
const stork = require('./scripts/stork-deployment-snapshot');
const storkPolicy = JSON.parse(fs.readFileSync(PERPDEX_NETWORK.files.storkPolicy, 'utf8'));
attempt('storkPolicy', () => stork.validateStorkDeploymentPolicy(storkPolicy));
attempt('storkPolicyOldKey', () => stork.validateStorkDeploymentPolicy({ ...storkPolicy, verifier: { ...storkPolicy.verifier, aggregatorPublicKey: '0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44' } }));
attempt('storkPolicyNoProvenance', () => stork.validateStorkDeploymentPolicy({ ...storkPolicy, verifier: { ...storkPolicy.verifier, aggregatorKeyProvenance: undefined } }));
const btc = storkPolicy.feeds.find((feed) => feed.feedId === 'BTCUSD');
const oldKeyFeed = { pair: btc.pair, symbol: btc.symbol, productId: btc.productId, feedId: 'BTCUSD', assetId: 'BTCUSD', signatureType: 'evm', envelopeTimestampNs: '1', priceX18: '1', proof: { publicKey: '0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44', signedTimestampNs: '1' } };
attempt('oldKeySnapshotFeed', () => stork.verifyStorkSignedFeed(oldKeyFeed, btc, storkPolicy.verifier));
results.storkSpread = storkPolicy.coherence.maxSignedTimestampSpreadSeconds;
results.storkStatus = storkPolicy.status;
results.storkDecision = storkPolicy.coherence.decision;
attempt('staticReleasePolicy', () => stork.collectGalileoStaticReleasePolicy());
// Tampered runtime binding in a scratch root: the gate refuses before collateral.
const os = require('os');
const path = require('path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'og-mainnet-runtime-'));
fs.mkdirSync(path.join(scratch, 'config'));
for (const file of [PERPDEX_NETWORK.files.collateralProvenance, 'config/og-mainnet.backend-artifact-manifest.json']) {
  fs.copyFileSync(file, path.join(scratch, file));
}
const tampered = JSON.parse(JSON.stringify(storkPolicy));
tampered.backend.runtimeRelease.artifactManifestSha256 = '0'.repeat(64);
fs.writeFileSync(path.join(scratch, PERPDEX_NETWORK.files.storkPolicy), JSON.stringify(tampered, null, 2) + String.fromCharCode(10));
attempt('tamperedRuntimeRelease', () => stork.collectGalileoStaticReleasePolicy({ repoRoot: scratch }));
fs.rmSync(path.join(scratch, 'config/og-mainnet.backend-artifact-manifest.json'));
fs.writeFileSync(path.join(scratch, PERPDEX_NETWORK.files.storkPolicy), JSON.stringify(storkPolicy, null, 2) + String.fromCharCode(10));
attempt('missingManifest', () => stork.collectGalileoStaticReleasePolicy({ repoRoot: scratch }));
// Tampered super-app collateral provenance in a scratch root: every field fails closed.
fs.copyFileSync('config/og-mainnet.backend-artifact-manifest.json', path.join(scratch, 'config/og-mainnet.backend-artifact-manifest.json'));
const provenance = JSON.parse(fs.readFileSync(PERPDEX_NETWORK.files.collateralProvenance, 'utf8'));
const superAppTamper = {
  commit: '0'.repeat(40),
  tree: '0'.repeat(40),
  fileBlob: '0'.repeat(40),
  fileSha256: '0'.repeat(64),
  registryDomains: { lending: false, amm: false, perpdex: true },
  perpdexLifecycle: 'live',
  perpdexEnabled: true,
  assetId: 'USDT',
};
results.superAppTamper = {};
for (const [field, value] of Object.entries(superAppTamper)) {
  const forged = JSON.parse(JSON.stringify(provenance));
  forged.sources.bondSuperApp[field] = value;
  fs.writeFileSync(path.join(scratch, PERPDEX_NETWORK.files.collateralProvenance), JSON.stringify(forged, null, 2) + String.fromCharCode(10));
  try { stork.collectGalileoStaticReleasePolicy({ repoRoot: scratch }); results.superAppTamper[field] = 'ok'; } catch (error) { results.superAppTamper[field] = error.message; }
}
const nulled = JSON.parse(JSON.stringify(provenance));
nulled.sources.bondSuperApp.commit = null;
fs.writeFileSync(path.join(scratch, PERPDEX_NETWORK.files.collateralProvenance), JSON.stringify(nulled, null, 2) + String.fromCharCode(10));
attempt('superAppNulled', () => stork.collectGalileoStaticReleasePolicy({ repoRoot: scratch }));
fs.rmSync(scratch, { recursive: true, force: true });
results.superAppSource = PERPDEX_NETWORK.pins.collateralProvenanceSources.bondSuperApp;
results.unresolvedPins = stork.unresolvedCollateralProvenancePins();
const { validateProductApprovalReview } = require('./scripts/validate-galileo-product-review');
attempt('productReview', () => validateProductApprovalReview());
results.releaseStatus = policy.status;
console.log(JSON.stringify(results));
`;

describe('0G mainnet profile-selected release gates', function () {
  this.timeout(120000);

  for (const profile of ['og-mainnet', 'og-mainnet-usdz']) {
    it(`${profile}: pins reviewer, operators and collateral provenance; release stays pending`, () => {
      const results = JSON.parse(underProfile(profile, probe));
      expect(results.trackedPolicy).to.equal('ok');
      expect(results.foreignReviewer).to.include('reviewers must be exactly the pinned');
      expect(results.pinnedIntent).to.equal('ok');
      expect(results.foreignDeployer).to.include('pinned');
      expect(results.foreignSequencer).to.include('pinned');
      expect(results.feePolicy).to.equal('ok');
      // Both collaterals statically pin a reviewed super-app registry with no nulls.
      expect(results.provenance).to.equal('ok');
      expect(results.unresolvedPins).to.deep.equal([]);
      expect(results.productReview).to.equal('ok');
      // Stork rotated its aggregator: mainnet accepts only the current key with its
      // pinned bond-perpdex provenance; the previous key is replay-only.
      expect(results.storkPolicy).to.equal('ok');
      expect(results.storkPolicyOldKey).to.include('does not match the reviewed protocol baseline constraints');
      expect(results.storkPolicyNoProvenance).to.include('does not match the reviewed protocol baseline constraints');
      expect(results.oldKeySnapshotFeed).to.include('previous replay-only Stork aggregator key');
      // Red (Adam): exact 3-second cross-feed signed-timestamp spread.
      expect(results.storkSpread).to.equal(3);
      expect(results.storkStatus).to.equal('approved_for_og_mainnet_release');
      expect(results.storkDecision).to.equal('approve_exact_og_mainnet_cross_feed_timestamp_spread');
      // Sequencer lanes, backend runtime-release manifest (a99eb379) and collateral
      // provenance all pass: both profiles clear static release preparation.
      expect(results.staticReleasePolicy).to.equal('ok');
      for (const [field, outcome] of Object.entries(results.superAppTamper)) {
        expect(outcome, field).to.equal('Bond Super App collateral provenance mismatch');
      }
      expect(Object.keys(results.superAppTamper)).to.have.length(8);
      expect(results.superAppNulled).to.equal('Bond Super App collateral provenance mismatch');
      // og-mainnet keeps its 1222b471 USDCE pin; USDZ binds PR #1123 head fb482b86.
      expect(results.superAppSource).to.deep.equal(
        profile === 'og-mainnet'
          ? {
              repository: 'Bond-xyz/bond-super-app',
              commit: '1222b4710b2a4a15f1af2bd70a181a220212d287',
              tree: '2ea4f4ab4e2ba7a6aabd71d69e8f8972ebc6a13d',
              file: 'packages/config/src/generated/registry.ts',
              fileBlob: '4624cd8c4904b2994a3e02464342f4aaeb6851de',
              fileSha256: '281ad15c6437e5cc3a6de1fe548ee929e9ea9eb09f389d845fb398d087994d29',
              assetId: 'USDCE',
              registryDomains: { lending: true, amm: true, perpdex: false },
              perpdexLifecycle: 'pending_fresh_deploy',
              perpdexEnabled: false,
            }
          : {
              repository: 'Bond-xyz/bond-super-app',
              commit: 'fb482b8640f67f23b710b87e429230615700808f',
              tree: 'b1fdefb98dc2e0ac7fd899ca0703494af8b3cd33',
              file: 'packages/config/src/generated/registry.ts',
              fileBlob: '3850aa1d7efeb3a72e7928c4bdec7bd6cc02b418',
              fileSha256: '10c5b01f4e7e4b9049095ad9a07119e328ee21763e5f7f5811ae157cbf0ab44b',
              assetId: 'USDZ',
              registryDomains: { lending: false, amm: false, perpdex: false },
              perpdexLifecycle: 'pending_fresh_deploy',
              perpdexEnabled: false,
            }
      );
      expect(results.tamperedRuntimeRelease).to.include(
        'backend runtime artifact manifest SHA-256 does not match the tracked manifest bytes'
      );
      expect(results.missingManifest).to.include('reviewed backend artifact manifest is missing');
      // Release activation still waits for Adam's approval and attestation.
      expect(results.releaseStatus).to.equal('pending_og_mainnet_review');
    });
  }
});
