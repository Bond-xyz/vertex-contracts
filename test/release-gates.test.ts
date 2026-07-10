import { expect } from 'chai';
import { artifacts, ethers, upgrades } from 'hardhat';
import { BigNumber, Contract, Wallet, utils } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { publicPoint, signSchnorrForTest, subaccountFor } from './helpers/schnorr';
import { GALILEO_USDCE_ADDRESS, requireGalileoUsdce } from '../scripts/deployment-config';
import {
  assertRuntimeSizeBudget,
  collectReleaseBuildEvidence,
  ENDPOINT_RUNTIME_BUDGET_BYTES,
  EIP170_MAX_RUNTIME_BYTES,
  inspectProxyDeployment,
  normalizeVerifierPublicKeys,
  RELEASE_ARTIFACTS,
  sha256File,
  verifyActiveClearinghouseLiq,
  verifyConfigFileSha256,
  verifyProxyDeployment,
  verifyRuntimeArtifact,
  verifyVerifierPublicKeys,
  verifyVirtualBookProductId,
} from '../scripts/release-evidence';

const TEST_VERIFIER_KEYS = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`];

const zeroPoint = { x: BigNumber.from(0), y: BigNumber.from(0) };

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

async function deployEndpointFixture(useTransferTaxToken?: boolean): Promise<{
  endpoint: Contract;
  token: Contract;
  clearinghouse: Contract;
  sequencer: any;
  user: any;
}> {
  const [deployer, sequencer, user] = await ethers.getSigners();
  const Token = await ethers.getContractFactory(useTransferTaxToken ? 'TransferTaxMockERC20' : 'MockERC20');
  const token = useTransferTaxToken ? await Token.deploy() : await Token.deploy('Bond Test USD', 'USDC.e', 6);
  await token.deployed();

  const Spot = await ethers.getContractFactory('MockSpotEngineForEndpoint');
  const spot = await Spot.deploy(token.address);
  await spot.deployed();

  const Clearinghouse = await ethers.getContractFactory('MockClearinghouseForEndpoint');
  const clearinghouse = await Clearinghouse.deploy(token.address, spot.address);
  await clearinghouse.deployed();

  const Sanctions = await ethers.getContractFactory('MockSanctionsList');
  const sanctions = await Sanctions.deploy();
  await sanctions.deployed();

  const Verifier = await ethers.getContractFactory('Verifier');
  const verifier = await Verifier.deploy();
  await verifier.deployed();
  const points = TEST_VERIFIER_KEYS.map(publicPoint);
  await verifier.initialize([...points, zeroPoint, zeroPoint, zeroPoint, zeroPoint, zeroPoint]);

  const Endpoint = await ethers.getContractFactory('Endpoint');
  const endpoint = await Endpoint.deploy();
  await endpoint.deployed();
  await endpoint.initialize(
    sanctions.address,
    sequencer.address,
    ethers.constants.AddressZero,
    clearinghouse.address,
    verifier.address,
    [utils.parseUnits('1', 18), 0, utils.parseUnits('100000', 18)]
  );

  await token.transfer(user.address, 10_000_000);
  return { endpoint, token, clearinghouse, sequencer, user };
}

function signedBatchPayload(idx: number, transactions: string[]) {
  let digest = utils.keccak256(utils.defaultAbiCoder.encode(['uint64'], [idx]));
  for (const transaction of transactions) {
    digest = utils.keccak256(utils.solidityPack(['bytes32', 'bytes'], [digest, transaction]));
  }
  return { digest, ...signSchnorrForTest(TEST_VERIFIER_KEYS, digest) };
}

describe('Galileo audited-base release gates', () => {
  it('records reviewed compiler/runtime hashes and enforces the Endpoint size budget', async () => {
    const build = await collectReleaseBuildEvidence(artifacts);
    expect(build.compiler.solcVersion).to.equal('0.8.13');
    expect(build.compiler.settingsSha256).to.match(/^[0-9a-f]{64}$/);
    expect(build.artifacts.endpoint.fullyQualifiedName).to.equal(RELEASE_ARTIFACTS.endpoint);
    expect(build.artifacts.endpoint.runtimeCodeHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(build.artifacts.endpoint.runtimeByteLength).to.be.lessThan(ENDPOINT_RUNTIME_BUDGET_BYTES);
    expect(ENDPOINT_RUNTIME_BUDGET_BYTES).to.be.lessThan(EIP170_MAX_RUNTIME_BYTES);
    expect(() =>
      assertRuntimeSizeBudget(
        'oversized endpoint fixture',
        `0x${'00'.repeat(ENDPOINT_RUNTIME_BUDGET_BYTES)}`,
        ENDPOINT_RUNTIME_BUDGET_BYTES
      )
    ).to.throw('hard budget');
    expect(build.artifacts.transparentUpgradeableProxy.runtimeCodeHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(build.artifacts.proxyAdmin.runtimeCodeHash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it('recomputes product and verifier config hashes and rejects changed evidence', () => {
    const productsFile = path.join(__dirname, '..', 'config', 'galileo.products.json');
    const productsHash = sha256File(productsFile);
    expect(verifyConfigFileSha256(productsFile, productsHash, 'product config')).to.equal(productsHash);
    expect(() => verifyConfigFileSha256(productsFile, '00'.repeat(32), 'product config')).to.throw(
      'product config SHA-256 mismatch'
    );

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-verifier-config-'));
    const verifierFile = path.join(tempDirectory, 'verifier-public-keys.json');
    try {
      fs.writeFileSync(verifierFile, JSON.stringify({ chainId: 16602, signerBitmask: 7, keys: [] }));
      const verifierHash = sha256File(verifierFile);
      expect(verifyConfigFileSha256(verifierFile, verifierHash, 'verifier public-key config')).to.equal(verifierHash);
      expect(() => verifyConfigFileSha256(verifierFile, 'ff'.repeat(32), 'verifier public-key config')).to.throw(
        'verifier public-key config SHA-256 mismatch'
      );
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('pins the only accepted Galileo collateral address', () => {
    expect(requireGalileoUsdce()).to.equal(GALILEO_USDCE_ADDRESS);
    expect(requireGalileoUsdce(GALILEO_USDCE_ADDRESS.toLowerCase())).to.equal(GALILEO_USDCE_ADDRESS);
    expect(() => requireGalileoUsdce(ethers.constants.AddressZero)).to.throw('substitutes are forbidden');
  });

  it('keeps audited transaction ordinals and omits UpdatePerpBalance', async () => {
    const Harness = await ethers.getContractFactory('TransactionOrdinalHarness');
    const harness = await Harness.deploy();
    const ordinals = await harness.keyOrdinals();
    expect(ordinals.map((value: BigNumber | number) => Number(value))).to.deep.equal([1, 2, 4, 6, 15, 23, 24]);

    const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'interfaces', 'IEndpoint.sol'), 'utf8');
    expect(source).not.to.contain('UpdatePerpBalance');
  });

  it('records all eight verifier slots and rejects wrong or mutated live keys', async () => {
    const Verifier = await ethers.getContractFactory('Verifier');
    const verifier = await Verifier.deploy();
    await verifier.deployed();
    const expected = normalizeVerifierPublicKeys([
      ...TEST_VERIFIER_KEYS.map(publicPoint),
      ...Array.from({ length: 5 }, () => zeroPoint),
    ]);
    await verifier.initialize(expected);

    expect(await verifyVerifierPublicKeys(verifier, expected)).to.deep.equal(expected);
    expect(expected).to.have.length(8);
    for (const point of expected) {
      expect(point.x).to.match(/^0x[0-9a-f]{64}$/);
      expect(point.y).to.match(/^0x[0-9a-f]{64}$/);
    }

    const wrongExpected = expected.map((point) => ({ ...point }));
    wrongExpected[1] = normalizeVerifierPublicKeys([
      zeroPoint,
      publicPoint(`0x${'44'.repeat(32)}`),
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
    ])[1];
    await expectFailure(verifyVerifierPublicKeys(verifier, wrongExpected), 'verifier public key slot 1 mismatch');

    const mutated = publicPoint(`0x${'55'.repeat(32)}`);
    await verifier.assignPubKey(7, mutated.x, mutated.y);
    await expectFailure(verifyVerifierPublicKeys(verifier, expected), 'verifier public key slot 7 mismatch');
  });

  it('exposes only the quorum-signed batch ABI and enforces signer plus index', async () => {
    const { endpoint, sequencer } = await deployEndpointFixture();
    expect(endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[],bytes32,bytes32)']).not.to.equal(
      undefined
    );
    expect(endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[])']).to.equal(undefined);

    const updatePrice = utils.hexConcat([
      '0x04',
      utils.defaultAbiCoder.encode(['tuple(uint32 productId,int128 priceX18)'], [[2, utils.parseUnits('101000', 18)]]),
    ]);
    const signed = signedBatchPayload(0, [updatePrice]);

    await expect(endpoint.submitTransactionsChecked(0, [updatePrice], signed.e, signed.s)).to.be.reverted;
    await expect(
      endpoint.connect(sequencer).submitTransactionsChecked(0, [updatePrice], ethers.constants.HashZero, signed.s)
    ).to.be.reverted;
    await endpoint.connect(sequencer).submitTransactionsChecked(0, [updatePrice], signed.e, signed.s);
    expect(await endpoint.nSubmissions()).to.equal(1);

    await expect(endpoint.connect(sequencer).submitTransactionsChecked(0, [updatePrice], signed.e, signed.s)).to.be
      .reverted;
  });

  it('rejects unsigned orders and accepts the wallet or linked signer', async () => {
    const [owner] = await ethers.getSigners();
    const Time = await ethers.getContractFactory('MockEndpointTime');
    const time = await Time.deploy(1);
    const Exchange = await ethers.getContractFactory('OffchainExchangeReleaseHarness');
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
      exchange.validateOrderForTest({ order, signature: '0x' }, digest, ethers.constants.AddressZero)
    ).to.be.revertedWith('ECDSA: invalid signature length');
    expect(
      await exchange.validateOrderForTest({ order, signature: walletSignature }, digest, ethers.constants.AddressZero)
    ).to.equal(true);
    expect(await exchange.validateOrderForTest({ order, signature: linkedSignature }, digest, linked.address)).to.equal(
      true
    );
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
        ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](subaccountName, 0, amount, 'bond-testnet')
    )
      .to.emit(endpoint, 'DepositCollateralWithReferral')
      .withArgs(subaccount, 0, amount, 'bond-testnet');

    expect(await token.balanceOf(endpoint.address)).to.equal(0);
    expect(await token.balanceOf(clearinghouse.address)).to.equal(amount);
    const queued = await endpoint.getSlowModeTx(0);
    expect(utils.hexDataSlice(queued[0].tx, 0, 1)).to.equal('0x01');
    expect(queued[2]).to.equal(1);
  });

  it('rejects non-quote collateral and any inexact custody transfer', async () => {
    const standard = await deployEndpointFixture();
    const amount = 2_500_000;
    const subaccountName = utils.hexZeroPad(utils.hexlify(7), 12);
    await standard.token.connect(standard.user).approve(standard.endpoint.address, amount);
    await expect(
      standard.endpoint
        .connect(standard.user)
        ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](subaccountName, 1, amount, 'bond-testnet')
    ).to.be.revertedWith('IP');
    expect(await standard.token.balanceOf(standard.clearinghouse.address)).to.equal(0);

    const taxed = await deployEndpointFixture(true);
    const userBalanceBefore = await taxed.token.balanceOf(taxed.user.address);
    await taxed.token.connect(taxed.user).approve(taxed.endpoint.address, amount);
    await expect(
      taxed.endpoint
        .connect(taxed.user)
        ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](subaccountName, 0, amount, 'bond-testnet')
    ).to.be.revertedWith('TF');
    expect(await taxed.token.balanceOf(taxed.user.address)).to.equal(userBalanceBefore);
    expect(await taxed.token.balanceOf(taxed.clearinghouse.address)).to.equal(0);
  });

  it('prevents any post-deploy replacement of the product-zero token', async () => {
    const [owner] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('MockERC20');
    const quote = await Token.deploy('Bond Test USD', 'USDC.e', 6);
    const substitute = await Token.deploy('Substitute USD', 'FAKE', 6);
    const Spot = await ethers.getContractFactory('SpotEngine');
    const spot = await Spot.deploy();
    await spot.initialize(owner.address, owner.address, quote.address, owner.address, owner.address);

    const encodeUpdate = (token: string) =>
      utils.defaultAbiCoder.encode(
        [
          'tuple(uint32 productId,int128 sizeIncrement,int128 minSize,int128 lpSpreadX18,tuple(address token,int128 interestInflectionUtilX18,int128 interestFloorX18,int128 interestSmallCapX18,int128 interestLargeCapX18) config,tuple(int32 longWeightInitial,int32 shortWeightInitial,int32 longWeightMaintenance,int32 shortWeightMaintenance,int128 priceX18) riskStore)',
        ],
        [
          {
            productId: 0,
            sizeIncrement: 0,
            minSize: 0,
            lpSpreadX18: 0,
            config: {
              token,
              interestInflectionUtilX18: 0,
              interestFloorX18: 0,
              interestSmallCapX18: 0,
              interestLargeCapX18: 0,
            },
            riskStore: {
              longWeightInitial: 0,
              shortWeightInitial: 0,
              longWeightMaintenance: 0,
              shortWeightMaintenance: 0,
              priceX18: 0,
            },
          },
        ]
      );

    await expect(spot.updateProduct(encodeUpdate(substitute.address))).to.be.revertedWith('BPC');
    await spot.updateProduct(encodeUpdate(quote.address));
    expect(await spot.getToken(0)).to.equal(quote.address);
  });

  it('rejects a Clearinghouse whose active liquidation target differs from the manifest', async () => {
    const [owner] = await ethers.getSigners();
    const Liq = await ethers.getContractFactory('ClearinghouseLiq');
    const manifestLiq = await Liq.deploy();
    const wrongActiveLiq = await Liq.deploy();
    await manifestLiq.deployed();
    await wrongActiveLiq.deployed();
    const Clearinghouse = await ethers.getContractFactory('Clearinghouse');
    const clearinghouse = await Clearinghouse.deploy();
    await clearinghouse.deployed();
    await clearinghouse.initialize(owner.address, owner.address, wrongActiveLiq.address, 0);

    const build = await collectReleaseBuildEvidence(artifacts);
    const manifestRuntimeCodeHash = await verifyRuntimeArtifact(
      ethers.provider,
      manifestLiq.address,
      build.artifacts.clearinghouseLiq,
      'manifest liquidation implementation'
    );
    await expectFailure(
      verifyActiveClearinghouseLiq(
        ethers.provider,
        clearinghouse,
        { address: manifestLiq.address, runtimeCodeHash: manifestRuntimeCodeHash },
        build.artifacts.clearinghouseLiq
      ),
      'active ClearinghouseLiq target mismatch'
    );
  });

  it('binds each VirtualBook runtime to its manifest product ID', async () => {
    const Book = await ethers.getContractFactory('VirtualBook');
    const book = await Book.deploy(2);
    await book.deployed();

    await verifyVirtualBookProductId(ethers.provider, book.address, 2, 'BTC virtual book');
    await expectFailure(
      verifyVirtualBookProductId(ethers.provider, book.address, 4, 'BTC virtual book'),
      'BTC virtual book productId mismatch'
    );
  });

  it('fresh-deploys and wires the full audited contract graph without old proxies', async () => {
    const [deployer, sequencer, user] = await ethers.getSigners();
    const deployShell = async (name: string, unsafeAllow: 'delegatecall'[] = []) => {
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
    await token.transfer(user.address, 10_000_000);
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

    const build = await collectReleaseBuildEvidence(artifacts);
    for (const [key, contract] of [
      ['verifier', verifier],
      ['endpoint', endpoint],
      ['clearinghouse', clearinghouse],
      ['spotEngine', spot],
      ['perpEngine', perp],
      ['offchainExchange', exchange],
    ] as const) {
      const inspected = await inspectProxyDeployment(ethers.provider, contract.address);
      expect(inspected.implementation).to.equal(await upgrades.erc1967.getImplementationAddress(contract.address));
      expect(inspected.admin).to.equal(await upgrades.erc1967.getAdminAddress(contract.address));
      await verifyProxyDeployment(
        ethers.provider,
        inspected,
        build.artifacts[key],
        build.artifacts.transparentUpgradeableProxy,
        build.artifacts.proxyAdmin,
        key
      );
    }

    const verifierPublicKeys = normalizeVerifierPublicKeys([
      ...TEST_VERIFIER_KEYS.map(publicPoint),
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
      zeroPoint,
    ]);
    await verifier.initialize(verifierPublicKeys);
    await verifyVerifierPublicKeys(verifier, verifierPublicKeys);
    await clearinghouse.initialize(endpoint.address, token.address, liq.address, 0);
    const clearinghouseLiqRuntimeCodeHash = await verifyRuntimeArtifact(
      ethers.provider,
      liq.address,
      build.artifacts.clearinghouseLiq,
      'clearinghouse liquidation implementation'
    );
    await verifyActiveClearinghouseLiq(
      ethers.provider,
      clearinghouse,
      { address: liq.address, runtimeCodeHash: clearinghouseLiqRuntimeCodeHash },
      build.artifacts.clearinghouseLiq
    );
    await clearinghouse.addEngine(spot.address, exchange.address, 0);
    await clearinghouse.addEngine(perp.address, exchange.address, 1);
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
    const book = await Book.deploy(2);
    await verifyVirtualBookProductId(ethers.provider, book.address, 2, 'BTC virtual book');
    const virtualBookRuntimeHash = await verifyRuntimeArtifact(
      ethers.provider,
      book.address,
      build.artifacts.virtualBook,
      'BTC virtual book'
    );
    expect(build.artifacts.virtualBook.immutableReferences).to.have.length(1);
    await verifyRuntimeArtifact(
      ethers.provider,
      book.address,
      build.artifacts.virtualBook,
      'BTC virtual book',
      virtualBookRuntimeHash
    );
    await perp.addProduct(2, book.address, utils.parseUnits('0.001', 18), utils.parseUnits('0.001', 18), 0, {
      longWeightInitial: 950_000_000,
      shortWeightInitial: 1_050_000_000,
      longWeightMaintenance: 975_000_000,
      shortWeightMaintenance: 1_025_000_000,
      priceX18: utils.parseUnits('100000', 18),
    });

    expect(await endpoint.getSequencer()).to.equal(sequencer.address);
    expect(await clearinghouse.getEngineByType(0)).to.equal(spot.address);
    expect(await clearinghouse.getEngineByProduct(2)).to.equal(perp.address);
    expect(await exchange.getVirtualBook(2)).to.equal(book.address);
    expect(await perp.owner()).to.equal(deployer.address);
    expect(await endpoint.getVersion()).to.equal(27);

    const depositAmount = 5_000_000;
    const withdrawAmount = 1_000_000;
    const subaccountName = utils.hexZeroPad(utils.hexlify(9), 12);
    const subaccount = utils.hexConcat([user.address, subaccountName]);
    await token.connect(user).approve(endpoint.address, depositAmount);
    await endpoint
      .connect(user)
      ['depositCollateralWithReferral(bytes12,uint32,uint128,string)'](
        subaccountName,
        0,
        depositAmount,
        'bond-testnet'
      );
    expect(await token.balanceOf(clearinghouse.address)).to.equal(depositAmount);

    const executeSlowMode = '0x08';
    const executeSigned = signedBatchPayload(0, [executeSlowMode]);
    await endpoint.connect(sequencer).submitTransactionsChecked(0, [executeSlowMode], executeSigned.e, executeSigned.s);
    expect((await spot.getBalance(0, subaccount)).amount).to.equal(utils.parseUnits('5', 18));

    const withdraw = {
      sender: subaccount,
      productId: 0,
      amount: withdrawAmount,
      nonce: 0,
    };
    const withdrawSignature = await user._signTypedData(
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
      withdraw
    );
    const withdrawTransaction = utils.hexConcat([
      '0x02',
      utils.defaultAbiCoder.encode(
        ['tuple(tuple(bytes32 sender,uint32 productId,uint128 amount,uint64 nonce) tx,bytes signature)'],
        [{ tx: withdraw, signature: withdrawSignature }]
      ),
    ]);
    const withdrawSigned = signedBatchPayload(1, [withdrawTransaction]);
    await expect(
      endpoint
        .connect(sequencer)
        .submitTransactionsChecked(1, [withdrawTransaction], withdrawSigned.e, withdrawSigned.s)
    )
      .to.emit(clearinghouse, 'ModifyCollateral')
      .withArgs(utils.parseUnits('-1', 18), subaccount, 0);
    expect(await token.balanceOf(clearinghouse.address)).to.equal(depositAmount - withdrawAmount);
    expect(await token.balanceOf(user.address)).to.equal(6_000_000);
    expect((await spot.getBalance(0, subaccount)).amount).to.equal(utils.parseUnits('3', 18));
  });
});
