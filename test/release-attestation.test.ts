import { expect } from 'chai';
import { artifacts } from 'hardhat';
import { constants, Wallet } from 'ethers';
import {
  assertDeploymentIntentAvailableForFirstTransaction,
  assertIndependentReleaseReviewer,
  assertManifestOperatorsMatchSignedIntent,
  assertSameVerifiedReleaseEvidence,
  createGalileoDeploymentIntent,
  createReleaseAttestationPayload,
  executeAfterVerifiedPreflight,
  GalileoReleasePolicy,
  RELEASE_ATTESTATION_SCHEMA_VERSION,
  RELEASE_ATTESTATION_TYPES,
  releaseAttestationDomain,
  SignedReleaseAttestation,
  validateReleasePolicy,
  verifySignedReleaseAttestation,
  VerifiedReleaseEvidence,
  writeAfterVerifiedPostflight,
} from '../scripts/release-attestation';
import {
  assertArtifactMatchesBuildInfo,
  RELEASE_ARTIFACTS,
  reproduceApplicationBuildInfo,
  SolcBuildInfoShape,
} from '../scripts/release-evidence';

const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const HASH_C = '33'.repeat(32);
const HASH_D = '44'.repeat(32);
const COMMIT = 'aa'.repeat(20);
const TREE = 'bb'.repeat(20);

async function expectFailure(promise: Promise<unknown>, expectedMessage: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.contain(expectedMessage);
}

function fixturePolicy(reviewer: Wallet): GalileoReleasePolicy {
  return validateReleasePolicy({
    schemaVersion: 1,
    policyId: 'fixture-galileo-release',
    policyVersion: 7,
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
    requiredReviewerSignatures: 1,
    reviewers: [{ name: 'Fixture Reviewer', address: reviewer.address }],
    status: 'approved_for_galileo_testnet_release',
  });
}

function fixturePayload(policy: GalileoReleasePolicy) {
  const deployer = Wallet.createRandom();
  const sequencer = Wallet.createRandom();
  const deploymentIntent = createGalileoDeploymentIntent({
    deploymentNonce: 9,
    expiresAt: 2_000_000_000,
    deployer: deployer.address,
    sequencer: sequencer.address,
    firstTransactionNonce: 17,
  });
  return createReleaseAttestationPayload({
    policy,
    policySha256: HASH_A,
    source: { releaseCommit: COMMIT, sourceTree: TREE },
    buildEvidenceSha256: HASH_B,
    productConfigSha256: HASH_C,
    verifierConfigSha256: HASH_D,
    verifierConfig: {
      chainId: 16602,
      signerBitmask: 7,
      keys: [
        { x: '1', y: '2' },
        { x: '3', y: '4' },
        { x: '5', y: '6' },
      ],
    },
    deploymentIntent,
  });
}

async function signedFixture(reviewer: Wallet) {
  const policy = fixturePolicy(reviewer);
  const payload = fixturePayload(policy);
  const signature = await reviewer._signTypedData(releaseAttestationDomain(policy), RELEASE_ATTESTATION_TYPES, payload);
  return {
    policy,
    payload,
    attestation: {
      schemaVersion: RELEASE_ATTESTATION_SCHEMA_VERSION,
      payload,
      signature,
    } as SignedReleaseAttestation,
  };
}

