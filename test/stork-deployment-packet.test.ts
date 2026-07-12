import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import { GALILEO_USDCE_ADDRESS, loadProducts, resolveProductsWithStorkPrices } from '../scripts/deployment-config';
import {
  APPROVED_STORK_COHERENCE_DECISION,
  APPROVED_STORK_DEPLOYMENT_POLICY_STATUS,
  BACKEND_PROTOCOL_BASELINE_COMMIT,
  BLOCKED_STORK_COHERENCE_DECISION,
  BLOCKED_STORK_DEPLOYMENT_POLICY_STATUS,
  assertStorkDeploymentSnapshotFresh,
  assertStorkSnapshotObservationTime,
  collectGalileoStaticReleasePolicy,
  collectGalileoStorkReleasePreflight,
  executeAfterGalileoStorkPreflight,
  loadTrackedCollateralProvenance,
  loadTrackedStorkDeploymentPolicy,
  validateStorkDeploymentPolicy,
  validateStorkDeploymentSnapshot,
  verifyStorkSignedFeed,
} from '../scripts/stork-deployment-snapshot';
import { createTrackedGalileoDeploymentIntent } from '../scripts/create-galileo-deployment-intent';
import {
  GALILEO_CONTRACT_PACKET_BASE_COMMIT,
  GALILEO_CONTRACT_PACKET_BASE_TREE,
  validateProductApprovalReview,
} from '../scripts/validate-galileo-product-review';

const OFFICIAL_BTC_PROOF = {
  pair: 'BTC/USD',
  symbol: 'BTCUSDCPERP',
  productId: 2,
  feedId: 'BTCUSD',
  envelopeTimestampNs: '1722632569208762117',
  assetId: 'BTCUSD',
  signatureType: 'evm',
  priceX18: '62507457175499998000000',
  proof: {
    publicKey: '0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44',
    encodedAssetId: '0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de',
    signedTimestampNs: '1722632569208762117',
    messageHash: '0x3102baf2e5ad5188e24d56f239915bed3a9a7b51754007dcbf3a65f81bae3084',
    signature: {
      r: '0xb9b3c9f80a355bd0cd6f609fff4a4b15fa4e3b4632adabb74c020f5bcd240741',
      s: '0x16fab526529ac795108d201832cff8c2d2b1c710da6711fe9f7ab288a7149758',
      v: 28,
    },
    publisherMerkleRoot: '0xe5ff773b0316059c04aa157898766731017610dcbeede7d7f169bfeaab7cc318',
    calculationAlgorithm: {
      type: 'median',
      version: 'v1',
      checksum: '9be7e9f9ed459417d96112a7467bd0b27575a2c7847195c68f805b70ce1795ba',
    },
  },
};

