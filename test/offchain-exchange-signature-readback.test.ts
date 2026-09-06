import { expect } from 'chai';
import { ethers } from 'hardhat';
import { utils } from 'ethers';

describe('OffchainExchange.orderSignaturesEnforced readback', function () {
  it('answers true on the settlement start-up selector 0x3e6f0787', async function () {
    const factory = await ethers.getContractFactory('OffchainExchange');
    const exchange = await factory.deploy();
    await exchange.deployed();
    const selector = utils.id('orderSignaturesEnforced()').slice(0, 10);
    expect(selector).to.equal('0x3e6f0787');
    expect(await exchange.orderSignaturesEnforced()).to.equal(true);
    const raw = await ethers.provider.call({ to: exchange.address, data: selector });
    expect(utils.defaultAbiCoder.decode(['bool'], raw)[0]).to.equal(true);
  });
});
