import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import {
  AuthorityRotationEvidence,
  GALILEO_AUTHORITY_ROTATION_EVIDENCE,
  loadTrackedAuthorityRotationEvidence,
  NEW_AUTHORITY,
  OLD_AUTHORITY,
  ReadOnlyAuthorityProvider,
  TRACKED_RECOVERED_DEPLOYMENT_MANIFEST,
  validateAuthorityRotationEvidence,
  verifyAuthorityRotationEvidence,
} from '../scripts/galileo-authority-rotation';

const OWNER_SELECTOR = '0x8da5cb5b';
const GET_SEQUENCER_SELECTOR = '0x4d96a90a';
const GET_SIGNER_COUNT_SELECTOR = '0xb715be81';
const GET_PUBKEY_SELECTOR = '0x55e7673b';
const OWNERSHIP_TRANSFERRED_TOPIC = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

type Drift = {
  chainId?: number;
  rpcChainId?: number;
  latestOwner?: string;
  latestSequencer?: boolean;
  latestProxyImplementation?: string;
  latestVerifierPoint?: boolean;
  latestRetiredBalance?: boolean;
  latestRetiredNonce?: boolean;
  receiptStatus?: boolean;
};

function trackedBytes(): Buffer {
  return fs.readFileSync(GALILEO_AUTHORITY_ROTATION_EVIDENCE);
}

function trackedEvidence(): AuthorityRotationEvidence {
  return validateAuthorityRotationEvidence(JSON.parse(trackedBytes().toString('utf8')));
}

function addressWord(address: string): string {
  return utils.hexZeroPad(address, 32);
}

function isLatest(blockTag?: providers.BlockTag): boolean {
  return blockTag === undefined || blockTag === 'latest';
}

