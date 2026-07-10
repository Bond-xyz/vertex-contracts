import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { BigNumber, Contract, Wallet, utils } from 'ethers';
import fs from 'fs';
import path from 'path';
import {
  publicPoint,
  signSchnorrForTest,
  subaccountFor,
} from './helpers/schnorr';

const TEST_VERIFIER_KEYS = [
  `0x${'11'.repeat(32)}`,
  `0x${'22'.repeat(32)}`,
  `0x${'33'.repeat(32)}`,
];

const zeroPoint = { x: BigNumber.from(0), y: BigNumber.from(0) };

async function deployEndpointFixture(): Promise<{
  endpoint: Contract;
  token: Contract;
  clearinghouse: Contract;
  sequencer: any;
  user: any;
}> {
  const [deployer, sequencer, user] = await ethers.getSigners();
  const Token = await ethers.getContractFactory('MockERC20');
  const token = await Token.deploy('Bond Test USD', 'USDC.e', 6);
  await token.deployed();

  const Spot = await ethers.getContractFactory('MockSpotEngineForEndpoint');
  const spot = await Spot.deploy(token.address);
  await spot.deployed();

  const Clearinghouse = await ethers.getContractFactory(
    'MockClearinghouseForEndpoint',
  );
  const clearinghouse = await Clearinghouse.deploy(token.address, spot.address);
  await clearinghouse.deployed();

  const Sanctions = await ethers.getContractFactory('MockSanctionsList');
  const sanctions = await Sanctions.deploy();
  await sanctions.deployed();

  const Verifier = await ethers.getContractFactory('Verifier');
  const verifier = await Verifier.deploy();
  await verifier.deployed();
  const points = TEST_VERIFIER_KEYS.map(publicPoint);
  await verifier.initialize([
    ...points,
    zeroPoint,
    zeroPoint,
    zeroPoint,
    zeroPoint,
    zeroPoint,
  ]);

  const Endpoint = await ethers.getContractFactory('Endpoint');
  const endpoint = await Endpoint.deploy();
  await endpoint.deployed();
  await endpoint.initialize(
    sanctions.address,
    sequencer.address,
    ethers.constants.AddressZero,
    clearinghouse.address,
    verifier.address,
    [utils.parseUnits('1', 18), 0, utils.parseUnits('100000', 18)],
  );

  await token.transfer(user.address, 10_000_000);
  return { endpoint, token, clearinghouse, sequencer, user };
}

function signedBatchPayload(idx: number, transactions: string[]) {
  let digest = utils.keccak256(
    utils.defaultAbiCoder.encode(['uint64'], [idx]),
  );
  for (const transaction of transactions) {
    digest = utils.keccak256(utils.solidityPack(['bytes32', 'bytes'], [digest, transaction]));
  }
  return { digest, ...signSchnorrForTest(TEST_VERIFIER_KEYS, digest) };
}

