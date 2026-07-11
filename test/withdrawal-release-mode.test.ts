import { expect } from 'chai';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers } from 'hardhat';
import { BigNumber, Contract, Signer, utils } from 'ethers';
import { publicPoint, signSchnorrForTest, subaccountFor } from './helpers/schnorr';

const TEST_VERIFIER_KEYS = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`];
const ZERO_POINT = { x: BigNumber.from(0), y: BigNumber.from(0) };
const QUOTE_PRODUCT_ID = 0;
const BTC_PERP_PRODUCT_ID = 2;
const THREE_DAYS = 259_200;
const SLOW_MODE_FEE_USDCE = 1_000_000;
const DIRECT_WITHDRAW_FEE_X18 = utils.parseUnits('1', 18);
const REDUCE_ONLY_BIT = BigNumber.from(1).shl(61);

type SignerWithAddress = Signer & { address: string; _signTypedData: Signer['_signTypedData'] };

async function expectFailure(promise: Promise<unknown>, expected: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(Error);
  expect((failure as Error).message).to.contain(expected);
}

function signedBatchPayload(idx: number, transactions: string[]) {
  let digest = utils.keccak256(utils.defaultAbiCoder.encode(['uint64'], [idx]));
  for (const transaction of transactions) {
    digest = utils.keccak256(utils.solidityPack(['bytes32', 'bytes'], [digest, transaction]));
  }
  return { digest, ...signSchnorrForTest(TEST_VERIFIER_KEYS, digest) };
}

async function deployReleaseFixture() {
  const [owner, sequencer, user, maker, publicExecutor, lateDepositor] =
    (await ethers.getSigners()) as SignerWithAddress[];

  const Token = await ethers.getContractFactory('MockERC20');
  const token = await Token.deploy('Bond Test USD', 'USDC.e', 6);
  const Sanctions = await ethers.getContractFactory('MockSanctionsList');
  const sanctions = await Sanctions.deploy();
  const Liq = await ethers.getContractFactory('ClearinghouseLiq');
  const clearinghouseLiq = await Liq.deploy();
  const Verifier = await ethers.getContractFactory('Verifier');
  const verifier = await Verifier.deploy();
  const Endpoint = await ethers.getContractFactory('Endpoint');
  const endpoint = await Endpoint.deploy();
  const Clearinghouse = await ethers.getContractFactory('Clearinghouse');
  const clearinghouse = await Clearinghouse.deploy();
  const SpotEngine = await ethers.getContractFactory('SpotEngineReleaseHarness');
  const spotEngine = await SpotEngine.deploy();
  const PerpEngine = await ethers.getContractFactory('PerpEngineReleaseHarness');
  const perpEngine = await PerpEngine.deploy();
  const Exchange = await ethers.getContractFactory('OffchainExchange');
  const exchange = await Exchange.deploy();

  await verifier.initialize([
    ...TEST_VERIFIER_KEYS.map(publicPoint),
    ZERO_POINT,
    ZERO_POINT,
    ZERO_POINT,
    ZERO_POINT,
    ZERO_POINT,
  ]);
  await clearinghouse.initialize(endpoint.address, token.address, clearinghouseLiq.address, 0);
  await clearinghouse.addEngine(spotEngine.address, exchange.address, 0);
  await clearinghouse.addEngine(perpEngine.address, exchange.address, 1);
  await exchange.initialize(clearinghouse.address, endpoint.address);
  await endpoint.initialize(
    sanctions.address,
    sequencer.address,
    exchange.address,
    clearinghouse.address,
    verifier.address,
    [utils.parseUnits('1', 18), 0, utils.parseUnits('100000', 18)]
  );

  const Book = await ethers.getContractFactory('VirtualBook');
  const book = await Book.deploy(BTC_PERP_PRODUCT_ID);
  await perpEngine.addProduct(
    BTC_PERP_PRODUCT_ID,
    book.address,
    utils.parseUnits('0.001', 18),
    utils.parseUnits('0.001', 18),
    0,
    {
      longWeightInitial: 950_000_000,
      shortWeightInitial: 1_050_000_000,
      longWeightMaintenance: 975_000_000,
      shortWeightMaintenance: 1_025_000_000,
      priceX18: utils.parseUnits('100000', 18),
    }
  );

  for (const account of [user, maker, lateDepositor]) {
    await token.transfer(account.address, 20_000_000);
  }

  const submitBatch = async (transactions: string[]) => {
    const idx = (await endpoint.nSubmissions()).toNumber();
    const signed = signedBatchPayload(idx, transactions);
    return endpoint.connect(sequencer).submitTransactionsChecked(idx, transactions, signed.e, signed.s);
  };

  const depositAndCredit = async (account: SignerWithAddress, amount = 10_000_000) => {
    await token.connect(account).approve(endpoint.address, amount);
    await endpoint
      .connect(account)
      ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](
        utils.hexZeroPad('0x', 12),
        QUOTE_PRODUCT_ID,
        amount,
        'bond-testnet'
      );
    await submitBatch(['0x08']);
  };

  return {
    owner,
    sequencer,
    user,
    maker,
    publicExecutor,
    lateDepositor,
    token,
    endpoint,
    clearinghouse,
    spotEngine,
    perpEngine,
    exchange,
    book,
    submitBatch,
    depositAndCredit,
  };
}

function encodeWithdraw(sender: string, amount: number, nonce: number): string {
  return utils.hexConcat([
    '0x02',
    utils.defaultAbiCoder.encode(
      ['tuple(bytes32 sender,uint32 productId,uint128 amount,uint64 nonce)'],
      [[sender, QUOTE_PRODUCT_ID, amount, nonce]]
    ),
  ]);
}

async function encodeSignedWithdraw(
  endpoint: Contract,
  signer: SignerWithAddress,
  sender: string,
  amount: number,
  nonce: number
): Promise<string> {
  const withdrawal = { sender, productId: QUOTE_PRODUCT_ID, amount, nonce };
  const signature = await signer._signTypedData(
    {
      name: 'Vertex',
      version: '0.0.1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: endpoint.address,
    },
    {
      WithdrawCollateral: [
        { name: 'sender', type: 'bytes32' },
        { name: 'productId', type: 'uint32' },
        { name: 'amount', type: 'uint128' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    withdrawal
  );
  return utils.hexConcat([
    '0x02',
    utils.defaultAbiCoder.encode(
      ['tuple(tuple(bytes32 sender,uint32 productId,uint128 amount,uint64 nonce) tx,bytes signature)'],
      [{ tx: withdrawal, signature }]
    ),
  ]);
}

type Order = {
  sender: string;
  priceX18: BigNumber;
  amount: BigNumber;
  expiration: BigNumber;
  nonce: number;
};

async function signedOrder(book: Contract, signer: SignerWithAddress, order: Order) {
  const signature = await signer._signTypedData(
    {
      name: 'Vertex',
      version: '0.0.1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: book.address,
    },
    {
      Order: [
        { name: 'sender', type: 'bytes32' },
        { name: 'priceX18', type: 'int128' },
        { name: 'amount', type: 'int128' },
        { name: 'expiration', type: 'uint64' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    order
  );
  return { order, signature };
}

function encodeMatchOrders(taker: unknown, maker: unknown): string {
  return utils.hexConcat([
    '0x06',
    utils.defaultAbiCoder.encode(
      [
        'tuple(uint32 productId,tuple(tuple(bytes32 sender,int128 priceX18,int128 amount,uint64 expiration,uint64 nonce) order,bytes signature) taker,tuple(tuple(bytes32 sender,int128 priceX18,int128 amount,uint64 expiration,uint64 nonce) order,bytes signature) maker)',
      ],
      [{ productId: BTC_PERP_PRODUCT_ID, taker, maker }]
    ),
  ]);
}

describe('Bond release modes and same-token USDC.e exit', () => {
  it('proves direct and three-day public withdrawals preserve the same token and exact fees during shutdown', async () => {
    const { owner, user, publicExecutor, token, endpoint, clearinghouse, spotEngine, submitBatch, depositAndCredit } =
      await loadFixture(deployReleaseFixture);
    const subaccount = subaccountFor(user.address);
    await depositAndCredit(user);

    expect(await spotEngine.getWithdrawFee(QUOTE_PRODUCT_ID)).to.equal(DIRECT_WITHDRAW_FEE_X18);
    expect((await spotEngine.getBalance(QUOTE_PRODUCT_ID, subaccount)).amount).to.equal(utils.parseUnits('10', 18));

    await expect(clearinghouse.connect(owner).setReleaseMode(2)).to.be.revertedWithCustomError(
      clearinghouse,
      'ExitModeRequiresCloseOnly'
    );
    await expect(clearinghouse.connect(owner).setReleaseMode(1))
      .to.emit(clearinghouse, 'ReleaseModeChanged')
      .withArgs(0, 1);
    await expect(clearinghouse.connect(owner).setReleaseMode(0)).to.be.revertedWithCustomError(
      clearinghouse,
      'ReleaseModeRegression'
    );

    await token.connect(user).approve(endpoint.address, 1_000_000);
    await expect(
      endpoint
        .connect(user)
        ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](
          utils.hexZeroPad('0x01', 12),
          QUOTE_PRODUCT_ID,
          1_000_000,
          'blocked'
        )
    ).to.be.revertedWithCustomError(endpoint, 'DepositsDisabled');

    const directAmount = 1_000_000;
    const direct = await encodeSignedWithdraw(endpoint, user, subaccount, directAmount, 0);
    await expect(submitBatch([direct]))
      .to.emit(clearinghouse, 'WithdrawalSettled')
      .withArgs(subaccount, QUOTE_PRODUCT_ID, user.address, token.address, directAmount, utils.parseUnits('-1', 18));
    expect((await spotEngine.getBalance(QUOTE_PRODUCT_ID, subaccount)).amount).to.equal(utils.parseUnits('8', 18));
    expect(await token.balanceOf(user.address)).to.equal(11_000_000);

    await spotEngine.setExitTotalsForTest(QUOTE_PRODUCT_ID, 1, 0);
    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.be.revertedWithCustomError(clearinghouse, 'ExitModeLiabilitiesRemain')
      .withArgs(QUOTE_PRODUCT_ID);
    await spotEngine.setExitTotalsForTest(QUOTE_PRODUCT_ID, 0, 1);
    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.be.revertedWithCustomError(clearinghouse, 'ExitModeLiabilitiesRemain')
      .withArgs(QUOTE_PRODUCT_ID);
    await spotEngine.setExitTotalsForTest(QUOTE_PRODUCT_ID, 0, 0);
    await spotEngine.setExitXAccountForTest(QUOTE_PRODUCT_ID, -1);
    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.be.revertedWithCustomError(clearinghouse, 'ExitModeLiabilitiesRemain')
      .withArgs(QUOTE_PRODUCT_ID);
    await spotEngine.setExitXAccountForTest(QUOTE_PRODUCT_ID, 0);
    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.emit(clearinghouse, 'ReleaseModeChanged')
      .withArgs(1, 2);

    const slowAmount = 2_000_000;
    const slowWithdrawal = encodeWithdraw(subaccount, slowAmount, 999);
    await token.connect(user).approve(endpoint.address, SLOW_MODE_FEE_USDCE);
    const userBeforeQueue = await token.balanceOf(user.address);
    const endpointBeforeQueue = await token.balanceOf(endpoint.address);
    const queue = await endpoint.connect(user).submitSlowModeTransaction(slowWithdrawal);
    const queueReceipt = await queue.wait();
    const queueBlock = await ethers.provider.getBlock(queueReceipt.blockNumber);
    const queuedIndex = 1;
    const [queued, txUpToBefore, txCount] = await endpoint.getSlowModeTx(queuedIndex);
    expect(queued.sender).to.equal(user.address);
    expect(queued.tx).to.equal(slowWithdrawal);
    expect(queued.executableAt).to.equal(queueBlock.timestamp + THREE_DAYS);
    expect(txUpToBefore).to.equal(queuedIndex);
    expect(txCount).to.equal(queuedIndex + 1);
    expect(await token.balanceOf(user.address)).to.equal(userBeforeQueue.sub(SLOW_MODE_FEE_USDCE));
    expect(await token.balanceOf(endpoint.address)).to.equal(endpointBeforeQueue.add(SLOW_MODE_FEE_USDCE));

    await expect(endpoint.connect(publicExecutor).executeSlowModeTransaction()).to.be.revertedWith('STTR');
    await time.increaseTo(queued.executableAt);
    await expect(endpoint.connect(publicExecutor).executeSlowModeTransaction())
      .to.emit(clearinghouse, 'WithdrawalSettled')
      .withArgs(subaccount, QUOTE_PRODUCT_ID, user.address, token.address, slowAmount, utils.parseUnits('-2', 18));

    expect((await spotEngine.getBalance(QUOTE_PRODUCT_ID, subaccount)).amount).to.equal(utils.parseUnits('6', 18));
    expect(await token.balanceOf(user.address)).to.equal(12_000_000);
    expect(await token.balanceOf(clearinghouse.address)).to.equal(7_000_000);
    expect(await token.balanceOf(endpoint.address)).to.equal(SLOW_MODE_FEE_USDCE);
    const [, txUpToAfter] = await endpoint.getSlowModeTx(queuedIndex);
    expect(txUpToAfter).to.equal(queuedIndex + 1);
  });

  it('enforces true close-only matching and clips oversized reduce-only fills before they can flip positions', async () => {
    const { owner, user, maker, clearinghouse, perpEngine, book, submitBatch, depositAndCredit } = await loadFixture(
      deployReleaseFixture
    );
    const userSubaccount = subaccountFor(user.address);
    const makerSubaccount = subaccountFor(maker.address);
    await depositAndCredit(user);
    await depositAndCredit(maker);

    const oracleTime = await time.latest();
    const perpTick = utils.hexConcat([
      '0x0f',
      utils.defaultAbiCoder.encode(['tuple(uint128 time,int128[] avgPriceDiffs)'], [[oracleTime, [0]]]),
    ]);
    await submitBatch([perpTick]);

    const expiration = BigNumber.from(oracleTime + 3_600);
    const price = utils.parseUnits('100000', 18);
    const activeTaker = await signedOrder(book, user, {
      sender: userSubaccount,
      priceX18: price,
      amount: utils.parseUnits('1', 18),
      expiration,
      nonce: 1,
    });
    const activeMaker = await signedOrder(book, maker, {
      sender: makerSubaccount,
      priceX18: price,
      amount: utils.parseUnits('-1', 18),
      expiration,
      nonce: 2,
    });
    await submitBatch([encodeMatchOrders(activeTaker, activeMaker)]);
    expect((await perpEngine.getBalance(BTC_PERP_PRODUCT_ID, userSubaccount)).amount).to.equal(
      utils.parseUnits('1', 18)
    );
    expect((await perpEngine.getBalance(BTC_PERP_PRODUCT_ID, makerSubaccount)).amount).to.equal(
      utils.parseUnits('-1', 18)
    );

    await clearinghouse.connect(owner).setReleaseMode(1);
    const unflaggedTaker = await signedOrder(book, user, {
      sender: userSubaccount,
      priceX18: price,
      amount: utils.parseUnits('1', 18),
      expiration,
      nonce: 3,
    });
    const unflaggedMaker = await signedOrder(book, maker, {
      sender: makerSubaccount,
      priceX18: price,
      amount: utils.parseUnits('-1', 18),
      expiration,
      nonce: 4,
    });
    await expectFailure(submitBatch([encodeMatchOrders(unflaggedTaker, unflaggedMaker)]), 'NewOrdersDisabled');

    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.be.revertedWithCustomError(clearinghouse, 'ExitModeLiabilitiesRemain')
      .withArgs(BTC_PERP_PRODUCT_ID);

    const reduceOnlyExpiration = expiration.or(REDUCE_ONLY_BIT);
    const closeTaker = await signedOrder(book, user, {
      sender: userSubaccount,
      priceX18: price,
      amount: utils.parseUnits('-10', 18),
      expiration: reduceOnlyExpiration,
      nonce: 5,
    });
    const closeMaker = await signedOrder(book, maker, {
      sender: makerSubaccount,
      priceX18: price,
      amount: utils.parseUnits('10', 18),
      expiration: reduceOnlyExpiration,
      nonce: 6,
    });
    await submitBatch([encodeMatchOrders(closeTaker, closeMaker)]);
    expect((await perpEngine.getBalance(BTC_PERP_PRODUCT_ID, userSubaccount)).amount).to.equal(0);
    expect((await perpEngine.getBalance(BTC_PERP_PRODUCT_ID, makerSubaccount)).amount).to.equal(0);

    await perpEngine.setExitTotalsForTest(BTC_PERP_PRODUCT_ID, 0, 1, 0);
    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.be.revertedWithCustomError(clearinghouse, 'ExitModeLiabilitiesRemain')
      .withArgs(BTC_PERP_PRODUCT_ID);
    await perpEngine.setExitTotalsForTest(BTC_PERP_PRODUCT_ID, 0, 0, 0);
    await perpEngine.setExitXAccountForTest(BTC_PERP_PRODUCT_ID, 0, 1);
    await expect(clearinghouse.connect(owner).setReleaseMode(2))
      .to.be.revertedWithCustomError(clearinghouse, 'ExitModeLiabilitiesRemain')
      .withArgs(BTC_PERP_PRODUCT_ID);
    await perpEngine.setExitXAccountForTest(BTC_PERP_PRODUCT_ID, 0, 0);
    await clearinghouse.connect(owner).setReleaseMode(2);
    await expectFailure(submitBatch([encodeMatchOrders(closeTaker, closeMaker)]), 'NewOrdersDisabled');
  });

  it('classifies completed and failed slow exits, preserves pre-shutdown deposits, and exposes no fake cancellation path', async () => {
    const { owner, user, lateDepositor, publicExecutor, token, endpoint, clearinghouse, spotEngine, depositAndCredit } =
      await loadFixture(deployReleaseFixture);
    await depositAndCredit(user);

    const lateSubaccount = subaccountFor(lateDepositor.address);
    await token.connect(lateDepositor).approve(endpoint.address, 3_000_000);
    await endpoint
      .connect(lateDepositor)
      ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](
        utils.hexZeroPad('0x', 12),
        QUOTE_PRODUCT_ID,
        3_000_000,
        'pre-shutdown'
      );
    const pendingDepositIndex = 1;
    const [pendingDeposit] = await endpoint.getSlowModeTx(pendingDepositIndex);
    await clearinghouse.connect(owner).setReleaseMode(1);
    await clearinghouse.connect(owner).setReleaseMode(2);
    await time.increaseTo(pendingDeposit.executableAt);
    await endpoint.connect(publicExecutor).executeSlowModeTransaction();
    expect((await spotEngine.getBalance(QUOTE_PRODUCT_ID, lateSubaccount)).amount).to.equal(utils.parseUnits('3', 18));

    const userSubaccount = subaccountFor(user.address);
    const impossibleWithdrawal = encodeWithdraw(userSubaccount, 99_000_000, 0);
    await token.connect(user).approve(endpoint.address, SLOW_MODE_FEE_USDCE);
    await endpoint.connect(user).submitSlowModeTransaction(impossibleWithdrawal);
    const failedIndex = 2;
    const [failed] = await endpoint.getSlowModeTx(failedIndex);
    const userBeforeFailure = await token.balanceOf(user.address);
    const custodyBeforeFailure = await token.balanceOf(clearinghouse.address);
    const balanceBeforeFailure = (await spotEngine.getBalance(QUOTE_PRODUCT_ID, userSubaccount)).amount;
    await time.increaseTo(failed.executableAt);
    const failedExecution = await endpoint.connect(publicExecutor).executeSlowModeTransaction();
    await expect(failedExecution).to.emit(endpoint, 'SlowModeTransactionFailed').withArgs(failedIndex);
    const failedReceipt = await failedExecution.wait();
    const withdrawalTopic = clearinghouse.interface.getEventTopic('WithdrawalSettled');
    expect(
      failedReceipt.logs.some(
        (log: { address: string; topics: string[] }) =>
          log.address.toLowerCase() === clearinghouse.address.toLowerCase() && log.topics[0] === withdrawalTopic
      )
    ).to.equal(false);
    expect(await token.balanceOf(user.address)).to.equal(userBeforeFailure);
    expect(await token.balanceOf(clearinghouse.address)).to.equal(custodyBeforeFailure);
    expect((await spotEngine.getBalance(QUOTE_PRODUCT_ID, userSubaccount)).amount).to.equal(balanceBeforeFailure);
    const [deletedFailedTx, txUpToAfterFailure] = await endpoint.getSlowModeTx(failedIndex);
    expect(deletedFailedTx.tx).to.equal('0x');
    expect(txUpToAfterFailure).to.equal(failedIndex + 1);

    expect(endpoint.interface.functions['cancelSlowModeTransaction(uint64)']).to.equal(undefined);
  });
});