function fakeProvider(evidence: AuthorityRotationEvidence, drift: Drift = {}): ReadOnlyAuthorityProvider {
  const transactionByHash = new Map(
    evidence.rotation.transactions.map((transaction) => [transaction.transactionHash, transaction])
  );
  const blockHashByNumber = new Map(
    evidence.rotation.transactions.map((transaction) => [transaction.blockNumber, transaction.blockHash])
  );
  blockHashByNumber.set(evidence.postState.observedBlockNumber, evidence.postState.observedBlockHash);
  const ownerByAddress = new Map(
    Object.values(evidence.postState.owners).map((record) => [record.address.toLowerCase(), record.owner])
  );
  const proxyByAddress = new Map(evidence.postState.proxies.map((proxy) => [proxy.proxy.toLowerCase(), proxy]));
  const verifier = evidence.postState.owners.verifier.address.toLowerCase();
  const headBlock = evidence.postState.observedBlockNumber + 100;

  return {
    send: async (method: string) => {
      if (method !== 'eth_chainId') throw new Error('unexpected JSON-RPC method');
      return utils.hexValue(drift.rpcChainId || 16602);
    },
    getNetwork: async () => ({ chainId: drift.chainId || 16602, name: 'galileo' }),
    getBlockNumber: async () => headBlock,
    getBlock: async (blockNumber: providers.BlockTag) => {
      if (typeof blockNumber !== 'number') throw new Error('test provider expects a numeric block');
      const hash = blockHashByNumber.get(blockNumber);
      if (!hash) return null;
      return { number: blockNumber, hash } as providers.Block;
    },
    getTransaction: async (hash: string) => {
      const transaction = transactionByHash.get(hash);
      if (!transaction) return null;
      return {
        hash: transaction.transactionHash,
        nonce: transaction.nonce,
        from: transaction.from,
        to: transaction.to,
        value: BigNumber.from(transaction.valueWei),
        data: transaction.calldata,
        gasLimit: BigNumber.from(transaction.gasLimit),
        gasPrice: BigNumber.from(evidence.rotation.gasPriceWei),
      } as providers.TransactionResponse;
    },
    getTransactionReceipt: async (hash: string) => {
      const transaction = transactionByHash.get(hash);
      if (!transaction) return null;
      const logs =
        transaction.kind === 'transfer_ownership'
          ? [
              {
                address: transaction.to,
                data: '0x',
                topics: [
                  OWNERSHIP_TRANSFERRED_TOPIC,
                  utils.hexZeroPad(OLD_AUTHORITY, 32),
                  utils.hexZeroPad(NEW_AUTHORITY, 32),
                ],
              },
            ]
          : [];
      return {
        status: drift.receiptStatus && transaction.id === 'proxy-admin.transfer-ownership' ? 0 : 1,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
        gasUsed: BigNumber.from(transaction.gasUsed),
        to: transaction.to,
        from: transaction.from,
        logs,
      } as providers.TransactionReceipt;
    },
    getBalance: async (_address: string, blockTag?: providers.BlockTag) =>
      BigNumber.from(isLatest(blockTag) && drift.latestRetiredBalance ? 1 : 0),
    getTransactionCount: async (_address: string, blockTag?: providers.BlockTag) =>
      isLatest(blockTag) && drift.latestRetiredNonce ? 67 : 66,
    getStorageAt: async (address: string, position: BigNumberish, blockTag?: providers.BlockTag) => {
      const proxy = proxyByAddress.get(address.toLowerCase());
      if (!proxy) throw new Error('unexpected storage target');
      const slot = BigNumber.from(position).toHexString();
      if (BigNumber.from(slot).eq(BigNumber.from(IMPLEMENTATION_SLOT))) {
        const value =
          isLatest(blockTag) && drift.latestProxyImplementation === proxy.name
            ? '0x0000000000000000000000000000000000000001'
            : proxy.implementation;
        return addressWord(value);
      }
      if (BigNumber.from(slot).eq(BigNumber.from(ADMIN_SLOT))) return addressWord(proxy.admin);
      throw new Error('unexpected storage slot');
    },
    call: async (transaction: providers.TransactionRequest, blockTag?: providers.BlockTag) => {
      const to = String(transaction.to).toLowerCase();
      const data = String(transaction.data).toLowerCase();
      if (data === OWNER_SELECTOR) {
        const recordedOwner = ownerByAddress.get(to);
        if (!recordedOwner) throw new Error('unexpected owner target');
        const owner = isLatest(blockTag) && drift.latestOwner === to ? OLD_AUTHORITY : recordedOwner;
        return utils.defaultAbiCoder.encode(['address'], [owner]);
      }
      if (data === GET_SEQUENCER_SELECTOR) {
        const sequencer =
          isLatest(blockTag) && drift.latestSequencer ? OLD_AUTHORITY : evidence.postState.endpointSequencer;
        return utils.defaultAbiCoder.encode(['address'], [sequencer]);
      }
      if (to === verifier && data === GET_SIGNER_COUNT_SELECTOR) {
        return utils.defaultAbiCoder.encode(['uint256'], [evidence.postState.verifierQuorum.signerCount]);
      }
      if (to === verifier && data.startsWith(GET_PUBKEY_SELECTOR)) {
        const index = Number(utils.defaultAbiCoder.decode(['uint8'], utils.hexDataSlice(data, 4))[0]);
        const point = { ...evidence.postState.verifierQuorum.publicKeys[index] };
        if (isLatest(blockTag) && drift.latestVerifierPoint && index === 0) point.x = utils.hexZeroPad('0x01', 32);
        return utils.defaultAbiCoder.encode(['uint256', 'uint256'], [point.x, point.y]);
      }
      throw new Error('unexpected call');
    },
  } as ReadOnlyAuthorityProvider;
}

// ethers accepts this wider type for getStorageAt; keeping the alias local avoids
// importing all of @ethersproject/bignumber into the production verifier.
type BigNumberish = string | number | BigNumber;

