import { expect } from 'chai';
import { BigNumber, providers } from 'ethers';
import { ethers as hardhatEthers } from 'hardhat';
import {
  assertGalileoDeploymentFeePolicy,
  GalileoLegacyFeeWallet,
  galileoHardhatFeeConfig,
  loadTrackedGalileoFeePolicy,
  resolveGalileoLegacyGasPrice,
  validateGalileoFeePolicy,
  validateGalileoLiveFeeQuote,
} from '../scripts/galileo-fee-policy';

const DEFAULT_GAS_PRICE = 4_000_000_007;

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.contain(message);
}

describe('Galileo deployment fee policy', () => {
  it('binds the exact reviewed legacy bounds and rejects tracked policy drift', () => {
    const policy = loadTrackedGalileoFeePolicy();
    expect(policy.minimumGasPrice).to.equal(2_000_000_007n);
    expect(policy.defaultGasPrice).to.equal(4_000_000_007n);
    expect(policy.maximumGasPrice).to.equal(20_000_000_000n);
    expect(() => validateGalileoFeePolicy({ ...policy, defaultGasPriceWei: '4000000008' })).to.throw(
      'differ from the reviewed release policy'
    );
    expect(() => validateGalileoFeePolicy({ ...policy, transactionType: 'eip1559' })).to.throw(
      'identity or release scope mismatch'
    );
  });

  it('rejects missing, malformed, below-minimum, and above-maximum operator values', () => {
    expect(() => resolveGalileoLegacyGasPrice({})).to.throw('is required');
    expect(() => resolveGalileoLegacyGasPrice({ PERPDEX_GALILEO_GAS_PRICE_WEI: '4e9' })).to.throw(
      'canonical unsigned decimal integer'
    );
    expect(() => resolveGalileoLegacyGasPrice({ PERPDEX_GALILEO_GAS_PRICE_WEI: '02000000007' })).to.throw(
      'canonical unsigned decimal integer'
    );
    expect(() => resolveGalileoLegacyGasPrice({ PERPDEX_GALILEO_GAS_PRICE_WEI: '2000000006' })).to.throw(
      'below the reviewed minimum'
    );
    expect(() => resolveGalileoLegacyGasPrice({ PERPDEX_GALILEO_GAS_PRICE_WEI: '20000000001' })).to.throw(
      'exceeds the reviewed maximum'
    );
  });

  it('applies the accepted explicit legacy fee to the Hardhat network configuration', () => {
    expect(galileoHardhatFeeConfig({ PERPDEX_GALILEO_GAS_PRICE_WEI: String(DEFAULT_GAS_PRICE) })).to.deep.equal({
      gasPrice: DEFAULT_GAS_PRICE,
    });
  });

  it('forces the deployment wallet used by ContractFactory and OpenZeppelin to populate type-0 fees', async () => {
    const wallet = new GalileoLegacyFeeWallet(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      hardhatEthers.provider,
      DEFAULT_GAS_PRICE
    );
    const transaction = await wallet.populateTransaction({
      to: wallet.address,
      value: 0,
      nonce: 0,
      gasLimit: 21_000,
      chainId: 31337,
    });
    expect(transaction.type).to.equal(0);
    expect(transaction.gasPrice?.toString()).to.equal(String(DEFAULT_GAS_PRICE));
    await expectFailure(
      wallet.populateTransaction({
        to: wallet.address,
        maxPriorityFeePerGas: BigNumber.from(1),
        nonce: 0,
        gasLimit: 21_000,
        chainId: 31337,
      }),
      'rejects EIP-1559 maxPriorityFeePerGas'
    );
  });

  it('rejects a configured fee below the live RPC quote or live priority-plus-base requirement', () => {
    const live = {
      gasPrice: 4_000_000_007n,
      maxPriorityFeePerGas: 4_000_000_000n,
      baseFeePerGas: 7n,
    };
    expect(() => validateGalileoLiveFeeQuote(DEFAULT_GAS_PRICE, live)).not.to.throw();
    expect(() => validateGalileoLiveFeeQuote(4_000_000_006, live)).to.throw('below the live RPC fee requirement');
    expect(() => validateGalileoLiveFeeQuote(DEFAULT_GAS_PRICE, { ...live, gasPrice: 20_000_000_001n })).to.throw(
      'outside the reviewed fee bounds'
    );
  });

  it('proves a populated transaction uses legacy gasPrice and rejects EIP-1559 or drift', async () => {
    const provider = {
      send: async (method: string) => {
        if (method === 'eth_gasPrice') return '0xee6b2807';
        if (method === 'eth_maxPriorityFeePerGas') return '0xee6b2800';
        if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x7' };
        throw new Error(`unexpected method ${method}`);
      },
    } as providers.JsonRpcProvider;
    const populated = { gasPrice: BigNumber.from(DEFAULT_GAS_PRICE) };
    const quote = await assertGalileoDeploymentFeePolicy({
      provider,
      populatedTransaction: populated,
      configuredGasPriceWei: DEFAULT_GAS_PRICE,
    });
    expect(quote.gasPrice).to.equal(4_000_000_007n);

    await expectFailure(
      assertGalileoDeploymentFeePolicy({
        provider,
        populatedTransaction: { maxFeePerGas: BigNumber.from(DEFAULT_GAS_PRICE) },
        configuredGasPriceWei: DEFAULT_GAS_PRICE,
      }),
      'did not apply the reviewed legacy gas price'
    );
    await expectFailure(
      assertGalileoDeploymentFeePolicy({
        provider,
        populatedTransaction: { gasPrice: BigNumber.from(DEFAULT_GAS_PRICE + 1) },
        configuredGasPriceWei: DEFAULT_GAS_PRICE,
      }),
      'did not apply the reviewed legacy gas price'
    );
  });
});
