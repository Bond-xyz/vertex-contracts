import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import {
  deterministicSha256,
  ensureLocalReleaseStateHostIdentity,
  FinalizationRunInput,
  FinalizationStepPlan,
  portableArtifactReference,
  runDurableFinalization,
} from '../scripts/galileo-finalization-journal';
import {
  LateReceiptRecoveryInput,
  LATE_RECEIPT_RECOVERY_KIND,
  LATE_RECEIPT_VISIBILITY_OUTCOME,
  recoverLateCanonicalReceipts,
} from '../scripts/galileo-late-receipt-recovery';

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
      calldata: `0x12345678${'00'.repeat(32)}`,
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

class RecoveryChain {
  latestBlock = 100;
  latestNonce = 7;
  pendingNonce = 7;
  sendCount = 0;
  transactions = new Map<string, providers.TransactionResponse>();
  receipts = new Map<string, providers.TransactionReceipt>();
  blocks = new Map<number, providers.BlockWithTransactions>();

  constructor() {
    this.blocks.set(100, this.block(100, []));
  }

  private block(number: number, transactions: providers.TransactionResponse[]): providers.BlockWithTransactions {
    return {
      number,
      hash: utils.keccak256(utils.defaultAbiCoder.encode(['uint256'], [number])),
      parentHash: utils.hexZeroPad('0x01', 32),
      timestamp: 1_000 + number,
      nonce: '0x0000000000000000',
      difficulty: 0,
      gasLimit: BigNumber.from(30_000_000),
      gasUsed: BigNumber.from(0),
      miner: DEPLOYER,
      extraData: '0x',
      transactions,
      _difficulty: BigNumber.from(0),
      baseFeePerGas: BigNumber.from(1),
    } as providers.BlockWithTransactions;
  }