describe('Galileo Red authority rotation evidence', () => {
  it('loads only the exact hash-pinned public artifact', () => {
    const digest = crypto.createHash('sha256').update(trackedBytes()).digest('hex');
    expect(
      loadTrackedAuthorityRotationEvidence(GALILEO_AUTHORITY_ROTATION_EVIDENCE, digest).rotation.transactions
    ).to.have.length(10);
    expect(() => loadTrackedAuthorityRotationEvidence(GALILEO_AUTHORITY_ROTATION_EVIDENCE, '00'.repeat(32))).to.throw(
      'SHA-256 mismatch'
    );
  });

  it('fails closed when the tracked source manifest is missing or mutated', () => {
    const digest = crypto.createHash('sha256').update(trackedBytes()).digest('hex');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galileo-authority-source-'));
    const missing = path.join(root, 'missing.json');
    expect(() => loadTrackedAuthorityRotationEvidence(GALILEO_AUTHORITY_ROTATION_EVIDENCE, digest, missing)).to.throw(
      'tracked recovered deployment manifest is missing or unreadable'
    );
    const mutated = path.join(root, 'mutated.json');
    fs.writeFileSync(
      mutated,
      Buffer.concat([fs.readFileSync(TRACKED_RECOVERED_DEPLOYMENT_MANIFEST), Buffer.from('\n')])
    );
    expect(() => loadTrackedAuthorityRotationEvidence(GALILEO_AUTHORITY_ROTATION_EVIDENCE, digest, mutated)).to.throw(
      'tracked recovered deployment manifest SHA-256 mismatch'
    );
  });

  it('verifies the canonical receipts, authority, proxy slots, and verifier quorum', async () => {
    const evidence = trackedEvidence();
    const result = await verifyAuthorityRotationEvidence(fakeProvider(evidence), evidence);
    expect(result.transactionCount).to.equal(10);
    expect(result.authority).to.equal(NEW_AUTHORITY);
  });

  it('fails closed when a live owner drifts', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(
        fakeProvider(evidence, { latestOwner: evidence.postState.owners.endpoint.address.toLowerCase() }),
        evidence
      )
    ).to.be.rejectedWith('live state endpoint owner drift');
  });

  it('fails closed when raw eth_chainId disagrees with the configured network', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { rpcChainId: 1 }), evidence)
    ).to.be.rejectedWith('authority rotation RPC is chain 1, not 16602');
  });

  it('fails closed when the live Endpoint sequencer drifts', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { latestSequencer: true }), evidence)
    ).to.be.rejectedWith('live state Endpoint sequencer drift');
  });

  it('fails closed when a proxy implementation slot drifts', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { latestProxyImplementation: 'endpoint' }), evidence)
    ).to.be.rejectedWith('live state endpoint implementation drift');
  });

  it('fails closed when the Verifier quorum drifts', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { latestVerifierPoint: true }), evidence)
    ).to.be.rejectedWith('live state Verifier quorum drift');
  });

  it('fails closed when the retired authority receives funds again', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { latestRetiredBalance: true }), evidence)
    ).to.be.rejectedWith('live state retired authority balance is not zero');
  });

  it('fails closed when the retired authority nonce advances', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { latestRetiredNonce: true }), evidence)
    ).to.be.rejectedWith('live state retired authority nonce drift');
  });

  it('fails closed when a canonical rotation receipt is unsuccessful', async () => {
    const evidence = trackedEvidence();
    await expect(
      verifyAuthorityRotationEvidence(fakeProvider(evidence, { receiptStatus: true }), evidence)
    ).to.be.rejectedWith('proxy-admin.transfer-ownership receipt drift');
  });

  it('fails closed when the source recovered-manifest binding drifts', () => {
    const evidence = JSON.parse(trackedBytes().toString('utf8'));
    evidence.sourceDeployment.manifestSha256 = '00'.repeat(32);
    expect(() => validateAuthorityRotationEvidence(evidence)).to.throw('source manifest mismatch');
  });
});
