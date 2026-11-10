import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';
import {
  loadProducts,
  loadVerifierConfig,
  OG_MAINNET_CHAIN_ID,
  PERPDEX_NETWORK,
  PERPDEX_NETWORK_PROFILES,
  requireProfileCollateral,
  resolveNetworkProfile,
  resolveSequencer,
} from '../scripts/deployment-config';

const root = path.resolve(__dirname, '..');
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const mainnet = resolveNetworkProfile('og-mainnet');
const usdz = resolveNetworkProfile('og-mainnet-usdz');

describe('PerpDex network profiles', () => {
  it('defaults to Galileo and refuses unknown profiles', () => {
    expect(resolveNetworkProfile(undefined).name).to.equal('galileo');
    expect(resolveNetworkProfile('').chainId).to.equal(16602);
    expect(PERPDEX_NETWORK.name).to.equal('galileo');
    expect(() => resolveNetworkProfile('mainnet')).to.throw('PERPDEX_NETWORK must be one of');
  });

  it('models dual mainnet collateral as two independent chain-16661 deployments', () => {
    expect(mainnet.chainId).to.equal(OG_MAINNET_CHAIN_ID);
    expect(usdz.chainId).to.equal(OG_MAINNET_CHAIN_ID);
    expect(mainnet.collateral.address).to.equal(utils.getAddress('0x1f3aa82227281ca364bfb3d253b0f1af1da6473e'));
    expect(usdz.collateral.address).to.equal(utils.getAddress('0xd4d54bd7379e799417563b1bb42426c9bd4ccb2a'));
    expect(mainnet.collateral.symbol).to.equal('USDC.e');
    expect(usdz.collateral.symbol).to.equal('USDZ');
    expect(mainnet.releaseId).not.to.equal(usdz.releaseId);
    expect(mainnet.deploymentsDir).to.equal('deployments/16661/og-mainnet');
    expect(usdz.deploymentsDir).to.equal('deployments/16661/og-mainnet-usdz');
    expect(usdz.marketSymbols).to.deep.equal(['BTCUSDZPERP', 'ETHUSDZPERP', 'SOLUSDZPERP', '0GUSDZPERP']);
    for (const profile of [mainnet, usdz]) {
      expect(profile.deployerPrivateKeyEnv).to.equal(null);
      expect(profile.approvalMode).to.equal('external_reviewer_signature');
      expect(profile.files.redApproval).to.equal(null);
    }
  });

  it('pins the production sequencer and collateral for mainnet profiles', () => {
    const deployer = '0x00000000000000000000000000000000000000aa';
    expect(resolveSequencer(undefined, deployer, PERPDEX_NETWORK_PROFILES.galileo)).to.equal(deployer);
    expect(resolveSequencer('0x2a83be9cc98d70c20eac0d8c35b1d035b2741c59', deployer, mainnet)).to.equal(
      '0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59'
    );
    expect(() => resolveSequencer(undefined, deployer, mainnet)).to.throw('pinned production sequencer');
    expect(() => resolveSequencer(deployer, deployer, usdz)).to.throw('pinned production sequencer');
    expect(() => requireProfileCollateral(mainnet.collateral.address, usdz)).to.throw('substitutes are forbidden');
  });

  it('keeps mainnet config files bound to their own profile', () => {
    for (const profile of [mainnet, usdz]) {
      const products = loadProducts(path.join(root, profile.files.products), { requireApproved: false, profile });
      expect(products.approved).to.equal(false);
      expect(() => loadProducts(path.join(root, profile.files.products), { profile })).to.throw('not approved');
      expect(() =>
        loadProducts(path.join(root, PERPDEX_NETWORK_PROFILES.galileo.files.products), { profile })
      ).to.throw('chainId must be 16661');
      const provenance = readJson(profile.files.collateralProvenance);
      expect(provenance.chainId).to.equal(OG_MAINNET_CHAIN_ID);
      expect(utils.getAddress(provenance.collateral.address)).to.equal(profile.collateral.address);
      expect(provenance.provenanceId).to.equal(profile.ids.collateralProvenance);
      expect(provenance.normalizedCarriedFieldTupleSha256).to.equal(profile.pins.normalizedCarriedFieldTupleSha256);
      expect(provenance.sources).to.deep.equal(profile.pins.collateralProvenanceSources);
      for (const file of [profile.files.releasePolicy, profile.files.storkPolicy, profile.files.productReview]) {
        expect(readJson(file).chainId).to.equal(OG_MAINNET_CHAIN_ID);
      }
      const release = readJson(profile.files.releasePolicy);
      expect(release.releaseId).to.equal(profile.releaseId);
      expect(release.status).not.to.equal(profile.activeReleaseStatus);
      expect(readJson(profile.files.feePolicy).status).not.to.equal(profile.activeReleaseStatus);
      expect(readJson(profile.files.storkPolicy).feeds.map((feed: { symbol: string }) => feed.symbol)).to.deep.equal([
        ...profile.marketSymbols,
      ]);
    }
    const crossed = path.join(root, mainnet.files.products);
    expect(() => loadProducts(crossed, { requireApproved: false, profile: usdz })).to.throw(
      'launch market symbols must be exactly'
    );
  });

  it('loads the shared mainnet verifier quorum as three distinct points for bitmask 7', () => {
    const config = loadVerifierConfig(path.join(root, mainnet.files.verifierPublicKeys), mainnet);
    expect(config.signerBitmask).to.equal(7);
    expect(config.keys).to.have.length(3);
    expect(usdz.files.verifierPublicKeys).to.equal(mainnet.files.verifierPublicKeys);
    expect(() =>
      loadVerifierConfig(path.join(root, mainnet.files.verifierPublicKeys), PERPDEX_NETWORK_PROFILES.galileo)
    ).to.throw('must target chain 16602');
  });

  it('keeps the audited contract baseline identical across Galileo and mainnet', () => {
    expect(fs.readFileSync(path.join(root, mainnet.files.contractBaseline), 'utf8')).to.equal(
      fs.readFileSync(path.join(root, PERPDEX_NETWORK_PROFILES.galileo.files.contractBaseline), 'utf8')
    );
  });
});