describe('Galileo audited-base release gates', () => {
  it('keeps audited transaction ordinals and omits UpdatePerpBalance', async () => {
    const Harness = await ethers.getContractFactory('TransactionOrdinalHarness');
    const harness = await Harness.deploy();
    const ordinals = await harness.keyOrdinals();
    expect(ordinals.map((value: BigNumber | number) => Number(value))).to.deep.equal([
      1, 2, 4, 6, 15, 23, 24,
    ]);

    const source = fs.readFileSync(
      path.join(__dirname, '..', 'contracts', 'interfaces', 'IEndpoint.sol'),
      'utf8',
    );
    expect(source).not.to.contain('UpdatePerpBalance');
  });

  it('exposes only the quorum-signed batch ABI and enforces signer plus index', async () => {
    const { endpoint, sequencer } = await deployEndpointFixture();
    expect(
      endpoint.interface.functions[
        'submitTransactionsChecked(uint64,bytes[],bytes32,bytes32)'
      ],
    ).not.to.equal(undefined);
    expect(
      endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[])'],
    ).to.equal(undefined);

    const updatePrice = utils.hexConcat([
      '0x04',
      utils.defaultAbiCoder.encode(
        ['tuple(uint32 productId,int128 priceX18)'],
        [[2, utils.parseUnits('101000', 18)]],
      ),
    ]);
    const signed = signedBatchPayload(0, [updatePrice]);

    await expect(
      endpoint.submitTransactionsChecked(0, [updatePrice], signed.e, signed.s),
    ).to.be.reverted;
    await expect(
      endpoint
        .connect(sequencer)
        .submitTransactionsChecked(0, [updatePrice], ethers.constants.HashZero, signed.s),
    ).to.be.reverted;
    await endpoint
      .connect(sequencer)
      .submitTransactionsChecked(0, [updatePrice], signed.e, signed.s);
    expect(await endpoint.nSubmissions()).to.equal(1);

    await expect(
      endpoint
        .connect(sequencer)
        .submitTransactionsChecked(0, [updatePrice], signed.e, signed.s),
    ).to.be.reverted;
  });

  it('rejects unsigned orders and accepts the wallet or linked signer', async () => {
    const [owner] = await ethers.getSigners();
    const Time = await ethers.getContractFactory('MockEndpointTime');
    const time = await Time.deploy(1);
    const Exchange = await ethers.getContractFactory(
      'OffchainExchangeReleaseHarness',
    );
    const exchange = await Exchange.deploy();
    await exchange.initializeForTest(time.address);

    const wallet = Wallet.createRandom();
    const linked = Wallet.createRandom();
    const digest = utils.keccak256(utils.toUtf8Bytes('signed-order-gate'));
    const order = {
      sender: subaccountFor(wallet),
      priceX18: utils.parseUnits('100', 18),
      amount: utils.parseUnits('1', 18),
      expiration: 1_000_000,
      nonce: 7,
    };

    const walletSignature = utils.joinSignature(wallet._signingKey().signDigest(digest));
    const linkedSignature = utils.joinSignature(linked._signingKey().signDigest(digest));
    await expect(
      exchange.validateOrderForTest(
        { order, signature: '0x' },
        digest,
        ethers.constants.AddressZero,
      ),
    ).to.be.revertedWith('ECDSA: invalid signature length');
    expect(
      await exchange.validateOrderForTest(
        { order, signature: walletSignature },
        digest,
        ethers.constants.AddressZero,
      ),
    ).to.equal(true);
    expect(
      await exchange.validateOrderForTest(
        { order, signature: linkedSignature },
        digest,
        linked.address,
      ),
    ).to.equal(true);
    expect(owner.address).not.to.equal(wallet.address);
  });

  it('emits Bond deposit provenance and queues the exact audited deposit ordinal', async () => {
    const { endpoint, token, clearinghouse, user } = await deployEndpointFixture();
    const amount = 2_500_000;
    const subaccountName = utils.hexZeroPad(utils.hexlify(7), 12);
    const subaccount = utils.hexConcat([user.address, subaccountName]);
    await token.connect(user).approve(endpoint.address, amount);

    await expect(
      endpoint
        .connect(user)
        ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](
          subaccountName,
          0,
          amount,
          'bond-testnet',
        ),
    )
      .to.emit(endpoint, 'DepositCollateralWithReferral')
      .withArgs(subaccount, 0, amount, 'bond-testnet');

    expect(await token.balanceOf(endpoint.address)).to.equal(0);
    expect(await token.balanceOf(clearinghouse.address)).to.equal(amount);
    const queued = await endpoint.getSlowModeTx(0);
    expect(utils.hexDataSlice(queued[0].tx, 0, 1)).to.equal('0x01');
    expect(queued[2]).to.equal(1);
  });

  it('fresh-deploys and wires the full audited contract graph without old proxies', async () => {
    const [deployer, sequencer] = await ethers.getSigners();
    const deployShell = async (
      name: string,
      unsafeAllow: ('delegatecall')[] = [],
    ) => {
      const factory = await ethers.getContractFactory(name);
      const proxy = await upgrades.deployProxy(factory, [], {
        initializer: false,
        kind: 'transparent',
        unsafeAllow,
      });
      await proxy.deployed();
      return proxy;
    };

    const Token = await ethers.getContractFactory('MockERC20');
    const token = await Token.deploy('Bond Test USD', 'USDC.e', 6);
    const Sanctions = await ethers.getContractFactory('MockSanctionsList');
    const sanctions = await Sanctions.deploy();
    const Liq = await ethers.getContractFactory('ClearinghouseLiq');
    const liq = await Liq.deploy();
    const verifier = await deployShell('Verifier');
    const endpoint = await deployShell('Endpoint');
    const clearinghouse = await deployShell('Clearinghouse', ['delegatecall']);
    const spot = await deployShell('SpotEngine');
    const perp = await deployShell('PerpEngine');
    const exchange = await deployShell('OffchainExchange');

    await verifier.initialize([
      ...TEST_VERIFIER_KEYS.map(publicPoint),
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
    ]);
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
      [utils.parseUnits('1', 18), 0, utils.parseUnits('100000', 18)],
    );

    const Book = await ethers.getContractFactory('VirtualBook');
    const book = await Book.deploy(2);
    await perp.addProduct(
      2,
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
      },
    );

    expect(await endpoint.getSequencer()).to.equal(sequencer.address);
    expect(await clearinghouse.getEngineByType(0)).to.equal(spot.address);
    expect(await clearinghouse.getEngineByProduct(2)).to.equal(perp.address);
    expect(await exchange.getVirtualBook(2)).to.equal(book.address);
    expect(await perp.owner()).to.equal(deployer.address);
    expect(await endpoint.getVersion()).to.equal(27);
  });
});
