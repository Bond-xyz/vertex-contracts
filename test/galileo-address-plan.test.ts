import { expect } from 'chai';
import { utils } from 'ethers';
import {
  createGalileoAddressPlan,
  GALILEO_FINALIZE_TRANSACTION_COUNT,
  GALILEO_PREPARE_TRANSACTION_COUNT,
} from '../scripts/create-galileo-address-plan';

describe('unsigned Galileo CREATE/address plan', () => {
  const deployer = '0xbD58414C999391F610B11F0a4BFc0037543A0e76';
  const firstNonce = 283;

  it('derives the exact 24-prepare plus 5-finalize nonce sequence', () => {
    const plan = createGalileoAddressPlan(deployer, deployer, firstNonce);
    const transactions = [...plan.preparation.transactions, ...plan.finalization.transactions];
    expect(plan.preparation.transactionCount).to.equal(GALILEO_PREPARE_TRANSACTION_COUNT);
    expect(plan.finalization.transactionCount).to.equal(GALILEO_FINALIZE_TRANSACTION_COUNT);
    expect(transactions.map((transaction) => transaction.nonce)).to.deep.equal(
      Array.from({ length: 29 }, (_, index) => firstNonce + index)
    );
    expect(plan.preparation.finalizationStartingNonce).to.equal(307);
    expect(plan.finalization.lastNonce).to.equal(311);
  });

  it('pins the reviewed CREATE offsets and call targets', () => {
    const plan = createGalileoAddressPlan(deployer, deployer, firstNonce);
    expect(plan.expectedFirstContract).to.equal('0x4c37dC1d709F41170b99664424b9b74cdA95313b');
    expect(plan.contracts.proxyAdmin.address).to.equal('0x789dd022ECAc445781A4Da2eD3A7E0139B0Cac81');
    expect(plan.contracts.endpoint.proxy).to.equal('0x60c308c77eD2C395bF58925ab1b1BEB396F9E409');
    expect(plan.contracts.perpEngine.proxy).to.equal('0x1b68EE9B32cA0194c74f081245d8a8AA8AB8141c');
    expect(plan.contracts.virtualBooks['8'].address).to.equal('0xCE91345F16086d6F97E16752AbD62090B8C36171');
    for (const transaction of plan.preparation.transactions.filter((transaction) => transaction.kind === 'CREATE')) {
      expect(transaction.address).to.equal(utils.getContractAddress({ from: deployer, nonce: transaction.nonce }));
    }
    expect(plan.finalization.transactions.map((transaction) => transaction.address)).to.deep.equal([
      plan.contracts.endpoint.proxy,
      plan.contracts.perpEngine.proxy,
      plan.contracts.perpEngine.proxy,
      plan.contracts.perpEngine.proxy,
      plan.contracts.perpEngine.proxy,
    ]);
  });

  it('rejects zero operators and unsafe nonces', () => {
    expect(() =>
      createGalileoAddressPlan(utils.getAddress('0x0000000000000000000000000000000000000000'), deployer, 0)
    ).to.throw('deployer must not be zero');
    expect(() => createGalileoAddressPlan(deployer, deployer, -1)).to.throw('first transaction nonce');
    expect(() => createGalileoAddressPlan(deployer, deployer, Number.MAX_SAFE_INTEGER)).to.throw(
      'first transaction nonce'
    );
  });
});
