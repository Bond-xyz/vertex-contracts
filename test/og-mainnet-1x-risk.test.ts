import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { loadProducts, PERPDEX_NETWORK_PROFILES, resolveNetworkProfile } from '../scripts/deployment-config';

const root = path.resolve(__dirname, '..');
const ONE = 1_000_000_000n;

// Mirrors RiskHelper._getWeightX18 + perp health: after opening `notional` of exposure
// against `collateral` quote at the mark price, initial health is
//   long:  collateral - notional + notional * longWeightInitial
//   short: collateral + notional - notional * shortWeightInitial
function initialHealth(collateral: bigint, notional: bigint, side: 'long' | 'short', weight: number): bigint {
  const w = BigInt(weight);
  return side === 'long'
    ? collateral * ONE - notional * ONE + notional * w
    : collateral * ONE + notional * ONE - notional * w;
}

describe('0G mainnet 1x launch risk', () => {
  for (const name of ['og-mainnet', 'og-mainnet-usdz'] as const) {
    const profile = resolveNetworkProfile(name);

    it(`${name}: every launch product caps initial leverage at exactly 1x`, () => {
      const products = loadProducts(path.join(root, profile.files.products), { profile });
      expect(profile.riskModel.maximumLeverage).to.equal('1');
      for (const product of products.products) {
        expect(product.risk).to.deep.equal(profile.riskModel.weights);
        const collateral = 1_000n;
        // A 1x long sits exactly on the initial-health boundary; a full 1x short is
        // refused (short cap is 1/1.000000001x); anything above 1x is refused.
        expect(initialHealth(collateral * ONE, collateral * ONE, 'long', product.risk.longWeightInitial)).to.equal(0n);
        expect(
          initialHealth(collateral * ONE, collateral * ONE + 1n, 'long', product.risk.longWeightInitial) < 0n
        ).to.equal(true);
        expect(initialHealth(collateral, collateral, 'short', product.risk.shortWeightInitial) < 0n).to.equal(true);
        expect(initialHealth(1_000_000_001n, 1_000_000_000n, 'short', product.risk.shortWeightInitial) >= 0n).to.equal(
          true
        );
        // Weights sit exactly on the audited loadProducts bounds and PerpEngine ordering.
        expect(product.risk.longWeightInitial).to.equal(0);
        // 2.0 is BaseEngine's spot-short sentinel (health = int128.min).
        expect(product.risk.shortWeightInitial).to.equal(2_000_000_001);
        expect(product.risk.longWeightInitial <= product.risk.longWeightMaintenance).to.equal(true);
        expect(product.risk.shortWeightInitial >= product.risk.shortWeightMaintenance).to.equal(true);
      }
      const review = JSON.parse(fs.readFileSync(path.join(root, profile.files.productReview), 'utf8'));
      expect(review.riskModel).to.include({
        initialMarginPercent: '100',
        maintenanceMarginPercent: '50',
        maximumLeverage: '1',
      });
    });
  }

  it('leaves Galileo at its approved 20x vectors', () => {
    const galileo = PERPDEX_NETWORK_PROFILES.galileo;
    expect(galileo.riskModel.maximumLeverage).to.equal('20');
    expect(initialHealth(1_000n, 20_000n, 'long', galileo.riskModel.weights.longWeightInitial)).to.equal(0n);
  });
});