  async sendTransaction(request: providers.TransactionRequest): Promise<providers.TransactionResponse> {
    this.sendCount += 1;
    const nonce = Number(request.nonce);
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
      status: 1,
    } as providers.TransactionReceipt;
    this.transactions.set(hash, transaction);
    this.receipts.set(hash, receipt);
    this.blocks.set(block.number, block);
    this.latestNonce = nonce + 1;
    this.pendingNonce = nonce + 1;
    return transaction;
  }

  provider(): FinalizationRunInput['provider'] {
    return {
      getBlockNumber: async () => {
        if (!this.blocks.has(this.latestBlock)) this.blocks.set(this.latestBlock, this.block(this.latestBlock, []));
        return this.latestBlock;
      },
      getBlockWithTransactions: async (number: number) => this.blocks.get(number)!,
      getTransaction: async (hash: string) => this.transactions.get(hash) || null,
      getTransactionReceipt: async (hash: string) => this.receipts.get(hash) || null,
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

describe('Galileo late canonical receipt recovery', () => {
  let root: string;
  let stateRoot: string;
  let preparedFile: string;
  let snapshotFile: string;
  let originalJournalFile: string;
  let originalManifestFile: string;
  let recoveredJournalFile: string;
  let recoveredManifestFile: string;
  let chain: RecoveryChain;
  let expected: FinalizationRunInput['expected'];
  let recoveryInput: LateReceiptRecoveryInput;
  let originalBytes: Buffer;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'galileo-late-receipts-'));
    stateRoot = path.join(root, 'state');
    preparedFile = path.join(root, 'prepared.json');
    snapshotFile = path.join(root, 'snapshot.json');
    originalJournalFile = path.join(root, 'finalization.json');
    originalManifestFile = path.join(root, 'latest.json');
    recoveredJournalFile = path.join(root, 'finalization.recovered.json');
    recoveredManifestFile = path.join(root, 'latest.recovered.json');
    fs.writeFileSync(preparedFile, '{"prepared":true}\n');
    fs.writeFileSync(snapshotFile, '{"snapshot":true}\n');
    const preparedSha256 = utils.sha256(fs.readFileSync(preparedFile)).slice(2);
    chain = new RecoveryChain();
    expected = {
      schemaVersion: 1,
      release: 'test-release',
      chainId: 16602,
      preparedFileSha256: preparedSha256,
      snapshotSha256: '22'.repeat(32),
      manifestReference: portableArtifactReference(originalJournalFile, originalManifestFile),
      deployer: DEPLOYER,
      startingNonce: 7,
      scanFromBlock: 100,
      preparationBoundaryBlockHash: utils.keccak256(utils.toUtf8Bytes(root)),
      releaseStateHostIdentity: ensureLocalReleaseStateHostIdentity({ testOnlyLockRoot: stateRoot }),
      leaseScope: 'single_host_local_eoa_no_cross_host',
      finalityConfirmations: 12,
      steps: plans(),
    };
    await runDurableFinalization({
      journalFile: originalJournalFile,
      manifestFile: originalManifestFile,
      expected,
      provider: chain.provider(),
      signer: { sendTransaction: chain.sendTransaction.bind(chain) } as never,
      assertFreshBeforeBroadcast: () => undefined,
      verifyConfirmedStep: async () => undefined,
      testOnlyLockRoot: stateRoot,
    });
    const terminal = JSON.parse(fs.readFileSync(originalJournalFile, 'utf8'));
    terminal.status = 'abandoned';
    terminal.terminal = {
      stepId: 'endpoint.initialize',
      outcome: LATE_RECEIPT_VISIBILITY_OUTCOME,
      recordedAt: '2026-08-23T03:35:55.765Z',
    };
    for (const step of terminal.steps) {
      step.state = 'broadcast';
      delete step.receipt;
      delete step.finality;
    }
    fs.writeFileSync(originalJournalFile, `${JSON.stringify(terminal, null, 2)}\n`, { mode: 0o600 });
    originalBytes = fs.readFileSync(originalJournalFile);
    recoveryInput = {
      originalJournalFile,
      originalManifestFile,
      recoveredJournalFile,
      recoveredManifestFile,
      preparedFile,
      snapshotFile,
      snapshotEvidenceSha256: expected.snapshotSha256,
      expected,
      provider: chain.provider(),
      verifyReceiptBlock: async () => undefined,
      verifyLiveState: async () => undefined,
      buildManifest: ({ journal, journalSha256 }) => ({
        schemaVersion: 9,
        release: journal.release,
        finalization: {
          journalReference: portableArtifactReference(recoveredManifestFile, recoveredJournalFile),
          journalSha256,
          planSha256: journal.planSha256,
          status: journal.status,
          leaseScope: journal.leaseScope,
          finalityConfirmations: journal.finalityConfirmations,
          finalityHeadBlock: Math.max(...journal.steps.map((step) => step.finality!.observedHeadBlock)),
          startingNonce: journal.startingNonce,
          scanFromBlock: journal.scanFromBlock,
          steps: journal.steps,
        },
      }),
      testOnlyLockRoot: stateRoot,
      now: () => new Date('2026-08-23T04:00:00.000Z'),
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps signer construction and every transaction-send primitive out of the recovery command', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'recover-galileo-late-receipts.ts'),
      'utf8'
    );
    for (const forbidden of [
      'sendTransaction(',
      'getSigners(',
      'new Wallet(',
      'PERPDEX_GALILEO_DEPLOYER_PRIVATE_KEY',
      '.deploy(',
    ]) {
      expect(source).not.to.contain(forbidden);
    }
  });

  it('recovers only the five original hashes into a new immutable packet without touching the terminal journal', async () => {
    const result = await recoverLateCanonicalReceipts(recoveryInput);
    expect(result.journal.status).to.equal('complete');
    expect(result.journal.recovery.kind).to.equal(LATE_RECEIPT_RECOVERY_KIND);
    expect(result.journal.recovery.noTransactionsBroadcast).to.equal(true);
    expect(result.journal.steps.every((step) => step.state === 'finalized')).to.equal(true);
    expect(result.journal.steps.every((step) => step.finality!.confirmationsObserved >= 12)).to.equal(true);
    expect(result.manifest.finalization.journalSha256).to.equal(result.journalSha256);
    expect(fs.readFileSync(originalJournalFile).equals(originalBytes)).to.equal(true);
    expect(fs.statSync(recoveredJournalFile).mode & 0o777).to.equal(0o600);
    expect(fs.statSync(recoveredManifestFile).mode & 0o777).to.equal(0o600);
    expect(chain.sendCount).to.equal(5);
  });

  it('rejects a wrong recorded hash or exact transaction bytes', async () => {
    const terminal = JSON.parse(fs.readFileSync(originalJournalFile, 'utf8'));
    terminal.steps[0].attemptHashes[0] = terminal.steps[1].attemptHashes[0];
    fs.writeFileSync(originalJournalFile, `${JSON.stringify(terminal, null, 2)}\n`);
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith(
      'transaction signer/target/nonce/selector/arguments mismatch'
    );
    expect(fs.existsSync(recoveredJournalFile)).to.equal(false);
  });

  it('rejects a reverted transaction and a partial receipt set', async () => {
    const terminal = JSON.parse(fs.readFileSync(originalJournalFile, 'utf8'));
    const firstHash = terminal.steps[0].attemptHashes[0];
    chain.receipts.get(firstHash)!.status = 0;
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith('recorded transaction reverted');

    chain.receipts.get(firstHash)!.status = 1;
    const lastHash = terminal.steps[4].attemptHashes[0];
    chain.receipts.delete(lastHash);
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith(
      'canonical receipt is unavailable after waiting for finality'
    );
  });

  it('rejects stale signed-price proof at any receipt block', async () => {
    recoveryInput.verifyReceiptBlock = async (step) => {
      if (step.productId === 4) throw new Error('signed Stork proof is stale at receipt block');
    };
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith('signed Stork proof is stale');
  });

  it('rejects a receipt reorg before producing either output', async () => {
    const terminal = JSON.parse(fs.readFileSync(originalJournalFile, 'utf8'));
    const firstHash = terminal.steps[0].attemptHashes[0];
    chain.blocks.delete(chain.receipts.get(firstHash)!.blockNumber);
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith(
      'receipt block is unavailable or reorged'
    );
    expect(fs.existsSync(recoveredManifestFile)).to.equal(false);
  });

  it('rejects mismatched live Endpoint/product/risk/VBook/engine/quorum/owner state', async () => {
    recoveryInput.verifyLiveState = async () => {
      throw new Error('live PerpEngine risk and VBook mapping mismatch');
    };
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith(
      'live PerpEngine risk and VBook mapping mismatch'
    );
  });

  it('rejects a missing ownership tombstone', async () => {
    const ownership = fs.readdirSync(stateRoot).find((file) => file.endsWith('.broadcast.json'))!;
    fs.unlinkSync(path.join(stateRoot, ownership));
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith(
      'broadcast ownership tombstone hash mismatch'
    );
  });

  it('rejects every terminal outcome except the exact receipt-visibility failure', async () => {
    const terminal = JSON.parse(fs.readFileSync(originalJournalFile, 'utf8'));
    terminal.terminal.outcome = 'transaction reverted';
    fs.writeFileSync(originalJournalFile, `${JSON.stringify(terminal, null, 2)}\n`);
    await expect(recoverLateCanonicalReceipts(recoveryInput)).to.be.rejectedWith(
      'allowed only for the exact known receipt-visibility terminal outcome'
    );
  });

  it('rejects a second recovery even when different output filenames are requested', async () => {
    await recoverLateCanonicalReceipts(recoveryInput);
    const second = {
      ...recoveryInput,
      recoveredJournalFile: path.join(root, 'finalization.recovered-again.json'),
      recoveredManifestFile: path.join(root, 'latest.recovered-again.json'),
    };
    second.buildManifest = ({ journal, journalSha256 }) => ({
      schemaVersion: 9,
      finalization: {
        journalReference: portableArtifactReference(second.recoveredManifestFile, second.recoveredJournalFile),
        journalSha256,
        planSha256: journal.planSha256,
        status: journal.status,
        leaseScope: journal.leaseScope,
        finalityConfirmations: journal.finalityConfirmations,
        finalityHeadBlock: Math.max(...journal.steps.map((step) => step.finality!.observedHeadBlock)),
        startingNonce: journal.startingNonce,
        scanFromBlock: journal.scanFromBlock,
        steps: journal.steps,
      },
    });
    await expect(recoverLateCanonicalReceipts(second)).to.be.rejectedWith('already has one accepted');
    expect(fs.readFileSync(originalJournalFile).equals(originalBytes)).to.equal(true);
  });
});
