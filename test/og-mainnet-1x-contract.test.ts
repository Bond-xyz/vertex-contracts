import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { ethers, network } from 'hardhat';
import { PERPDEX_NETWORK_PROFILES } from '../scripts/deployment-config';

// Contract-level proof of the og-mainnet 1x launch weights against the audited
// BaseEngine health math (perp contribution + spot quote collateral Q).
const PRODUCT_ID = 2;
const INITIAL = 0;
const MAINTENANCE = 1;
const PRICE = utils.parseUnits('100000', 18);
const ONE = utils.parseUnits('1', 18);
const INT128_MIN = BigNumber.from(2).pow(127).mul(-1);
const weights = PERPDEX_NETWORK_PROFILES['og-mainnet'].riskModel.weights;

async function deployEngines(shortWeightInitial = weights.shortWeightInitial) {
  const [owner, sequencer] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory('MockERC20')).deploy('USDC.e', 'USDC.e', 6);
  const sanctions = await (await ethers.getContractFactory('MockSanctionsList')).deploy();
  const liq = await (await ethers.getContractFactory('ClearinghouseLiq')).deploy();
  const verifier = await (await ethers.getContractFactory('Verifier')).deploy();
  const endpoint = await (await ethers.getContractFactory('Endpoint')).deploy();
  const clearinghouse = await (await ethers.getContractFactory('Clearinghouse')).deploy();
  const spot = await (await ethers.getContractFactory('SpotEngineReleaseHarness')).deploy();
  const perp = await (await ethers.getContractFactory('PerpEngineReleaseHarness')).deploy();
  const exchange = await (await ethers.getContractFactory('OffchainExchange')).deploy();
  await clearinghouse.initialize(endpoint.address, token.address, liq.address, 0);
  await clearinghouse.addEngine(spot.address, exchange.address, 0);
  await clearinghouse.addEngine(perp.address, exchange.address, 1);
  await exchange.initialize(clearinghouse.address, endpoint.address);
  await endpoint.initialize(
    sanctions.address,
    sequencer.address,
    exchange.address,
    clearinghouse.address,
    verifier.address,
    [ONE, 0, PRICE]
  );
  const book = await (await ethers.getContractFactory('VirtualBook')).deploy(PRODUCT_ID);
  await perp.addProduct(PRODUCT_ID, book.address, utils.parseUnits('0.001', 18), utils.parseUnits('0.001', 18), 0, {
    ...weights,
    shortWeightInitial,
    priceX18: PRICE,
  });
  return { owner, clearinghouse, perp };
}

const subaccount = (n: number) => utils.hexZeroPad(utils.hexlify(n), 32);
const notional = (amountX18: BigNumber, price = PRICE) => amountX18.mul(price).div(ONE);

describe('0G mainnet 1x launch weights (contract health math)', () => {
  it('regresses the 2e9 short-weight sentinel: a perp short would return int128.min health', async () => {
    const { perp } = await deployEngines(2_000_000_000);
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(1), ONE.mul(-1), PRICE);
    expect(await perp.getHealthContribution(subaccount(1), INITIAL)).to.equal(INT128_MIN);

    const pinned = await deployEngines();
    await pinned.perp.setBalanceForTest(PRODUCT_ID, subaccount(1), ONE.mul(-1), PRICE);
    expect(await pinned.perp.getHealthContribution(subaccount(1), INITIAL)).not.to.equal(INT128_MIN);
  });

  it('holds a long at exactly the 1x initial-health boundary and rejects anything above it', async () => {
    const { perp } = await deployEngines();
    const collateral = PRICE;
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(1), ONE, notional(ONE).mul(-1));
    expect(collateral.add(await perp.getHealthContribution(subaccount(1), INITIAL))).to.equal(0);
    const over = ONE.add(utils.parseUnits('0.001', 18));
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(2), over, notional(over).mul(-1));
    expect(collateral.add(await perp.getHealthContribution(subaccount(2), INITIAL)).lt(0)).to.equal(true);
  });

  it('caps shorts strictly below 1x and rejects a full 1x or larger short', async () => {
    const { perp } = await deployEngines();
    const collateral = PRICE;
    // 1 / 1.000000001 of collateral is the largest short that keeps initial health >= 0.
    const underOne = ONE.mul(1_000_000_000).div(1_000_000_001);
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(1), underOne.mul(-1), notional(underOne));
    expect(collateral.add(await perp.getHealthContribution(subaccount(1), INITIAL)).gte(0)).to.equal(true);
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(2), ONE.mul(-1), notional(ONE));
    expect(collateral.add(await perp.getHealthContribution(subaccount(2), INITIAL)).lt(0)).to.equal(true);
  });

  it('makes a 1x short liquidatable at a +33.3% price move (50% maintenance margin)', async () => {
    const { perp } = await deployEngines();
    const collateral = PRICE;
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(1), ONE.mul(-1), notional(ONE));
    await perp.setPriceForTest(PRODUCT_ID, PRICE.mul(133).div(100));
    expect(collateral.add(await perp.getHealthContribution(subaccount(1), MAINTENANCE)).gt(0)).to.equal(true);
    await perp.setPriceForTest(PRODUCT_ID, PRICE.mul(4).div(3).add(1));
    expect(collateral.add(await perp.getHealthContribution(subaccount(1), MAINTENANCE)).lt(0)).to.equal(true);
  });

  it('socializes bad debt across open interest when insurance is zero', async () => {
    const { clearinghouse, perp } = await deployEngines();
    expect(await clearinghouse.getInsurance()).to.equal(0);
    const badDebt = utils.parseUnits('100', 18);
    const openInterest = utils.parseUnits('10', 18);
    await perp.setExitTotalsForTest(PRODUCT_ID, openInterest, 0, 0);
    await perp.setBalanceForTest(PRODUCT_ID, subaccount(9), 0, badDebt.mul(-1));
    await network.provider.request({ method: 'hardhat_impersonateAccount', params: [clearinghouse.address] });
    await network.provider.send('hardhat_setBalance', [clearinghouse.address, '0xde0b6b3a7640000']);
    const asClearinghouse = perp.connect(await ethers.getSigner(clearinghouse.address));
    expect(await asClearinghouse.callStatic.socializeSubaccount(subaccount(9), 0)).to.equal(0);
    await asClearinghouse.socializeSubaccount(subaccount(9), 0);
    await network.provider.request({ method: 'hardhat_stopImpersonatingAccount', params: [clearinghouse.address] });
    const state = await perp.getStateAndBalance(PRODUCT_ID, subaccount(9));
    const fundingPerShare = badDebt.mul(ONE).div(openInterest).div(2);
    expect(state[0].cumulativeFundingLongX18).to.equal(fundingPerShare);
    expect(state[0].cumulativeFundingShortX18).to.equal(fundingPerShare.mul(-1));
    expect(state[1].vQuoteBalance).to.equal(0);
    expect(await clearinghouse.getInsurance()).to.equal(0);
  });
});
