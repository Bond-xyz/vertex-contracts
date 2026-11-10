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
console.log(JSON.stringify(results));
`;

describe('0G mainnet profile-selected release gates', function () {
  this.timeout(120000);

  for (const profile of ['og-mainnet', 'og-mainnet-usdz']) {
    it(`${profile}: pins reviewer and operators and stays fail-closed on operator-fill inputs`, () => {
      const results = JSON.parse(underProfile(profile, probe));
      expect(results.trackedPolicy).to.equal('ok');
      expect(results.foreignReviewer).to.include('reviewers must be exactly the pinned');
      expect(results.pinnedIntent).to.equal('ok');
      expect(results.foreignDeployer).to.include('pinned');
      expect(results.foreignSequencer).to.include('pinned');
      expect(results.feePolicy).to.equal('ok');
      if (profile === 'og-mainnet') {
        expect(results.provenance).to.equal('ok');
      } else {
        // USDZ is still missing from the super-app generated registry.
        expect(results.provenance).to.include('unresolved operator-fill fields: sources.bondSuperApp.commit');
      }
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
      // The 1x sequencer evidence gate is the first release-preparation refusal.
      expect(results.staticReleasePolicy).to.equal(
        `${profile} backend sequencer 1x runtime config evidence is unresolved`
      );
    });
  }
});