describe('signed Galileo release attestation', () => {
  it('accepts an allowlisted reviewer signature and rejects blocked, unsigned, forged, unallowlisted, and stale attestations', async () => {
    const reviewer = Wallet.createRandom();
    const outsider = Wallet.createRandom();
    const { policy, payload, attestation } = await signedFixture(reviewer);

    const verified = verifySignedReleaseAttestation(policy, payload, attestation);
    expect(verified.reviewer.address).to.equal(reviewer.address);

    expect(() => verifySignedReleaseAttestation(policy, payload, { ...attestation, signature: '0x' })).to.throw(
      'unsigned or has an invalid signature'
    );

    const outsiderSignature = await outsider._signTypedData(
      releaseAttestationDomain(policy),
      RELEASE_ATTESTATION_TYPES,
      payload
    );
    expect(() =>
      verifySignedReleaseAttestation(policy, payload, { ...attestation, signature: outsiderSignature })
    ).to.throw('is not allowlisted');

    const forgedPayload = { ...payload, sourceTree: 'cc'.repeat(20) };
    const forgedSignature = await reviewer._signTypedData(
      releaseAttestationDomain(policy),
      RELEASE_ATTESTATION_TYPES,
      forgedPayload
    );
    expect(() =>
      verifySignedReleaseAttestation(policy, payload, { ...attestation, signature: forgedSignature })
    ).to.throw('is not allowlisted');

    expect(() =>
      verifySignedReleaseAttestation(policy, { ...payload, releaseCommit: 'dd'.repeat(20) }, attestation)
    ).to.throw('payload is stale');

    const noReviewerPolicy = { ...policy, reviewers: [] };
    expect(() => verifySignedReleaseAttestation(noReviewerPolicy, payload, attestation)).to.throw(
      'no named allowlisted reviewer address'
    );
    expect(() =>
      verifySignedReleaseAttestation({ ...policy, status: 'blocked_pending_review' }, payload, attestation)
    ).to.throw('release policy status is not active');
  });

  it('fails before any transaction callback and suppresses manifest writes after provenance drift', async () => {
    let transactionCalls = 0;
    await expectFailure(
      executeAfterVerifiedPreflight(
        async () => {
          throw new Error('forged preflight attestation');
        },
        async () => {
          transactionCalls += 1;
        }
      ),
      'forged preflight attestation'
    );
    expect(transactionCalls).to.equal(0);

    let manifestWrites = 0;
    await expectFailure(
      writeAfterVerifiedPostflight(
        async () => {
          throw new Error('reviewed source tree drift');
        },
        async () => {
          manifestWrites += 1;
        }
      ),
      'reviewed source tree drift'
    );
    expect(manifestWrites).to.equal(0);

    const evidence = {
      attestationDigest: `0x${HASH_A}`,
      attestation: { signature: `0x${'11'.repeat(65)}` },
      reviewer: { address: Wallet.createRandom().address },
      source: { releaseCommit: COMMIT, sourceTree: TREE },
      policySha256: HASH_A,
      buildEvidenceSha256: HASH_B,
      productConfigSha256: HASH_C,
      verifierConfigSha256: HASH_D,
      deploymentIntent: createGalileoDeploymentIntent({
        deploymentNonce: 9,
        expiresAt: 2_000_000_000,
        deployer: Wallet.createRandom().address,
        sequencer: Wallet.createRandom().address,
        firstTransactionNonce: 17,
      }),
    } as unknown as VerifiedReleaseEvidence;
    expect(() =>
      assertSameVerifiedReleaseEvidence(evidence, {
        ...evidence,
        source: { ...evidence.source, sourceTree: 'ee'.repeat(20) },
      })
    ).to.throw('post-deploy provenance drift: source tree changed');
  });

  it('requires the signed reviewer to be independent from deployment operators', () => {
    const reviewer = Wallet.createRandom().address;
    const deployer = Wallet.createRandom().address;
    const sequencer = Wallet.createRandom().address;
    expect(() => assertIndependentReleaseReviewer(reviewer, deployer, sequencer)).not.to.throw();
    expect(() => assertIndependentReleaseReviewer(deployer, deployer, sequencer)).to.throw(
      'independent from the deployer'
    );
    expect(() => assertIndependentReleaseReviewer(sequencer, deployer, sequencer)).to.throw(
      'independent from the sequencer'
    );
  });

  it('binds a single-use deployment nonce, expiry, deployer, sequencer, and expected first contract', async () => {
    const reviewer = Wallet.createRandom();
    const { policy, payload, attestation } = await signedFixture(reviewer);
    const deploymentIntent = createGalileoDeploymentIntent({
      deploymentNonce: payload.deploymentNonce,
      expiresAt: payload.expiresAt,
      deployer: payload.deployer,
      sequencer: payload.sequencer,
      firstTransactionNonce: payload.firstTransactionNonce,
    });

    // Signature verification remains repeatable for postflight and standalone historical verification.
    expect(verifySignedReleaseAttestation(policy, payload, attestation).attestationDigest).to.equal(
      verifySignedReleaseAttestation(policy, payload, attestation).attestationDigest
    );
    expect(() =>
      assertDeploymentIntentAvailableForFirstTransaction(deploymentIntent, {
        deployer: deploymentIntent.deployer,
        sequencer: deploymentIntent.sequencer,
        pendingNonce: deploymentIntent.firstTransactionNonce,
        chainTimestamp: deploymentIntent.expiresAt - 1,
        expectedFirstContractCode: '0x',
      })
    ).not.to.throw();
    expect(() =>
      assertDeploymentIntentAvailableForFirstTransaction(deploymentIntent, {
        deployer: deploymentIntent.deployer,
        sequencer: deploymentIntent.sequencer,
        pendingNonce: deploymentIntent.firstTransactionNonce + 1,
        chainTimestamp: deploymentIntent.expiresAt - 1,
        expectedFirstContractCode: '0x',
      })
    ).to.throw('stale or already consumed');
    expect(() =>
      assertDeploymentIntentAvailableForFirstTransaction(deploymentIntent, {
        deployer: deploymentIntent.deployer,
        sequencer: deploymentIntent.sequencer,
        pendingNonce: deploymentIntent.firstTransactionNonce,
        chainTimestamp: deploymentIntent.expiresAt,
        expectedFirstContractCode: '0x',
      })
    ).to.throw('expired');
    expect(() =>
      assertDeploymentIntentAvailableForFirstTransaction(deploymentIntent, {
        deployer: deploymentIntent.deployer,
        sequencer: deploymentIntent.sequencer,
        pendingNonce: deploymentIntent.firstTransactionNonce,
        chainTimestamp: deploymentIntent.expiresAt - 1,
        expectedFirstContractCode: '0x01',
      })
    ).to.throw('already consumed');
  });

  it('rejects zero-address operators and rechecks reviewer independence during standalone verification', () => {
    expect(() =>
      createGalileoDeploymentIntent({
        deploymentNonce: 1,
        expiresAt: 2_000_000_000,
        deployer: Wallet.createRandom().address,
        sequencer: constants.AddressZero,
        firstTransactionNonce: 0,
      })
    ).to.throw('sequencer must not be the zero address');

    const reviewer = Wallet.createRandom();
    const intent = createGalileoDeploymentIntent({
      deploymentNonce: 1,
      expiresAt: 2_000_000_000,
      deployer: reviewer.address,
      sequencer: Wallet.createRandom().address,
      firstTransactionNonce: 0,
    });
    const evidence = {
      reviewer: { name: 'Reviewer', address: reviewer.address },
      deploymentIntent: intent,
    } as unknown as VerifiedReleaseEvidence;
    expect(() =>
      assertManifestOperatorsMatchSignedIntent(evidence, {
        deployer: intent.deployer,
        sequencer: intent.sequencer,
      })
    ).to.throw('independent from the deployer');
  });

  it('rejects paired artifact/build-info, compiler, source, and settings tampering by deterministic recompilation', async () => {
    const fullyQualifiedName = RELEASE_ARTIFACTS.endpoint;
    const artifact = await artifacts.readArtifact(fullyQualifiedName);
    const original = (await artifacts.getBuildInfo(fullyQualifiedName)) as SolcBuildInfoShape;
    if (!original?.output) throw new Error('fixture build-info missing');
    expect(() => reproduceApplicationBuildInfo(original)).not.to.throw();

    const pairedTamper = JSON.parse(JSON.stringify(original)) as SolcBuildInfoShape;
    if (!pairedTamper.output) throw new Error('paired-tamper build-info missing output');
    const pairedOutput = pairedTamper.output.contracts[artifact.sourceName][artifact.contractName];
    const firstByte = artifact.bytecode.slice(2, 4);
    const replacement = firstByte === '00' ? '01' : '00';
    const tamperedArtifact = { ...artifact, bytecode: `0x${replacement}${artifact.bytecode.slice(4)}` };
    pairedOutput.evm.bytecode.object = `${replacement}${pairedOutput.evm.bytecode.object.slice(2)}`;
    expect(() => assertArtifactMatchesBuildInfo(tamperedArtifact, pairedOutput, fullyQualifiedName)).not.to.throw();
    expect(() => reproduceApplicationBuildInfo(pairedTamper)).to.throw(
      'does not match deterministic solc 0.8.13 reproduction'
    );

    const compilerTamper = { ...original, solcVersion: '0.8.12' };
    expect(() => reproduceApplicationBuildInfo(compilerTamper)).to.throw('must use exact solc 0.8.13');

    const sourceTamper = JSON.parse(JSON.stringify(original)) as SolcBuildInfoShape;
    sourceTamper.input.sources['contracts/Endpoint.sol'].content += '\n// tampered';
    expect(() => reproduceApplicationBuildInfo(sourceTamper)).to.throw(
      'does not match deterministic solc 0.8.13 reproduction'
    );

    const settingsTamper = JSON.parse(JSON.stringify(original)) as SolcBuildInfoShape;
    (settingsTamper.input.settings.optimizer as { runs: number }).runs += 1;
    expect(() => reproduceApplicationBuildInfo(settingsTamper)).to.throw(
      'does not match deterministic solc 0.8.13 reproduction'
    );
  });
});
