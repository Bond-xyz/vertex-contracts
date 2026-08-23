import { expect } from 'chai';
import {
  BootstrapJournal,
  buildBootstrapSteps,
  RED_MM_AUTHORITY,
  RED_MM_CHAIN_ID,
  RED_MM_DEPOSIT_RAW,
  RED_MM_ENDPOINT,
  RED_MM_MAKER,
  RED_MM_MAKER_SUBACCOUNT,
  RED_MM_NATIVE_TOP_UP_WEI,
  RED_MM_TAKER,
  RED_MM_TAKER_SUBACCOUNT,
  RED_MM_USDCE,
  serializeBootstrapJournal,
  validateJournalIdentity,
} from '../scripts/bootstrap-red-mm-wallets';

function exactJournal(): BootstrapJournal {
  return {
    schemaVersion: 1,
    kind: 'red_mm_wallet_bootstrap',
    chainId: RED_MM_CHAIN_ID,
    endpoint: RED_MM_ENDPOINT,
    token: RED_MM_USDCE,
    authority: RED_MM_AUTHORITY,
    maker: { address: RED_MM_MAKER, subaccount: RED_MM_MAKER_SUBACCOUNT },
    taker: { address: RED_MM_TAKER, subaccount: RED_MM_TAKER_SUBACCOUNT },
    nativeTopUpWei: RED_MM_NATIVE_TOP_UP_WEI,
    depositAmountRaw: RED_MM_DEPOSIT_RAW,
    confirmationsRequired: 12,
    initialState: {
      authorityNonce: 130,
      makerNonce: 0,
      takerNonce: 0,
      slowModeTxUpTo: '85',
      slowModeTxCount: '85',
      clearinghouseCustodyRaw: '0',
    },
    steps: buildBootstrapSteps(130, 0, 0, '4000000007'),
    complete: false,
  };
}

describe('Red MM wallet bootstrap', () => {
  it('builds the exact bounded eight-transaction plan', () => {
    const steps = buildBootstrapSteps(130, 0, 0, '4000000007');
    expect(steps).to.have.length(8);
    expect(steps.map((step) => [step.id, step.signer, step.nonce])).to.deep.equal([
      ['fund-maker-gas', 'authority', 130],
      ['fund-taker-gas', 'authority', 131],
      ['maker-mint-usdce', 'maker', 0],
      ['maker-approve-endpoint', 'maker', 1],
      ['maker-deposit', 'maker', 2],
      ['taker-mint-usdce', 'taker', 0],
      ['taker-approve-endpoint', 'taker', 1],
      ['taker-deposit', 'taker', 2],
    ]);
    expect(steps[0]).to.include({ to: RED_MM_MAKER, valueWei: RED_MM_NATIVE_TOP_UP_WEI, gasLimit: '21000' });
    expect(steps[1]).to.include({ to: RED_MM_TAKER, valueWei: RED_MM_NATIVE_TOP_UP_WEI, gasLimit: '21000' });
    expect(steps[2].data.slice(0, 10)).to.equal('0x40c10f19');
    expect(steps[3].data.slice(0, 10)).to.equal('0x095ea7b3');
    expect(steps[4].data.slice(0, 10)).to.equal('0x8e5d588c');
    expect(steps[5].data.slice(0, 10)).to.equal('0x40c10f19');
    expect(steps[6].data.slice(0, 10)).to.equal('0x095ea7b3');
    expect(steps[7].data.slice(0, 10)).to.equal('0x8e5d588c');
  });

  it('accepts only the exact Red identities and amounts', () => {
    const journal = exactJournal();
    expect(() => validateJournalIdentity(journal)).not.to.throw();
    expect(() =>
      validateJournalIdentity({ ...journal, endpoint: '0x0000000000000000000000000000000000000001' })
    ).to.throw('exact Red MM bootstrap policy');
    expect(() => validateJournalIdentity({ ...journal, depositAmountRaw: '50000000001' })).to.throw(
      'exact Red MM bootstrap policy'
    );
    expect(() => validateJournalIdentity({ ...journal, confirmationsRequired: 11 })).to.throw(
      'exact Red MM bootstrap policy'
    );
    const tamperedStep = exactJournal();
    tamperedStep.steps[4].data = tamperedStep.steps[7].data;
    expect(() => validateJournalIdentity(tamperedStep)).to.throw('exact plan');

    const falseComplete = exactJournal();
    falseComplete.complete = true;
    expect(() => validateJournalIdentity(falseComplete)).to.throw('confirmed receipts');
  });

  it('serializes a public journal without key-shaped fields and rejects forbidden values', () => {
    const journal = exactJournal();
    const serialized = serializeBootstrapJournal(journal, [
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    expect(serialized).not.to.match(/private.?key/i);
    expect(serialized).to.contain(RED_MM_MAKER);
    expect(() => serializeBootstrapJournal(journal, [RED_MM_MAKER])).to.throw('private key material');
  });

  it('does not persist signed transaction bytes', () => {
    const serialized = serializeBootstrapJournal(exactJournal());
    expect(serialized).not.to.contain('signedTransaction');
    expect(serialized).not.to.contain('rawTransaction');
    expect(serialized).not.to.contain('mnemonic');
  });
});
