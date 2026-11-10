import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { utils } from 'ethers';
import { assertIndependentReleaseReviewer } from '../scripts/release-attestation';
import {
  assertDistinctVerifierQuorum,
  carriedFieldTupleSha256,
  loadProducts,
  loadVerifierConfig,
  OG_MAINNET_CHAIN_ID,
  PERPDEX_NETWORK,
  PERPDEX_NETWORK_PROFILES,
  requirePinnedDeployer,
  requireProfileCollateral,
  resolveNetworkProfile,
  resolveSequencer,
} from '../scripts/deployment-config';
import { assertSequencerLeverageEvidence } from '../scripts/stork-deployment-snapshot';

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
      expect(profile.deployerPrivateKeyEnv).to.equal('PERPDEX_OG_MAINNET_DEPLOYER_PRIVATE_KEY');
      expect(profile.operators.deployer).to.equal('0x07b735E020549ba56AAb8e3370d102C2Df6cabF7');
      expect(profile.approvalMode).to.equal('external_reviewer_signature');
      // Adam delegated mainnet release review to the deployer key.
      expect(profile.releaseReviewer).to.deep.equal({
        name: 'Adam (deployer wallet)',
        address: '0x07b735E020549ba56AAb8e3370d102C2Df6cabF7',
        mayBeDeployer: true,
      });
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
    expect(requirePinnedDeployer('0x07b735e020549ba56aab8e3370d102c2df6cabf7', usdz)).to.equal(
      '0x07b735E020549ba56AAb8e3370d102C2Df6cabF7'
    );
    expect(() => requirePinnedDeployer(deployer, mainnet)).to.throw('pinned deployer');
    // Reviewer == deployer is allowed only through the explicit profile delegation;
    // the default audited check and the sequencer check stay strict.
    const mainnetDeployer = '0x07b735E020549ba56AAb8e3370d102C2Df6cabF7';
    const sequencer = '0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59';
    expect(() =>
      assertIndependentReleaseReviewer(mainnetDeployer, mainnetDeployer, sequencer, { allowDeployer: true })
    ).not.to.throw();
    expect(() => assertIndependentReleaseReviewer(mainnetDeployer, mainnetDeployer, sequencer)).to.throw(
      'independent from the deployer'
    );
    expect(() =>
      assertIndependentReleaseReviewer(sequencer, mainnetDeployer, sequencer, { allowDeployer: true })
    ).to.throw('independent from the sequencer');
    expect(requirePinnedDeployer(deployer, PERPDEX_NETWORK_PROFILES.galileo)).to.equal(utils.getAddress(deployer));
  });

  it('keeps mainnet config files bound to their own profile', () => {
    for (const profile of [mainnet, usdz]) {
      const products = loadProducts(path.join(root, profile.files.products), { requireApproved: false, profile });
      // Red (Adam) approved the 1x mainnet vectors.
      expect(products.approved).to.equal(true);
      expect(() => loadProducts(path.join(root, profile.files.products), { profile })).not.to.throw();
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
      expect(release.reviewers).to.deep.equal([
        { name: 'Adam (deployer wallet)', address: '0x07b735E020549ba56AAb8e3370d102C2Df6cabF7' },
      ]);
      expect(release.reviewers[0].address).to.equal(utils.getAddress(release.reviewers[0].address));
      const fee = readJson(profile.files.feePolicy);
      expect(fee.status).to.equal(profile.activeReleaseStatus);
      expect(fee.requiredEnvironmentVariable).to.equal(profile.gasPriceEnv);
      expect(fee.observation).to.include({ blockNumber: 49846964, gasPriceWei: '4000000007' });
      expect(BigInt(fee.minimumGasPriceWei)).to.equal(profile.pins.feeBoundsWei?.minimum);
      expect(BigInt(fee.defaultGasPriceWei)).to.equal(profile.pins.feeBoundsWei?.default);
      expect(BigInt(fee.maximumGasPriceWei)).to.equal(profile.pins.feeBoundsWei?.maximum);
      expect(readJson(profile.files.storkPolicy).feeds.map((feed: { symbol: string }) => feed.symbol)).to.deep.equal([
        ...profile.marketSymbols,
      ]);
    }
    const crossed = path.join(root, mainnet.files.products);
    expect(() => loadProducts(crossed, { requireApproved: false, profile: usdz })).to.throw(
      'launch market symbols must be exactly'
    );
  });

  it('binds a distinct verifier quorum per mainnet deployment (cross-Endpoint replay safety)', () => {
    expect(mainnet.files.verifierPublicKeys).to.equal('config/og-mainnet.verifier-public-keys.json');
    expect(usdz.files.verifierPublicKeys).to.equal('config/og-mainnet-usdz.verifier-public-keys.json');
    expect(mainnet.distinctVerifierQuorumFrom).to.deep.equal(['og-mainnet-usdz']);
    expect(usdz.distinctVerifierQuorumFrom).to.deep.equal(['og-mainnet']);
    const usdcQuorum = loadVerifierConfig(path.join(root, mainnet.files.verifierPublicKeys), mainnet);
    const usdzQuorum = loadVerifierConfig(path.join(root, usdz.files.verifierPublicKeys), usdz);
    for (const config of [usdcQuorum, usdzQuorum]) {
      expect(config.signerBitmask).to.equal(7);
      expect(config.keys).to.have.length(3);
    }
    const usdcX = new Set(usdcQuorum.keys.map((key) => key.x.toLowerCase()));
    expect(usdzQuorum.keys.filter((key) => usdcX.has(key.x.toLowerCase()))).to.have.length(0);
    expect(() =>
      loadVerifierConfig(path.join(root, mainnet.files.verifierPublicKeys), PERPDEX_NETWORK_PROFILES.galileo)
    ).to.throw('must target chain 16602');
  });

  it('refuses a mainnet verifier config that reuses any key from the sibling deployment', () => {
    const usdcQuorum = readJson(mainnet.files.verifierPublicKeys);
    const usdzQuorum = readJson(usdz.files.verifierPublicKeys);
    expect(() => loadVerifierConfig(path.join(root, mainnet.files.verifierPublicKeys), usdz)).to.throw(
      'shares 3 key(s) with og-mainnet'
    );
    const oneShared = { ...usdzQuorum, keys: [usdcQuorum.keys[0], ...usdzQuorum.keys.slice(1)] };
    expect(() => assertDistinctVerifierQuorum(oneShared, usdz)).to.throw('shares 1 key(s) with og-mainnet');
    expect(() => assertDistinctVerifierQuorum(oneShared, mainnet)).to.throw('shares 2 key(s) with og-mainnet-usdz');
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-quorum-'));
    expect(() => assertDistinctVerifierQuorum(usdzQuorum, usdz, emptyRoot)).to.throw('og-mainnet config is missing');
  });

  it('derives a distinct canonical_json_v1 carried-field tuple hash per mainnet collateral', () => {
    const hashes = [mainnet, usdz].map((profile) => {
      const provenance = readJson(profile.files.collateralProvenance);
      const derived = carriedFieldTupleSha256(provenance);
      expect(profile.pins.carriedFieldTupleDerivation).to.equal('canonical_json_v1');
      expect(derived).to.equal(profile.pins.normalizedCarriedFieldTupleSha256);
      expect(provenance.normalizedCarriedFieldTupleSha256).to.equal(derived);
      expect(carriedFieldTupleSha256({ ...provenance, provenanceId: `${provenance.provenanceId}-x` })).not.to.equal(
        derived
      );
      return derived;
    });
    expect(hashes[0]).not.to.equal(hashes[1]);
    expect(PERPDEX_NETWORK_PROFILES.galileo.pins.carriedFieldTupleDerivation).to.equal('legacy_literal');
  });

  it('pins both mainnet product reviews to the merged contract packet', () => {
    for (const profile of [mainnet, usdz]) {
      expect(profile.pins.contractPacketBase).to.deep.equal({
        commit: '15287abc32072de7cbe820119682dce73e044eb1',
        tree: 'a9cbb18229e9ce65c23cd413339036fc2b44971c',
      });
      const review = readJson(profile.files.productReview);
      expect(review.contractSource.releaseCommit).to.equal(profile.pins.contractPacketBase?.commit);
      expect(review.contractSource.releaseTree).to.equal(profile.pins.contractPacketBase?.tree);
    }
  });

  it('rotates only mainnet to the current Stork aggregator and keeps Galileo on its historical key', () => {
    const galileo = PERPDEX_NETWORK_PROFILES.galileo;
    expect(galileo.storkAggregator.current).to.equal('0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44');
    expect(galileo.storkAggregator.provenance).to.equal(null);
    for (const profile of [mainnet, usdz]) {
      expect(profile.storkAggregator.current).to.equal('0x0bb53E0d5E89778DCD13C2720667D292368dD053');
      expect(profile.storkAggregator.previousReplayOnly).to.deep.equal([galileo.storkAggregator.current]);
      const policy = readJson(profile.files.storkPolicy);
      expect(policy.verifier.aggregatorPublicKey).to.equal(profile.storkAggregator.current);
      expect(policy.verifier.aggregatorKeyProvenance).to.deep.equal(profile.storkAggregator.provenance);
    }
  });

  it('refuses the 2e9 sentinel short weight and gates mainnet on sequencer 1x runtime evidence', () => {
    const products = readJson(mainnet.files.products);
    products.products[0].risk.shortWeightInitial = 2_000_000_000;
    const file = path.join(os.tmpdir(), `og-mainnet-sentinel-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(products));
    expect(() => loadProducts(file, { profile: mainnet })).to.throw('risk weights violate audited bounds');
    products.products[0].risk.shortWeightInitial = 2_000_000_002;
    fs.writeFileSync(file, JSON.stringify(products));
    expect(() => loadProducts(file, { profile: mainnet })).to.throw('risk weights violate audited bounds');
    fs.unlinkSync(file);
    for (const profile of [mainnet, usdz]) {
      expect(() => assertSequencerLeverageEvidence(profile)).to.throw(
        'sequencer 1x runtime config evidence is unresolved'
      );
    }
    expect(() => assertSequencerLeverageEvidence(PERPDEX_NETWORK_PROFILES.galileo)).not.to.throw();
    // A mainnet profile cannot switch the gate off.
    for (const profile of [mainnet, usdz]) {
      expect(() =>
        assertSequencerLeverageEvidence({ ...profile, sequencerLeverageEvidence: { required: false, evidence: null } })
      ).to.throw('gate must stay required');
    }
    const file0 = { path: 'services/trading/run/config.toml', blob: 'a'.repeat(40), sha256: 'b'.repeat(64) };
    type Evidence = NonNullable<typeof mainnet.sequencerLeverageEvidence.evidence>;
    const evidence = (shortOpeningCollateralPpb: number, maxLeverage = 1, overrides: Record<string, unknown> = {}) =>
      ({
        ...mainnet,
        sequencerLeverageEvidence: {
          required: true,
          evidence: {
            repository: 'Bond-xyz/bond-perpdex',
            commit: 'c'.repeat(40),
            tree: 'd'.repeat(40),
            maxLeverage,
            shortOpeningCollateralPpb,
            shortAdmissionBasis: 'post_fill_initial_health_at_oracle_mark',
            feesReservedSeparately: true,
            lanes: [
              { deployment: 'og-mainnet', files: [file0] },
              { deployment: 'og-mainnet-usdz', files: [file0] },
            ],
            ...overrides,
          } as Evidence,
        },
      } as typeof mainnet);
    expect(() => assertSequencerLeverageEvidence(evidence(1_000_000_001))).not.to.throw();
    // The integer 1x cap alone (exact-notional short reserve) is not sufficient.
    expect(() => assertSequencerLeverageEvidence(evidence(1_000_000_000))).to.throw('does not preserve');
    expect(() => assertSequencerLeverageEvidence(evidence(1_000_000_001, 20))).to.throw('does not preserve');
    // Health values shorts at the oracle mark and fees leave quote after the fill.
    for (const overrides of [
      { shortAdmissionBasis: 'ppb_of_fill_notional' },
      { shortAdmissionBasis: 'ppb_of_max_fill_and_mark_notional' },
      { shortAdmissionBasis: undefined },
      { feesReservedSeparately: false },
      { feesReservedSeparately: undefined },
      { repository: '' },
      { repository: 'not a repo' },
      { lanes: [{ deployment: 'og-mainnet', files: [file0] }] },
      {
        lanes: [
          { deployment: 'og-mainnet', files: [file0, file0] },
          { deployment: 'og-mainnet-usdz', files: [file0] },
        ],
      },
      {
        lanes: [
          { deployment: 'og-mainnet', files: [{ ...file0, path: '../config.toml' }] },
          { deployment: 'og-mainnet-usdz', files: [file0] },
        ],
      },
      {
        lanes: [
          { deployment: 'og-mainnet', files: [{ ...file0, path: '/etc/config.toml' }] },
          { deployment: 'og-mainnet-usdz', files: [file0] },
        ],
      },
    ]) {
      expect(() => assertSequencerLeverageEvidence(evidence(1_000_000_001, 1, overrides))).to.throw(
        'does not preserve'
      );
    }
    expect(() =>
      assertSequencerLeverageEvidence(
        evidence(1_000_000_001, 1, {
          lanes: [
            { deployment: 'og-mainnet', files: [{ ...file0, blob: 'z'.repeat(40) }] },
            { deployment: 'og-mainnet-usdz', files: [file0] },
          ],
        })
      )
    ).to.throw();
  });

  it('refuses the 2e9 sentinel short weight under the Galileo profile too', () => {
    const galileo = PERPDEX_NETWORK_PROFILES.galileo;
    const products = readJson(galileo.files.products);
    products.products[0].risk.shortWeightInitial = 2_000_000_000;
    const file = path.join(os.tmpdir(), `galileo-sentinel-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(products));
    try {
      expect(() => loadProducts(file, { profile: galileo, requireApproved: false })).to.throw(
        'risk weights violate audited bounds'
      );
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('never funds insurance from any deployment script', () => {
    for (const file of fs.readdirSync(path.join(root, 'scripts'))) {
      expect(fs.readFileSync(path.join(root, 'scripts', file), 'utf8'), file).not.to.match(/depositInsurance/);
    }
  });

  it('keeps the audited contract baseline identical across Galileo and mainnet', () => {
    expect(fs.readFileSync(path.join(root, mainnet.files.contractBaseline), 'utf8')).to.equal(
      fs.readFileSync(path.join(root, PERPDEX_NETWORK_PROFILES.galileo.files.contractBaseline), 'utf8')
    );
  });
});
