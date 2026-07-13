import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import {
  assertCanonicalGalileoProductPrefix,
  assertProductionFinalizationEntryState,
  assertSingleAddProductEvent,
  commitAcceptedManifestExclusive,
  deterministicSha256,
  ensureLocalReleaseStateHostIdentity,
  FinalizationJournal,
  FinalizationRunInput,
  FinalizationStepPlan,
  GALILEO_FINALIZATION_GAS_LIMIT,
  loadAndValidateFinalizationJournal,
  portableArtifactReference,
  reserveFinalizationJournal,
  resolvePortableArtifactReference,
  runDurableFinalization,
} from '../scripts/galileo-finalization-journal';

const DEPLOYER = '0x0000000000000000000000000000000000000001';
const ENDPOINT = '0x0000000000000000000000000000000000000002';
const PERP_ENGINE = '0x0000000000000000000000000000000000000003';

function plans(startingNonce = 7): FinalizationStepPlan[] {
  return [
    {
      id: 'endpoint.initialize',
      kind: 'endpoint_initialize',
      from: DEPLOYER,
      to: ENDPOINT,
      nonce: startingNonce,
      value: '0',
      calldata: '0x12345678' + '00'.repeat(32),
      selector: '0x12345678',
      argsSha256: deterministicSha256({ prices: ['1', '2', '3', '4'] }),
    },
    ...[2, 4, 6, 8].map((productId, index) => ({
      id: `perp.addProduct.${productId}`,
      kind: 'perp_add_product' as const,
      symbol: ['BTCUSDCPERP', 'ETHUSDCPERP', 'SOLUSDCPERP', '0GUSDCPERP'][index],
      productId,
      from: DEPLOYER,
      to: PERP_ENGINE,
      nonce: startingNonce + index + 1,
      value: '0' as const,
      calldata: `0x87654321${productId.toString(16).padStart(64, '0')}`,
      selector: '0x87654321',
      argsSha256: deterministicSha256({ productId }),
    })),
  ];
}

class FakeChain {
  latestNonce = 7;
  pendingNonce = 7;
  latestBlock = 100;
  sendCount = 0;
  estimationAttemptCount = 0;
  blockScanCount = 0;
  sentNonces: number[] = [];
  sentRequests: providers.TransactionRequest[] = [];
  sendDelayMs = 0;
  holdLatestNonceOnSend = false;
  firstReceiptReadAfterSendCount: number | undefined;
  revertNext = false;
  blockGasLimit = BigNumber.from(30_000_000);
  transactions = new Map<string, providers.TransactionResponse>();
  receipts = new Map<string, providers.TransactionReceipt>();
  blocks = new Map<number, providers.BlockWithTransactions>();

  constructor() {
    this.blocks.set(100, this.block(100, []));
  }

  private block(number: number, transactions: providers.TransactionResponse[]): providers.BlockWithTransactions {
    const hash = utils.keccak256(utils.defaultAbiCoder.encode(['uint256'], [number]));
    return {
      number,
      hash,
      parentHash: utils.hexZeroPad('0x01', 32),
      timestamp: 1_000 + number,
      nonce: '0x0000000000000000',
      difficulty: 0,
      gasLimit: this.blockGasLimit,
      gasUsed: BigNumber.from(0),
      miner: DEPLOYER,
      extraData: '0x',
      transactions,
      _difficulty: BigNumber.from(0),
      baseFeePerGas: BigNumber.from(1),
    } as providers.BlockWithTransactions;
  }

  async sendTransaction(request: providers.TransactionRequest): Promise<providers.TransactionResponse> {
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    if (request.gasLimit === undefined || request.gasLimit === null) {
      this.estimationAttemptCount += 1;
      throw new Error('gas estimation would evaluate a later nonce against pre-finalization state');
    }
    this.sendCount += 1;
    this.sentRequests.push(request);
    const nonce = Number(request.nonce);
    this.sentNonces.push(nonce);
    const hash = utils.keccak256(
      utils.defaultAbiCoder.encode(['uint256', 'bytes', 'uint256'], [nonce, request.data, this.sendCount])
    );
    const transaction = {
      hash,
      confirmations: 1,
      from: DEPLOYER,
      to: request.to as string,
      nonce,
      gasLimit: BigNumber.from(request.gasLimit),
      gasPrice: BigNumber.from(1),
      data: request.data as string,
      value: BigNumber.from(0),
      chainId: 16602,
      wait: async () => this.receipts.get(hash)!,
    } as providers.TransactionResponse;
    this.latestBlock += 1;
    const block = this.block(this.latestBlock, [transaction]);
    const receipt = {
      to: transaction.to,
      from: transaction.from,
      contractAddress: null,
      transactionIndex: 0,
      gasUsed: BigNumber.from(1),
      logsBloom: `0x${'00'.repeat(256)}`,
      blockHash: block.hash,
      transactionHash: hash,
      logs: [],
      blockNumber: block.number,
      confirmations: 1,
      cumulativeGasUsed: BigNumber.from(1),
      effectiveGasPrice: BigNumber.from(1),
      byzantium: true,
      type: 2,
      status: this.revertNext ? 0 : 1,
    } as providers.TransactionReceipt;
    this.revertNext = false;
    this.transactions.set(hash, transaction);
    this.receipts.set(hash, receipt);
    this.blocks.set(block.number, block);
    if (!this.holdLatestNonceOnSend) this.latestNonce = nonce + 1;
    this.pendingNonce = nonce + 1;
    return transaction;
  }

