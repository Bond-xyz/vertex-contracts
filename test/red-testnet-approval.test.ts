import { expect } from 'chai';
import { Wallet } from 'ethers';
import { GalileoReleasePolicy, validateReleasePolicy } from '../scripts/release-attestation';
import {
  assertSameVerifiedRedTestnetReleaseEvidence,
  VerifiedRedTestnetReleaseEvidence,
} from '../scripts/red-testnet-approval';
import { validateProductApprovalReview } from '../scripts/validate-galileo-product-review';

function trackedRedPolicy(): GalileoReleasePolicy {
  return {
    schemaVersion: 1,
    policyId: 'bond-perpdex-galileo-testnet-release',
    policyVersion: 3,
    projectId: 'g-bond',
    releaseId: 'bond-perpdex-galileo-audited-base',
    attestationDomain: { name: 'Bond PerpDex Galileo Release', version: '1' },
    chainId: 16602,
    collateral: {
      address: '0xF2506aa3684871549083d235453a1dcDcCB3396c',
      productId: 0,
      symbol: 'USDC.e',
      decimals: 6,
    },
    approvalMode: 'tracked_red_testnet_approval',
    requiredReviewerSignatures: 0,
    reviewers: [],
    redApprovalArtifact: 'config/galileo.red-testnet-approval.json',
    mainnetExternalReviewRequired: true,
    status: 'blocked_pending_red_tracked_approval_and_product_approval',
  };
}

describe('tracked Red Galileo testnet approval', () => {
  it('allows no synthetic reviewer wallet and never waives mainnet review', () => {
    expect(() => validateReleasePolicy(trackedRedPolicy())).not.to.throw();
    expect(() =>
      validateReleasePolicy({
        ...trackedRedPolicy(),
        requiredReviewerSignatures: 1,
        reviewers: [{ name: 'Fake reviewer', address: Wallet.createRandom().address }],
      })
    ).to.throw('no synthetic reviewer wallet');
    expect(() => validateReleasePolicy({ ...trackedRedPolicy(), mainnetExternalReviewRequired: false })).to.throw(
      'must not waive mainnet external review'
    );
  });

  it('accepts only the exact beta static vectors without treating them as dynamic deployment evidence', () => {
    const result = validateProductApprovalReview();
    expect(result.ready).to.equal(true);
    expect(result.scope).to.equal('static_market_size_and_20x_only');
    expect(result.blockers).to.deep.equal([]);
    const sol = result.marketVectors.find((market) => market.productId === 6);
    const zeroG = result.marketVectors.find((market) => market.productId === 8);
    expect(sol?.sizeMatch).to.equal(true);
    expect(zeroG?.sizeMatch).to.equal(true);
    expect(sol?.initialPriceSource).to.equal('verified_stork_deployment_snapshot');
    expect(zeroG?.initialPriceSource).to.equal('verified_stork_deployment_snapshot');
  });

  it('rejects post-approval provenance drift', () => {
    const evidence = {
      approvalSha256: '11'.repeat(32),
      approvalDigest: '22'.repeat(32),
      source: { releaseCommit: '33'.repeat(20), sourceTree: '44'.repeat(20) },
      policySha256: '55'.repeat(32),
      buildEvidenceSha256: '66'.repeat(32),
      productConfigSha256: '77'.repeat(32),
      productReviewSha256: '88'.repeat(32),
      staticPolicy: {
        policySha256: 'aa'.repeat(32),
        collateralProvenanceSha256: 'cc'.repeat(32),
      },
      verifierConfigSha256: '99'.repeat(32),
      deploymentIntent: { deploymentId: `0x${'aa'.repeat(32)}` },
    } as unknown as VerifiedRedTestnetReleaseEvidence;
    expect(() =>
      assertSameVerifiedRedTestnetReleaseEvidence(evidence, {
        ...evidence,
        productReviewSha256: 'bb'.repeat(32),
      })
    ).to.throw('post-deploy provenance drift: product review SHA-256 changed');
  });
});