describe('Galileo signed Stork deployment packet', () => {
  it('keeps provider, nonce, transaction, and intent actions unreachable for every Stork preflight failure class', async () => {
    let providerOrTransactionCalls = 0;
    const action = async () => {
      providerOrTransactionCalls += 1;
    };
    let error: unknown;
    try {
      await executeAfterGalileoStorkPreflight(() => collectGalileoStorkReleasePreflight(), action);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.contain('final immutable backend artifact/source binding is unresolved');

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'galileo-stork-preflight-'));
    fs.mkdirSync(path.join(temporaryRoot, 'config'));
    const policy = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'config', 'galileo.stork-deployment-policy.json'), 'utf8')
    );
    policy.coherence = {
      maxSignedTimestampSpreadSeconds: 3,
      decisionOwner: 'Red',
      decision: APPROVED_STORK_COHERENCE_DECISION,
    };
    policy.status = APPROVED_STORK_DEPLOYMENT_POLICY_STATUS;
    fs.writeFileSync(
      path.join(temporaryRoot, 'config', 'galileo.stork-deployment-policy.json'),
      JSON.stringify(policy)
    );
    fs.copyFileSync(
      path.resolve(__dirname, '..', 'config', 'galileo.collateral-provenance.json'),
      path.join(temporaryRoot, 'config', 'galileo.collateral-provenance.json')
    );
    try {
      expect(() => collectGalileoStaticReleasePolicy({ repoRoot: temporaryRoot })).to.throw(
        'final immutable backend artifact/source binding is unresolved'
      );
      policy.backend.runtimeRelease = {
        sourceCommit: '44c6595a3f8d5d1b1791b5d18d08442057223072',
        artifactManifestSha256: 'ab'.repeat(32),
        status: 'reviewed_immutable_backend_release',
      };
      fs.writeFileSync(
        path.join(temporaryRoot, 'config', 'galileo.stork-deployment-policy.json'),
        JSON.stringify(policy)
      );
      const staticPolicy = collectGalileoStaticReleasePolicy({ repoRoot: temporaryRoot });
      expect(staticPolicy.policySha256).to.match(/^[0-9a-f]{64}$/);
      expect(
        fs.existsSync(path.join(temporaryRoot, 'config', 'galileo.stork-deployment-snapshot.local.json'))
      ).to.equal(false);
      error = undefined;
      try {
        await executeAfterGalileoStorkPreflight(
          () => collectGalileoStorkReleasePreflight({ repoRoot: temporaryRoot }),
          action
        );
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).to.contain('fresh signed Stork deployment snapshot is unavailable');
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }

    const { policy: trackedPolicy } = loadTrackedStorkDeploymentPolicy();
    error = undefined;
    try {
      await executeAfterGalileoStorkPreflight(() => {
        verifyStorkSignedFeed(
          { ...OFFICIAL_BTC_PROOF, priceX18: '62507457175499998000001' },
          trackedPolicy.feeds[0],
          trackedPolicy.verifier
        );
        return {} as never;
      }, action);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.contain('message hash does not match');

    error = undefined;
    try {
      await executeAfterGalileoStorkPreflight(() => {
        assertStorkDeploymentSnapshotFresh(
          {
            feeds: trackedPolicy.feeds.map((feed) => ({ ...feed, signedTimestampNs: '100000000000' })),
          } as never,
          trackedPolicy,
          131_000_000_001n
        );
        return {} as never;
      }, action);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.contain('stale');
    expect(providerOrTransactionCalls).to.equal(0);

    expect(() => createTrackedGalileoDeploymentIntent()).to.throw(
      'final immutable backend artifact/source binding is unresolved'
    );
    const deploySource = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'deploy-galileo.ts'), 'utf8');
    expect(deploySource.indexOf('const preflight = await collectAndVerifyRedTestnetReleaseEvidence')).to.be.lessThan(
      deploySource.indexOf('Sanctions.deploy(')
    );
    expect(deploySource.indexOf('collectGalileoStorkReleasePreflight({')).to.be.greaterThan(
      deploySource.indexOf('prepared graph was already finalized')
    );
    expect(deploySource.indexOf('collectGalileoStorkReleasePreflight({')).to.be.lessThan(
      deploySource.indexOf('const journal = await runDurableFinalization')
    );
    expect(deploySource.indexOf('assertProductionFinalizationEntryState({')).to.be.lessThan(
      deploySource.indexOf('const journal = await runDurableFinalization')
    );
    expect(deploySource).to.contain('expectedOwner: prepared.deployer');
    expect(deploySource).to.contain('expectedSequencer: prepared.sequencer');
    expect(deploySource).not.to.contain('const endpointInitializeTx');
    expect(deploySource).not.to.contain('verifiedSignedStorkSnapshotBeforeFirstProviderReadAndTransaction');
    const packetCreatorSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'create-galileo-stork-snapshot.ts'),
      'utf8'
    );
    expect(
      packetCreatorSource.indexOf('validateStorkDeploymentSnapshot(snapshot, policy, policySha256)')
    ).to.be.lessThan(packetCreatorSource.indexOf('fs.writeFileSync(outputFile'));
  });

  it('pins the reviewed protocol baseline and Red-approved spread while leaving the runtime artifact unresolved', () => {
    const { policy } = loadTrackedStorkDeploymentPolicy();
    expect(policy.backend.repository).to.equal('Bond-xyz/perpdex-rust-backend');
    expect(policy.backend.releaseCommit).to.equal(BACKEND_PROTOCOL_BASELINE_COMMIT);
    expect(policy.backend.releaseCommitRole).to.equal('reviewed_protocol_baseline_only');
    expect(policy.backend.runtimeRelease).to.deep.equal({
      sourceCommit: null,
      artifactManifestSha256: null,
      status: 'pending_final_immutable_backend_release',
    });
    expect(() =>
      validateStorkDeploymentSnapshot(
        {
          schemaVersion: 1,
          chainId: 16602,
          backendProtocolBaselineCommit: BACKEND_PROTOCOL_BASELINE_COMMIT,
          policySha256: '00'.repeat(32),
          capturedAtNs: '1722632569208762117',
          observationBlock: { number: 1, hash: `0x${'11'.repeat(32)}`, timestamp: 1722632569 },
          feeds: [],
        },
        {
          ...policy,
          backend: {
            ...policy.backend,
            runtimeRelease: {
              sourceCommit: BACKEND_PROTOCOL_BASELINE_COMMIT,
              artifactManifestSha256: 'ab'.repeat(32),
              status: 'reviewed_immutable_backend_release',
            },
          },
        },
        '00'.repeat(32)
      )
    ).to.throw('protocol baseline cannot be reused');
    expect(policy.verifier.maxAgeSeconds).to.equal(30);
    expect(policy.verifier.maxFutureSkewSeconds).to.equal(2);
    expect(policy.verifier.aggregatorPublicKey).to.equal('0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44');
    expect(policy.feeds.map((feed) => feed.feedId)).to.deep.equal(['BTCUSD', 'ETHUSD', 'SOLUSD', '0GUSD']);
    expect(policy.status).to.equal(APPROVED_STORK_DEPLOYMENT_POLICY_STATUS);
    expect(policy.coherence.maxSignedTimestampSpreadSeconds).to.equal(3);
    expect(policy.coherence.decisionOwner).to.equal('Red');
    expect(policy.coherence.decision).to.equal(APPROVED_STORK_COHERENCE_DECISION);
    expect(() =>
      validateStorkDeploymentSnapshot(
        {
          schemaVersion: 1,
          chainId: 16602,
          backendProtocolBaselineCommit: BACKEND_PROTOCOL_BASELINE_COMMIT,
          policySha256: '00'.repeat(32),
          capturedAtNs: '1722632569208762117',
          observationBlock: { number: 1, hash: `0x${'11'.repeat(32)}`, timestamp: 1722632569 },
          feeds: [],
        },
        { ...policy, coherence: { ...policy.coherence, decisionOwner: 'not-red' } },
        '00'.repeat(32)
      )
    ).to.throw('Red-only release decision');
    expect(() =>
      validateStorkDeploymentSnapshot(
        {
          schemaVersion: 1,
          chainId: 16602,
          backendProtocolBaselineCommit: BACKEND_PROTOCOL_BASELINE_COMMIT,
          policySha256: '00'.repeat(32),
          capturedAtNs: '1722632569208762117',
          observationBlock: { number: 1, hash: `0x${'11'.repeat(32)}`, timestamp: 1722632569 },
          feeds: [],
        },
        policy,
        '00'.repeat(32)
      )
    ).to.throw('Stork deployment snapshot must contain exactly four launch feeds');
  });

  it('bounds a reviewed cross-feed spread to the backend Stork max-age policy', () => {
    const { policy } = loadTrackedStorkDeploymentPolicy();
    const withSpread = (maxSignedTimestampSpreadSeconds: number) => ({
      ...policy,
      status: APPROVED_STORK_DEPLOYMENT_POLICY_STATUS,
      coherence: {
        ...policy.coherence,
        maxSignedTimestampSpreadSeconds,
        decision: APPROVED_STORK_COHERENCE_DECISION,
      },
    });

    for (const invalidSpread of [0, -1, policy.verifier.maxAgeSeconds + 1]) {
      expect(() => validateStorkDeploymentPolicy(withSpread(invalidSpread))).to.throw(
        'cross-feed signed timestamp spread must be null or a positive safe integer no greater than Stork max age'
      );
    }
    for (const validSpread of [1, policy.verifier.maxAgeSeconds]) {
      expect(() => validateStorkDeploymentPolicy(withSpread(validSpread))).not.to.throw();
    }
    expect(policy.coherence.maxSignedTimestampSpreadSeconds).to.equal(3);
  });

  it('pins exact blocked and approved Stork policy state pairs and rejects arbitrary or mixed states', () => {
    const { policy } = loadTrackedStorkDeploymentPolicy();
    const approved = {
      ...policy,
      status: APPROVED_STORK_DEPLOYMENT_POLICY_STATUS,
      coherence: {
        ...policy.coherence,
        maxSignedTimestampSpreadSeconds: 3,
        decision: APPROVED_STORK_COHERENCE_DECISION,
      },
    };
    const blocked = {
      ...policy,
      status: BLOCKED_STORK_DEPLOYMENT_POLICY_STATUS,
      coherence: {
        ...policy.coherence,
        maxSignedTimestampSpreadSeconds: null,
        decision: BLOCKED_STORK_COHERENCE_DECISION,
      },
    };

    expect(() => validateStorkDeploymentPolicy(blocked)).not.to.throw();
    expect(() => validateStorkDeploymentPolicy(approved)).not.to.throw();

    for (const candidate of [
      { ...approved, status: 'approved' },
      { ...approved, status: BLOCKED_STORK_DEPLOYMENT_POLICY_STATUS },
      { ...approved, coherence: { ...approved.coherence, decision: 'reviewed' } },
      { ...approved, coherence: { ...approved.coherence, decision: BLOCKED_STORK_COHERENCE_DECISION } },
    ]) {
      expect(() => validateStorkDeploymentPolicy(candidate)).to.throw(
        'reviewed cross-feed signed timestamp spread must use the exact approved Galileo testnet state'
      );
    }

    for (const candidate of [
      { ...blocked, status: APPROVED_STORK_DEPLOYMENT_POLICY_STATUS },
      { ...blocked, status: 'blocked' },
      { ...blocked, coherence: { ...blocked.coherence, decision: APPROVED_STORK_COHERENCE_DECISION } },
      { ...blocked, coherence: { ...blocked.coherence, decision: 'pending' } },
    ]) {
      expect(() => validateStorkDeploymentPolicy(candidate)).to.throw(
        'unset cross-feed signed timestamp spread must remain explicitly fail-closed pending Red'
      );
    }
  });

  it('accepts the official signed BTC proof byte-for-byte and rejects a tampered X18 price', () => {
    const { policy } = loadTrackedStorkDeploymentPolicy();
    const verified = verifyStorkSignedFeed(OFFICIAL_BTC_PROOF, policy.feeds[0], policy.verifier);
    expect(verified.priceX18).to.equal(OFFICIAL_BTC_PROOF.priceX18);
    expect(verified.signedTimestampNs).to.equal(OFFICIAL_BTC_PROOF.proof.signedTimestampNs);

    expect(() =>
      verifyStorkSignedFeed(
        { ...OFFICIAL_BTC_PROOF, priceX18: '62507457175499998000001' },
        policy.feeds[0],
        policy.verifier
      )
    ).to.throw('Stork message hash does not match the signed proof');
    expect(() =>
      verifyStorkSignedFeed({ ...OFFICIAL_BTC_PROOF, assetId: 'ETHUSD' }, policy.feeds[0], policy.verifier)
    ).to.throw('signed Stork feed identity mismatch');
  });

  it('preserves exact pinned collateral provenance and never treats the registry as runtime selection', () => {
    const { provenance } = loadTrackedCollateralProvenance();
    expect(provenance.collateral.address).to.equal(GALILEO_USDCE_ADDRESS);
    expect(provenance.collateral.decimals).to.equal(6);
    expect(provenance.collateral.productId).to.equal(0);
    expect(provenance.selection.mode).to.equal('static_pinned');
    expect(provenance.selection.runtimeRegistryLookup).to.equal(false);
    expect(provenance.selection.aliasSubstitutionAllowed).to.equal(false);
    expect(provenance.normalizedCarriedFieldTupleSha256).to.equal(
      'b385d558b2000cf9cba3db74746e855fddc546464e7c172b338b662823719f7a'
    );
    expect(provenance.sources.bondEnvironments.commit).to.equal('a54d8d3723beced7fc5838a83a63b4fb9070641d');
    expect(provenance.sources.bondEnvironments.tree).to.equal('b62d8dc7e029138073ff44b57a3f25e7d41b6013');
    expect(provenance.sources.bondEnvironments.fileSha256).to.equal(
      'e5deda5e8514919dfb8aa8da0266d7e37c453d23aec95316d28947e804ea08b6'
    );
    expect(provenance.sources.bondEnvironments.fileBlob).to.equal('82434072f7ef8a0687bcd352ac5fb7abe17e8171');
    expect(provenance.sources.bondEnvironments.perpdexFileSha256).to.equal(
      '61e152e8082c590ec8cf7f5778cd8903ff4842ea98235e94d5463b6d5184db53'
    );
    expect(provenance.sources.bondSuperApp.commit).to.equal('65ad0d7ac03423d700c16b17f63f793ec9a2aeab');
    expect(provenance.sources.bondSuperApp.fileSha256).to.equal(
      '9f4653bdee06f1a6789b6ccda91df6e177ea4acbf26eaf7c3bc3dd718d49084a'
    );
    expect(provenance.sources.bondSuperApp.fileBlob).to.equal('a1d23eeb3c7e55d48656262616210fe395f500a3');
  });

  it('removes static deploy-time prices and resolves all four products from exact verified snapshot values', () => {
    const productsFile = path.resolve(__dirname, '..', 'config', 'galileo.products.json');
    const raw = fs.readFileSync(productsFile, 'utf8');
    expect(raw).not.to.contain('priceX18');
    const products = loadProducts(productsFile);
    const prices = new Map(
      products.products.map((product, index) => [product.productId, `${index + 1}000000000000000000`])
    );
    const resolved = resolveProductsWithStorkPrices(products, prices);
    expect(resolved.products.map((product) => product.risk.priceX18)).to.deep.equal([...prices.values()]);
    expect(resolved.products.map((product) => product.minSizeX18)).to.deep.equal(
      products.products.map((product) => product.minSizeX18)
    );
  });

  it('keeps the reviewed protocol-baseline sizing and 20x vectors while making price approval snapshot-based', () => {
    const result = validateProductApprovalReview();
    expect(result.ready).to.equal(true);
    expect(result.blockers).to.deep.equal([]);
    expect(result.backendProtocolBaselineCommit).to.equal(BACKEND_PROTOCOL_BASELINE_COMMIT);
    expect(result).not.to.have.property('backendBetaCommit');
    expect(
      result.marketVectors.map((market) => [
        market.symbol,
        market.contractSizeIncrementX18,
        market.contractMinimumSizeX18,
      ])
    ).to.deep.equal([
      ['BTCUSDCPERP', '1000000000000000', '1000000000000000'],
      ['ETHUSDCPERP', '1000000000000000', '10000000000000000'],
      ['SOLUSDCPERP', '10000000000000000', '100000000000000000'],
      ['0GUSDCPERP', '1000000000000000000', '10000000000000000000'],
    ]);
    expect(
      result.marketVectors.every((market) => market.initialPriceSource === 'verified_stork_deployment_snapshot')
    ).to.equal(true);
    const review = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'config', 'galileo.product-approval-review.json'), 'utf8')
    );
    expect(review.contractSource.releaseCommit).to.equal(GALILEO_CONTRACT_PACKET_BASE_COMMIT);
    expect(review.contractSource.releaseTree).to.equal(GALILEO_CONTRACT_PACKET_BASE_TREE);
    expect(review.initialPricePolicy.graphPreparationRequiresSnapshot).to.equal(false);
    expect(review.initialPricePolicy.snapshotRequiredBeforeFirstPriceBearingTransaction).to.equal(true);
    expect(review.initialPricePolicy).not.to.have.property('snapshotRequiredBeforeFirstTransaction');
  });

  it('rejects stale and future-dated signed evidence independently of signature validity', () => {
    const { policy } = loadTrackedStorkDeploymentPolicy();
    const snapshot = {
      feeds: [
        { signedTimestampNs: '100000000000' },
        { signedTimestampNs: '100000000000' },
        { signedTimestampNs: '100000000000' },
        { signedTimestampNs: '100000000000' },
      ],
    } as never;
    expect(() => assertStorkDeploymentSnapshotFresh(snapshot, policy, 131_000_000_001n)).to.throw('stale');
    expect(() => assertStorkDeploymentSnapshotFresh(snapshot, policy, 97_999_999_999n)).to.throw('future skew');
    const observationFixture = (capturedAtNs: string, timestamp: number) =>
      ({
        capturedAtNs,
        observationBlock: { number: 1, hash: `0x${'11'.repeat(32)}`, timestamp },
      } as never);
    expect(() => assertStorkSnapshotObservationTime(observationFixture('100000000000', 102), policy)).not.to.throw();
    expect(() => assertStorkSnapshotObservationTime(observationFixture('100000000000', 103), policy)).to.throw(
      'future skew'
    );
    expect(() => assertStorkSnapshotObservationTime(observationFixture('100000000000', 70), policy)).not.to.throw();
    expect(() => assertStorkSnapshotObservationTime(observationFixture('100000000001', 70), policy)).to.throw(
      'too old'
    );
  });
});