  provider() {
    return {
      getBlockNumber: async () => {
        if (!this.blocks.has(this.latestBlock)) {
          this.blocks.set(this.latestBlock, this.block(this.latestBlock, []));
        }
        return this.latestBlock;
      },
      getBlockWithTransactions: async (number: number) => {
        this.blockScanCount += 1;
        return this.blocks.get(number)!;
      },
      getTransaction: async (hash: string) => this.transactions.get(hash) || null,
      getTransactionReceipt: async (hash: string) => {
        this.firstReceiptReadAfterSendCount ??= this.sendCount;
        return this.receipts.get(hash) || null;
      },
      getTransactionCount: async (_address: string, tag: string) =>
        tag === 'pending' ? this.pendingNonce : this.latestNonce,
      getBlock: async (number: number) => this.blocks.get(number) || null,
      waitForTransaction: async (hash: string, confirmations = 1) => {
        const receipt = this.receipts.get(hash);
        if (!receipt) return null;
        while (this.latestBlock - receipt.blockNumber + 1 < confirmations) {
          this.latestBlock += 1;
          this.blocks.set(this.latestBlock, this.block(this.latestBlock, []));
        }
        return receipt;
      },
    } as unknown as FinalizationRunInput['provider'];
  }
}

describe('durable Galileo finalization journal', () => {
  let root: string;
  let journalFile: string;
  let manifestFile: string;
  let stableStateRoot: string;
  let chain: FakeChain;
  let expected: FinalizationRunInput['expected'];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'galileo-finalization-'));
    journalFile = path.join(root, 'finalization.json');
    manifestFile = path.join(root, 'manifest.json');
    stableStateRoot = path.join(root, 'stable-release-state');
    chain = new FakeChain();
    expected = {
      schemaVersion: 1,
      release: 'test-release',
      chainId: 16602,
      preparedFileSha256: '11'.repeat(32),
      snapshotSha256: '22'.repeat(32),
      manifestReference: portableArtifactReference(journalFile, manifestFile),
      deployer: DEPLOYER,
      startingNonce: 7,
      scanFromBlock: 100,
      preparationBoundaryBlockHash: utils.keccak256(utils.toUtf8Bytes(root)),
      releaseStateHostIdentity: ensureLocalReleaseStateHostIdentity({ testOnlyLockRoot: stableStateRoot }),
      leaseScope: 'single_host_local_eoa_no_cross_host',
      finalityConfirmations: 12,
      steps: plans(),
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (overrides: Partial<FinalizationRunInput> = {}) =>
    runDurableFinalization({
      journalFile,
      manifestFile,
      expected,
      provider: chain.provider(),
      signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
      assertFreshBeforeBroadcast: () => undefined,
      verifyConfirmedStep: async () => undefined,
      testOnlyLockRoot: stableStateRoot,
      ...overrides,
    });
  const runtimeValidation = () => ({ testOnlyLockRoot: stableStateRoot, requireRuntimeOwnership: true });
  const acceptedRecordFile = () =>
    path.join(stableStateRoot, fs.readdirSync(stableStateRoot).find((file) => file.endsWith('.accepted.json'))!);
  const sha256 = (file: string) => utils.sha256(fs.readFileSync(file)).slice(2);
  const rotateBoundary = () => {
    expected = { ...expected, preparationBoundaryBlockHash: utils.hexlify(utils.randomBytes(32)) };
  };

  it('durably broadcasts all five gap-free nonces before the first receipt read or verification', async () => {
    const verified: string[] = [];
    const freshnessChecks: string[] = [];
    chain.holdLatestNonceOnSend = true;
    const journal = await run({
      assertFreshBeforeBroadcast: (step) => {
        expect(chain.firstReceiptReadAfterSendCount).to.equal(undefined);
        freshnessChecks.push(step.id);
      },
      verifyConfirmedStep: async (step) => {
        if (!verified.includes(step.id)) {
          expect(chain.sendCount).to.equal(5);
          verified.push(step.id);
        }
      },
    });
    expect(journal.status).to.equal('complete');
    expect(journal.steps.every((step) => step.state === 'finalized')).to.equal(true);
    expect(journal.steps.every((step) => step.finality!.confirmationsObserved >= 12)).to.equal(true);
    expect(journal.steps.map((step) => step.nonce)).to.deep.equal([7, 8, 9, 10, 11]);
    expect(freshnessChecks).to.deep.equal(expected.steps.map((step) => step.id));
    expect(verified).to.deep.equal(expected.steps.map((step) => step.id));
    expect(chain.sendCount).to.equal(5);
    expect(chain.firstReceiptReadAfterSendCount).to.equal(5);
    expect(fs.statSync(journalFile).mode & 0o777).to.equal(0o600);
  });

  it('broadcasts the exact five-step packet with a fixed gas limit and no estimation dependency', async () => {
    chain.holdLatestNonceOnSend = true;

    const journal = await run();

    expect(journal.status).to.equal('complete');
    expect(chain.estimationAttemptCount).to.equal(0);
    expect(chain.sentRequests).to.have.length(expected.steps.length);
    for (const [index, request] of chain.sentRequests.entries()) {
      const step = expected.steps[index];
      expect(Object.keys(request).sort()).to.deep.equal(['data', 'from', 'gasLimit', 'nonce', 'to', 'value']);
      expect(utils.getAddress(request.from as string)).to.equal(utils.getAddress(step.from));
      expect(utils.getAddress(request.to as string)).to.equal(utils.getAddress(step.to));
      expect(Number(request.nonce)).to.equal(step.nonce);
      expect(BigNumber.from(request.value)).to.equal(BigNumber.from(step.value));
      expect(request.data).to.equal(step.calldata);
      expect(BigNumber.from(request.gasLimit).toNumber()).to.equal(GALILEO_FINALIZATION_GAS_LIMIT);
    }
    expect(
      journal.steps.map(({ id, kind, symbol, productId, from, to, nonce, value, calldata, selector, argsSha256 }) => ({
        id,
        kind,
        ...(symbol === undefined ? {} : { symbol }),
        ...(productId === undefined ? {} : { productId }),
        from,
        to,
        nonce,
        value,
        calldata,
        selector,
        argsSha256,
      }))
    ).to.deep.equal(expected.steps);
  });

  it('fails before broadcasting when the fixed gas limit does not fit the live block', async () => {
    chain.blockGasLimit = BigNumber.from(GALILEO_FINALIZATION_GAS_LIMIT - 1);
    chain.blocks.set(100, { ...chain.blocks.get(100)!, gasLimit: chain.blockGasLimit });

    await expect(run()).to.be.rejectedWith(
      `Galileo finalization gas limit ${GALILEO_FINALIZATION_GAS_LIMIT} exceeds live block gas limit`
    );
    expect(chain.sendCount).to.equal(0);
    expect(chain.estimationAttemptCount).to.equal(0);
  });

  it('uses exact pristine account nonces without aging the signed packet through an obsolete history scan', async () => {
    chain.latestBlock = 700;

    const journal = await run();

    expect(journal.status).to.equal('complete');
    expect(chain.sendCount).to.equal(5);
    expect(chain.blockScanCount).to.equal(0);
  });

  it('retains the 512-block fail-closed scan for a prior broadcast boundary', async () => {
    await expect(
      run({
        testOnlyAfterIntentBeforeSend: () => {
          throw new Error('injected stop after durable broadcast intent');
        },
      })
    ).to.be.rejectedWith('injected stop after durable broadcast intent');
    expect(chain.sendCount).to.equal(0);

    chain.latestBlock = 613;
    await expect(run()).to.be.rejectedWith(
      'finalization nonce reconciliation exceeds the 512-block fail-closed scan window'
    );
    expect(chain.sendCount).to.equal(0);
  });

  it('recovers a crash after send but before hash persistence without broadcasting the economic step twice', async () => {
    let crashed = false;
    let error: unknown;
    try {
      await run({
        testOnlyAfterSendBeforePersist: () => {
          if (!crashed) {
            crashed = true;
            throw new Error('injected crash');
          }
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.equal('injected crash');
    expect(chain.sendCount).to.equal(1);
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8')).steps[0].state).to.equal('broadcast_intent');
    const recovered = await run();
    expect(recovered.status).to.equal('complete');
    expect(chain.sendCount).to.equal(5);
    expect(recovered.steps[0].attemptHashes).to.have.length(1);
  });

  it('uses the production entry gate to recover Endpoint.initialize after send before persistence', async () => {
    await expect(
      run({
        testOnlyAfterSendBeforePersist: (step) => {
          if (step.kind === 'endpoint_initialize') throw new Error('restart after Endpoint.initialize send');
        },
      })
    ).to.be.rejectedWith('restart after Endpoint.initialize send');
    expect(chain.sendCount).to.equal(1);
    expect(
      assertProductionFinalizationEntryState({
        journalFile,
        endpointOwner: DEPLOYER,
        endpointSequencer: DEPLOYER,
        expectedOwner: DEPLOYER,
        expectedSequencer: DEPLOYER,
        productIds: [],
      })
    ).to.equal('recovery');
    expect(() =>
      assertProductionFinalizationEntryState({
        journalFile: path.join(root, 'missing-finalization.json'),
        endpointOwner: DEPLOYER,
        endpointSequencer: DEPLOYER,
        expectedOwner: DEPLOYER,
        expectedSequencer: DEPLOYER,
        productIds: [],
      })
    ).to.throw('prepared graph was already finalized');

    const recovered = await run();
    expect(recovered.status).to.equal('complete');
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);
    expect(chain.sendCount).to.equal(5);
  });

  it('recovers a later mined prefix and accepts only a canonical prefix containing each verified step', async () => {
    const visibleProductIds: number[] = [];
    let injected = false;
    const observeSend = (step: FinalizationStepPlan) => {
      if (step.productId !== undefined && !visibleProductIds.includes(step.productId)) {
        visibleProductIds.push(step.productId);
      }
      if (step.productId === 4 && !injected) {
        injected = true;
        throw new Error('restart after product 4 send');
      }
    };
    const verifyPrefix = async (step: FinalizationStepPlan) => {
      if (step.productId !== undefined) {
        assertCanonicalGalileoProductPrefix(visibleProductIds, step.productId, step.symbol!);
      }
    };

    await expect(
      run({ testOnlyAfterSendBeforePersist: observeSend, verifyConfirmedStep: verifyPrefix })
    ).to.be.rejectedWith('restart after product 4 send');
    expect(visibleProductIds).to.deep.equal([2, 4]);
    expect(chain.sendCount).to.equal(3);
    expect(
      assertProductionFinalizationEntryState({
        journalFile,
        endpointOwner: DEPLOYER,
        endpointSequencer: DEPLOYER,
        expectedOwner: DEPLOYER,
        expectedSequencer: DEPLOYER,
        productIds: visibleProductIds,
      })
    ).to.equal('recovery');

    const recovered = await run({
      testOnlyAfterSendBeforePersist: observeSend,
      verifyConfirmedStep: verifyPrefix,
    });
    expect(recovered.status).to.equal('complete');
    expect(visibleProductIds).to.deep.equal([2, 4, 6, 8]);
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);

    for (const invalid of [[2], [4], [2, 6], [2, 4, 4], [2, 4, 6, 8, 10]]) {
      expect(() => assertCanonicalGalileoProductPrefix(invalid, 4, 'ETHUSDCPERP')).to.throw(
        'not a canonical launch prefix containing the verified step'
      );
    }
    expect(() => assertCanonicalGalileoProductPrefix([2, 4], 6, 'SOLUSDCPERP')).to.throw(
      'not a canonical launch prefix containing the verified step'
    );
    expect(() => assertCanonicalGalileoProductPrefix([2, 4], 4, 'ETHUSDCPERP')).not.to.throw();
  });

  it('fails recovery entry closed on wrong or incoherent owners and noncanonical product sets', () => {
    fs.writeFileSync(journalFile, '{}\n', { mode: 0o600, flag: 'wx' });
    const entry = (overrides: Partial<Parameters<typeof assertProductionFinalizationEntryState>[0]> = {}) =>
      assertProductionFinalizationEntryState({
        journalFile,
        endpointOwner: DEPLOYER,
        endpointSequencer: DEPLOYER,
        expectedOwner: DEPLOYER,
        expectedSequencer: DEPLOYER,
        productIds: [2, 4],
        ...overrides,
      });
    expect(entry()).to.equal('recovery');
    expect(entry({ productIds: [] })).to.equal('recovery');
    expect(
      entry({
        endpointOwner: '0x0000000000000000000000000000000000000000',
        endpointSequencer: '0x0000000000000000000000000000000000000000',
        productIds: [],
      })
    ).to.equal('recovery');
    for (const overrides of [
      { endpointOwner: ENDPOINT },
      { endpointSequencer: ENDPOINT },
      { endpointOwner: '0x0000000000000000000000000000000000000000' },
      { endpointSequencer: '0x0000000000000000000000000000000000000000' },
      { productIds: [4] },
      { productIds: [2, 6] },
      { productIds: [2, 4, 4] },
      { productIds: [2, 4, 6, 8, 10] },
    ]) {
      expect(() => entry(overrides)).to.throw(
        'journal recovery graph owner/sequencer/products do not match one canonical finalization prefix'
      );
    }
  });

  it('lets recovery enter read-only but fails closed before rebroadcast when ownership is missing', async () => {
    await expect(
      run({
        testOnlyAfterSendBeforePersist: (step) => {
          if (step.kind === 'endpoint_initialize') throw new Error('restart before ownership loss');
        },
      })
    ).to.be.rejectedWith('restart before ownership loss');
    expect(
      assertProductionFinalizationEntryState({
        journalFile,
        endpointOwner: DEPLOYER,
        endpointSequencer: DEPLOYER,
        expectedOwner: DEPLOYER,
        expectedSequencer: DEPLOYER,
        productIds: [],
      })
    ).to.equal('recovery');
    const ownershipFile = path.join(
      stableStateRoot,
      fs.readdirSync(stableStateRoot).find((file) => file.endsWith('.broadcast.json'))!
    );
    fs.rmSync(ownershipFile);
    await expect(run()).to.be.rejectedWith('broadcast ownership tombstone hash mismatch');
    expect(chain.sendCount).to.equal(1);
  });

  it('never rebroadcasts after a durable intent if the exact transaction cannot be reconciled', async () => {
    let error: unknown;
    try {
      await run({
        testOnlyAfterIntentBeforeSend: () => {
          throw new Error('crash after intent');
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.equal('crash after intent');
    expect(chain.sendCount).to.equal(0);
    await expect(run()).to.be.rejectedWith('rebroadcast is forbidden');
    expect(chain.sendCount).to.equal(0);

    fs.rmSync(journalFile);
    rotateBoundary();
    chain = new FakeChain();
    try {
      await run({
        testOnlyAfterSendBeforePersist: () => {
          throw new Error('crash after hidden send');
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.equal('crash after hidden send');
    chain.transactions.clear();
    chain.receipts.clear();
    for (const blockNumber of [...chain.blocks.keys()]) {
      if (blockNumber > 100) chain.blocks.delete(blockNumber);
    }
    chain.latestBlock = 100;
    chain.latestNonce = 7;
    chain.pendingNonce = 7;
    await expect(run()).to.be.rejectedWith('rebroadcast is forbidden');
    expect(chain.sendCount).to.equal(1);
  });

  it('never rebroadcasts a recorded attempt that disappears before a canonical receipt', async () => {
    let error: unknown;
    try {
      await run({
        testOnlyAfterBroadcastPersist: () => {
          throw new Error('crash after recorded attempt');
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).to.equal('crash after recorded attempt');
    const recorded = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    expect(recorded.steps[0].state).to.equal('broadcast');
    expect(recorded.steps[0].attemptHashes).to.have.length(1);
    chain.transactions.clear();
    chain.receipts.clear();
    for (const blockNumber of [...chain.blocks.keys()]) {
      if (blockNumber > 100) chain.blocks.delete(blockNumber);
    }
    chain.latestBlock = 100;
    chain.latestNonce = 7;
    chain.pendingNonce = 7;
    await expect(run()).to.be.rejectedWith('rebroadcast is forbidden');
    expect(chain.sendCount).to.equal(1);
  });

  it('never automatically takes over one dead lease and preserves its exact bytes under two contenders', async () => {
    let leaseFile = '';
    await expect(
      run({
        testOnlyAfterBoundaryLeaseAcquired: (file) => {
          leaseFile = file;
          throw new Error('simulated hard crash after lease acquisition');
        },
        testOnlyPreserveBoundaryLeaseOnExit: true,
      })
    ).to.be.rejectedWith('simulated hard crash after lease acquisition');
    const deadLease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    deadLease.ownerPid = 2_147_483_647;
    fs.writeFileSync(leaseFile, `${JSON.stringify(deadLease, null, 2)}\n`, { mode: 0o600 });
    const deadLeaseBytes = fs.readFileSync(leaseFile);

    const contenders = await Promise.allSettled([run(), run()]);
    expect(contenders.every((result) => result.status === 'rejected')).to.equal(true);
    for (const result of contenders) {
      expect((result as PromiseRejectedResult).reason.message).to.include('automatic active or stale lease takeover');
    }
    expect(fs.readFileSync(leaseFile).equals(deadLeaseBytes)).to.equal(true);
    expect(fs.existsSync(journalFile)).to.equal(false);
    expect(fs.existsSync(manifestFile)).to.equal(false);
    expect(chain.sendCount).to.equal(0);
  });

  it('atomically serializes concurrent runners across different journal and snapshot identities', async () => {
    chain.sendDelayMs = 20;
    const secondJournal = path.join(root, 'alternate-finalization.json');
    const runner = (file: string, candidate: FinalizationRunInput['expected']) =>
      runDurableFinalization({
        journalFile: file,
        manifestFile,
        expected: candidate,
        provider: chain.provider(),
        signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
        assertFreshBeforeBroadcast: () => undefined,
        verifyConfirmedStep: async () => undefined,
        testOnlyLockRoot: stableStateRoot,
      });
    const concurrent = await Promise.allSettled([runner(journalFile, expected), runner(secondJournal, expected)]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).to.have.length(1);
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);

    const differentSnapshotJournal = path.join(root, 'different-snapshot-finalization.json');
    await expect(runner(differentSnapshotJournal, { ...expected, snapshotSha256: '33'.repeat(32) })).to.be.rejectedWith(
      'broadcast ownership tombstone is invalid or changed'
    );
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);
  });

  it('collides every journal/manifest path and prepared or snapshot digest at one fork/deployer/nonce boundary', async () => {
    chain.sendDelayMs = 20;
    const packet = (name: string, candidate: FinalizationRunInput['expected']) => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory, { recursive: true });
      const packetJournal = path.join(directory, 'finalization.json');
      const packetManifest = path.join(directory, 'manifest.json');
      return runDurableFinalization({
        journalFile: packetJournal,
        manifestFile: packetManifest,
        expected: { ...candidate, manifestReference: portableArtifactReference(packetJournal, packetManifest) },
        provider: chain.provider(),
        signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
        assertFreshBeforeBroadcast: () => undefined,
        verifyConfirmedStep: async () => undefined,
        testOnlyLockRoot: stableStateRoot,
      });
    };

    const raced = await Promise.allSettled([packet('packet-a', expected), packet('packet-b', expected)]);
    expect(raced.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    expect(raced.filter((result) => result.status === 'rejected')).to.have.length(1);
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);

    await expect(
      packet('different-prepared-copy', { ...expected, preparedFileSha256: '33'.repeat(32) })
    ).to.be.rejectedWith('broadcast ownership tombstone is invalid or changed');
    await expect(packet('different-snapshot', { ...expected, snapshotSha256: '44'.repeat(32) })).to.be.rejectedWith(
      'broadcast ownership tombstone is invalid or changed'
    );
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);
  });

  it('relocates a complete evidence packet without source paths or local runtime tombstones', async () => {
    const committed = await run({
      commitAcceptedEvidence: async ({ journal, journalSha256 }) => {
        commitAcceptedManifestExclusive({
          manifestFile,
          journalFile,
          journalSha256,
          manifest: {
            release: journal.release,
            finalization: {
              journalReference: portableArtifactReference(manifestFile, journalFile),
              journalSha256,
              leaseScope: journal.leaseScope,
              planSha256: journal.planSha256,
              status: journal.status,
              steps: journal.steps,
            },
          },
        });
      },
    });
    expect(committed.status).to.equal('complete');

    const relocatedRoot = path.join(root, 'relocated-packet');
    fs.mkdirSync(relocatedRoot);
    const relocatedJournal = path.join(relocatedRoot, path.basename(journalFile));
    const relocatedManifest = path.join(relocatedRoot, path.basename(manifestFile));
    fs.copyFileSync(journalFile, relocatedJournal);
    fs.copyFileSync(manifestFile, relocatedManifest);
    const sourceManifestHash = utils.sha256(fs.readFileSync(manifestFile));
    fs.rmSync(stableStateRoot, { recursive: true, force: true });

    const portable = loadAndValidateFinalizationJournal(relocatedJournal, {
      ...expected,
      manifestReference: portableArtifactReference(relocatedJournal, relocatedManifest),
    });
    expect(portable.status).to.equal('complete');
    expect(utils.sha256(fs.readFileSync(relocatedManifest))).to.equal(sourceManifestHash);
    expect(fs.readFileSync(relocatedJournal, 'utf8')).not.to.include(path.dirname(journalFile));
    expect(fs.readFileSync(relocatedManifest, 'utf8')).not.to.include(path.dirname(manifestFile));

    await expect(
      runDurableFinalization({
        journalFile: relocatedJournal,
        manifestFile: relocatedManifest,
        expected: { ...expected, manifestReference: path.basename(relocatedManifest) },
        provider: chain.provider(),
        signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
        assertFreshBeforeBroadcast: () => undefined,
        verifyConfirmedStep: async () => undefined,
        testOnlyLockRoot: path.join(root, 'different-host-state'),
      })
    ).to.be.rejectedWith('durable local release-state host identity is missing');
    expect(chain.sendCount).to.equal(5);
  });

  it('survives volatile packet cleanup and restart without a second economic send', async () => {
    const volatilePacket = path.join(root, 'volatile-packet');
    const recoveredPacket = path.join(root, 'recovered-packet');
    fs.mkdirSync(volatilePacket);
    fs.mkdirSync(recoveredPacket);
    const volatileJournal = path.join(volatilePacket, 'finalization.json');
    const volatileManifest = path.join(volatilePacket, 'manifest.json');
    const recoveredJournal = path.join(recoveredPacket, 'finalization.json');
    const recoveredManifest = path.join(recoveredPacket, 'manifest.json');
    const candidate = {
      ...expected,
      preparationBoundaryBlockHash: utils.hexlify(utils.randomBytes(32)),
      manifestReference: 'manifest.json',
    };
    const execute = (packetJournal: string, packetManifest: string, overrides: Partial<FinalizationRunInput> = {}) =>
      runDurableFinalization({
        journalFile: packetJournal,
        manifestFile: packetManifest,
        expected: candidate,
        provider: chain.provider(),
        signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
        assertFreshBeforeBroadcast: () => undefined,
        verifyConfirmedStep: async () => undefined,
        testOnlyLockRoot: stableStateRoot,
        ...overrides,
      });

    await expect(
      execute(volatileJournal, volatileManifest, {
        testOnlyAfterSendBeforePersist: () => {
          throw new Error('simulated reboot after send');
        },
      })
    ).to.be.rejectedWith('simulated reboot after send');
    expect(chain.sendCount).to.equal(1);
    fs.copyFileSync(volatileJournal, recoveredJournal);
    fs.rmSync(volatilePacket, { recursive: true, force: true });

    const recovered = await execute(recoveredJournal, recoveredManifest);
    expect(recovered.status).to.equal('complete');
    expect(chain.sentNonces).to.deep.equal([7, 8, 9, 10, 11]);
    expect(chain.sendCount).to.equal(5);
  });

  it('holds one boundary lease from all-confirmed recovery through an exclusive stable manifest commit', async () => {
    await expect(
      run({
        testOnlyBeforeFinality: () => {
          throw new Error('pause after all receipts are confirmed');
        },
      })
    ).to.be.rejectedWith('pause after all receipts are confirmed');
    const confirmed = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    expect(confirmed.steps.every((step: { state: string }) => step.state === 'confirmed')).to.equal(true);
    expect(fs.existsSync(manifestFile)).to.equal(false);

    let manifestCommits = 0;
    const finish = () =>
      run({
        commitAcceptedEvidence: async ({ journal, journalSha256 }) => {
          manifestCommits += 1;
          commitAcceptedManifestExclusive({
            manifestFile,
            journalFile,
            journalSha256,
            manifest: {
              release: journal.release,
              finalization: {
                journalReference: portableArtifactReference(manifestFile, journalFile),
                journalSha256,
                leaseScope: journal.leaseScope,
                planSha256: journal.planSha256,
                status: journal.status,
                steps: journal.steps,
              },
            },
          });
        },
      });
    const results = await Promise.allSettled([finish(), finish()]);
    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    expect(results.filter((result) => result.status === 'rejected')).to.have.length(1);
    expect(manifestCommits).to.equal(1);
    const stableManifestHash = utils.sha256(fs.readFileSync(manifestFile));
    expect(utils.sha256(fs.readFileSync(manifestFile))).to.equal(stableManifestHash);
    const acceptedJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    expect(acceptedJournal.status).to.equal('complete');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const accepted = JSON.parse(fs.readFileSync(acceptedRecordFile(), 'utf8'));
    expect(accepted.journalSha256).to.equal(sha256(journalFile));
    expect(accepted.manifestSha256).to.equal(sha256(manifestFile));
    expect(manifest.finalization.journalSha256).to.equal(accepted.journalSha256);
    expect(Buffer.from(accepted.journalBytesBase64, 'base64').equals(fs.readFileSync(journalFile))).to.equal(true);
    expect(Buffer.from(accepted.manifestBytesBase64, 'base64').equals(fs.readFileSync(manifestFile))).to.equal(true);
    expect(chain.sendCount).to.equal(5);
  });

  it('persists one path-independent accepted packet and rejects a second packet before its callback', async () => {
    let manifestCallbacks = 0;
    const commit =
      (packetManifest: string, packetJournal: string) =>
      async ({ journal, journalSha256 }: { journal: FinalizationJournal; journalSha256: string }) => {
        manifestCallbacks += 1;
        commitAcceptedManifestExclusive({
          manifestFile: packetManifest,
          journalFile: packetJournal,
          journalSha256,
          manifest: {
            release: journal.release,
            finalization: {
              journalReference: portableArtifactReference(packetManifest, packetJournal),
              journalSha256,
              leaseScope: journal.leaseScope,
              planSha256: journal.planSha256,
              status: journal.status,
              steps: journal.steps,
            },
          },
        });
      };
    await run({ commitAcceptedEvidence: commit(manifestFile, journalFile) });
    expect(manifestCallbacks).to.equal(1);

    const secondRoot = path.join(root, 'second-packet');
    fs.mkdirSync(secondRoot);
    const secondJournal = path.join(secondRoot, path.basename(journalFile));
    const secondManifest = path.join(secondRoot, path.basename(manifestFile));
    await expect(
      runDurableFinalization({
        journalFile: secondJournal,
        manifestFile: secondManifest,
        expected: { ...expected, manifestReference: portableArtifactReference(secondJournal, secondManifest) },
        provider: chain.provider(),
        signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
        assertFreshBeforeBroadcast: () => undefined,
        verifyConfirmedStep: async () => undefined,
        commitAcceptedEvidence: commit(secondManifest, secondJournal),
        testOnlyLockRoot: stableStateRoot,
      })
    ).to.be.rejectedWith('already has one accepted immutable journal/manifest packet');
    expect(manifestCallbacks).to.equal(1);
    expect(fs.existsSync(secondJournal)).to.equal(false);
    expect(fs.existsSync(secondManifest)).to.equal(false);
    expect(fs.readdirSync(stableStateRoot).filter((file) => file.endsWith('.accepted.json'))).to.have.length(1);
    expect(chain.sendCount).to.equal(5);
  });

  it('preserves an indeterminate boundary lease after manifest commit until stable acceptance exists', async () => {
    let manifestCallbacks = 0;
    await expect(
      run({
        commitAcceptedEvidence: async ({ journal, journalSha256 }) => {
          manifestCallbacks += 1;
          commitAcceptedManifestExclusive({
            manifestFile,
            journalFile,
            journalSha256,
            manifest: {
              release: journal.release,
              finalization: {
                journalReference: portableArtifactReference(manifestFile, journalFile),
                journalSha256,
                leaseScope: journal.leaseScope,
                planSha256: journal.planSha256,
                status: journal.status,
                steps: journal.steps,
              },
            },
          });
        },
        testOnlyAfterAcceptedEvidenceCommit: () => {
          throw new Error('crash after path manifest commit before stable acceptance');
        },
      })
    ).to.be.rejectedWith('crash after path manifest commit before stable acceptance');
    expect(manifestCallbacks).to.equal(1);
    const leaseFile = path.join(
      stableStateRoot,
      fs.readdirSync(stableStateRoot).find((file) => file.endsWith('.lease.json'))!
    );
    const leaseBytes = fs.readFileSync(leaseFile);
    expect(JSON.parse(leaseBytes.toString()).phase).to.equal('acceptance_commit_indeterminate');
    expect(fs.readdirSync(stableStateRoot).filter((file) => file.endsWith('.accepted.json'))).to.have.length(0);

    const secondRoot = path.join(root, 'indeterminate-second-packet');
    fs.mkdirSync(secondRoot);
    const secondJournal = path.join(secondRoot, path.basename(journalFile));
    const secondManifest = path.join(secondRoot, path.basename(manifestFile));
    await expect(
      runDurableFinalization({
        journalFile: secondJournal,
        manifestFile: secondManifest,
        expected: { ...expected, manifestReference: portableArtifactReference(secondJournal, secondManifest) },
        provider: chain.provider(),
        signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
        assertFreshBeforeBroadcast: () => undefined,
        verifyConfirmedStep: async () => undefined,
        commitAcceptedEvidence: async () => {
          manifestCallbacks += 1;
        },
        testOnlyLockRoot: stableStateRoot,
      })
    ).to.be.rejectedWith('automatic active or stale lease takeover is forbidden');
    expect(manifestCallbacks).to.equal(1);
    expect(fs.readFileSync(leaseFile).equals(leaseBytes)).to.equal(true);
    expect(fs.existsSync(secondJournal)).to.equal(false);
    expect(fs.existsSync(secondManifest)).to.equal(false);
    expect(chain.sendCount).to.equal(5);
  });

  it('accepts only same-directory basename artifact references', () => {
    expect(portableArtifactReference(journalFile, manifestFile)).to.equal('manifest.json');
    expect(() => portableArtifactReference(journalFile, path.join(root, 'other', 'manifest.json'))).to.throw(
      'same canonical packet directory'
    );
    for (const reference of ['.', '..', '../manifest.json', 'nested/manifest.json', 'nested\\manifest.json']) {
      expect(() => resolvePortableArtifactReference(journalFile, reference)).to.throw('one portable basename');
    }
  });

  it('persists a reverted transaction as terminal and never rebroadcasts it after restart', async () => {
    chain.revertNext = true;
    await expect(run()).to.be.rejectedWith('transaction reverted');
    const terminal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    expect(terminal.status).to.equal('abandoned');
    expect(terminal.terminal.outcome).to.equal('transaction reverted');
    expect(chain.sendCount).to.equal(5);
    await expect(run()).to.be.rejectedWith('terminally abandoned');
    expect(chain.sendCount).to.equal(5);
  });

  it('fails closed on tampered calldata, a consumed nonce, stale receipt evidence, and a reorg', async () => {
    reserveFinalizationJournal(journalFile, manifestFile, expected, runtimeValidation());
    const tampered = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    tampered.steps[0].calldata = '0xdeadbeef';
    fs.writeFileSync(journalFile, JSON.stringify(tampered));
    expect(() => loadAndValidateFinalizationJournal(journalFile, expected, runtimeValidation())).to.throw(
      'selector does not match calldata'
    );

    fs.rmSync(journalFile);
    chain.latestNonce = 8;
    chain.pendingNonce = 8;
    await expect(run()).to.be.rejectedWith('nonce was consumed');
    expect(chain.sendCount).to.equal(0);

    fs.rmSync(journalFile);
    rotateBoundary();
    chain = new FakeChain();
    await expect(
      run({
        verifyConfirmedStep: async () => {
          throw new Error('signed price stale at receipt block');
        },
      })
    ).to.be.rejectedWith('signed price stale at receipt block');
    expect(chain.sendCount).to.equal(5);

    fs.rmSync(journalFile);
    rotateBoundary();
    chain = new FakeChain();
    await run();
    const firstHash = JSON.parse(fs.readFileSync(journalFile, 'utf8')).steps[0].receipt.transactionHash;
    const firstReceipt = chain.receipts.get(firstHash)!;
    chain.blocks.delete(firstReceipt.blockNumber);
    await expect(run()).to.be.rejectedWith('receipt block is unavailable or reorged');
    expect(chain.sendCount).to.equal(5);
  });

  it('requires exact AddProduct event parity', () => {
    const event = new utils.Interface(['event AddProduct(uint32 productId)']);
    const encoded = event.encodeEventLog(event.getEvent('AddProduct'), [2]);
    const receipt = { logs: [{ address: PERP_ENGINE, data: encoded.data, topics: encoded.topics }] } as never;
    expect(() => assertSingleAddProductEvent(receipt, PERP_ENGINE, 2)).not.to.throw();
    expect(() => assertSingleAddProductEvent(receipt, PERP_ENGINE, 4)).to.throw('product ID mismatch');
    expect(() => assertSingleAddProductEvent({ logs: [] }, PERP_ENGINE, 2)).to.throw('exactly one AddProduct');
  });

  it('never overwrites a raced journal reservation or a pre-existing manifest target', () => {
    fs.writeFileSync(journalFile, '{"raced":true}\n', { mode: 0o600, flag: 'wx' });
    expect(() => reserveFinalizationJournal(journalFile, manifestFile, expected, runtimeValidation())).to.throw();
    expect(fs.readFileSync(journalFile, 'utf8')).to.equal('{"raced":true}\n');

    fs.rmSync(journalFile);
    fs.writeFileSync(manifestFile, '{"status":"existing"}\n', { mode: 0o600, flag: 'wx' });
    expect(() => reserveFinalizationJournal(journalFile, manifestFile, expected, runtimeValidation())).to.throw(
      'manifest target already exists'
    );
    expect(fs.existsSync(journalFile)).to.equal(false);
  });

  it('rejects tampered finalized state and never accepts complete before all five final receipts', async () => {
    await run();
    const confirmed = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    confirmed.steps[0].attemptHashes.push(confirmed.steps[0].attemptHashes[0]);
    fs.writeFileSync(journalFile, JSON.stringify(confirmed));
    expect(() => loadAndValidateFinalizationJournal(journalFile, expected, runtimeValidation())).to.throw(
      'transaction attempt history does not match state'
    );
    confirmed.steps[0].attemptHashes = [confirmed.steps[0].attemptHashes[0]];

    const ownershipFile = path.join(
      stableStateRoot,
      fs.readdirSync(stableStateRoot).find((file) => file.endsWith('.broadcast.json'))!
    );
    const ownershipBytes = fs.readFileSync(ownershipFile);
    fs.writeFileSync(ownershipFile, '{"tampered":true}\n');
    fs.writeFileSync(journalFile, JSON.stringify(confirmed));
    expect(() => loadAndValidateFinalizationJournal(journalFile, expected, runtimeValidation())).to.throw(
      'broadcast ownership tombstone is invalid or changed'
    );
    fs.writeFileSync(ownershipFile, ownershipBytes);

    confirmed.terminal = { stepId: 'forged', outcome: 'forged', recordedAt: new Date().toISOString() };
    fs.writeFileSync(journalFile, JSON.stringify(confirmed));
    expect(() => loadAndValidateFinalizationJournal(journalFile, expected, runtimeValidation())).to.throw(
      'terminal outcome does not match status'
    );
    delete confirmed.terminal;
    confirmed.steps[0].receipt.blockHash = `0x${'ff'.repeat(31)}`;
    fs.writeFileSync(journalFile, JSON.stringify(confirmed));
    expect(() => loadAndValidateFinalizationJournal(journalFile, expected, runtimeValidation())).to.throw(
      'confirmed state has invalid immutable receipt evidence'
    );

    confirmed.steps[0].receipt.blockHash = chain.receipts.get(confirmed.steps[0].receipt.transactionHash)!.blockHash;
    confirmed.steps[4].state = 'planned';
    confirmed.steps[4].attemptHashes = [];
    delete confirmed.steps[4].broadcastOwnership;
    delete confirmed.steps[4].broadcastOwnershipSha256;
    delete confirmed.steps[4].receipt;
    delete confirmed.steps[4].finality;
    confirmed.status = 'complete';
    fs.writeFileSync(journalFile, JSON.stringify(confirmed));
    expect(() => loadAndValidateFinalizationJournal(journalFile, expected, runtimeValidation())).to.throw(
      'complete finalization journal requires all five steps finalized at 12 confirmations'
    );
  });

  it('terminally abandons a canonical reorg observed between mined sequencing and 12-confirmation finality', async () => {
    await expect(
      run({
        testOnlyBeforeFinality: (journal) => {
          chain.blocks.delete(journal.steps[0].receipt!.blockNumber);
        },
      })
    ).to.be.rejectedWith('failed finality reconciliation');
    const terminal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    expect(terminal.status).to.equal('abandoned');
    expect(terminal.steps.every((step: { state: string }) => step.state === 'confirmed')).to.equal(true);
    expect(chain.sendCount).to.equal(5);
    await expect(run()).to.be.rejectedWith('terminally abandoned');
    expect(chain.sendCount).to.equal(5);
  });

  it('rejects duplicate, reordered, missing, or extra launch steps independently of the caller plan hash', () => {
    for (const mutate of [
      (steps: FinalizationStepPlan[]) => steps.reverse(),
      (steps: FinalizationStepPlan[]) => steps.slice(0, 4),
      (steps: FinalizationStepPlan[]) => [...steps, { ...steps[4], nonce: 12 }],
      (steps: FinalizationStepPlan[]) => {
        steps[2] = { ...steps[1], nonce: 9 };
        return steps;
      },
    ]) {
      const candidate = { ...expected, steps: mutate(plans()) };
      expect(() => reserveFinalizationJournal(journalFile, manifestFile, candidate, runtimeValidation())).to.throw(
        'exactly Endpoint.initialize then addProduct 2,4,6,8'
      );
      expect(fs.existsSync(journalFile)).to.equal(false);
    }
  });
});
