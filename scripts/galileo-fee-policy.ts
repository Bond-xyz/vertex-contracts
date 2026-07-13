import fs from 'fs';
import path from 'path';
import { BigNumber, Wallet } from 'ethers';
import type { providers } from 'ethers';

export const TRACKED_GALILEO_FEE_POLICY = 'config/galileo.fee-policy.json';
export const GALILEO_GAS_PRICE_ENV = 'PERPDEX_GALILEO_GAS_PRICE_WEI';
const GALILEO_CHAIN_ID = 16602;
const EXPECTED_MINIMUM_GAS_PRICE_WEI = 2_000_000_007n;
const EXPECTED_DEFAULT_GAS_PRICE_WEI = 4_000_000_007n;
const EXPECTED_MAXIMUM_GAS_PRICE_WEI = 20_000_000_000n;

export type GalileoFeePolicy = {
  schemaVersion: number;
  policyId: string;
  status: string;
  chainId: number;
  transactionType: string;
  requiredEnvironmentVariable: string;
  requireExplicitValue: boolean;
  minimumGasPriceWei: string;
  defaultGasPriceWei: string;
  maximumGasPriceWei: string;
};

export type VerifiedGalileoFeePolicy = GalileoFeePolicy & {
  minimumGasPrice: bigint;
  defaultGasPrice: bigint;
  maximumGasPrice: bigint;
};

export type GalileoLiveFeeQuote = {
  gasPrice: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeePerGas: bigint;
};

function decimalWei(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal integer`);
  }
  return BigInt(value);
}

function hexWei(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`${field} must be a canonical JSON-RPC quantity`);
  }
  return BigInt(value);
}

export function validateGalileoFeePolicy(policy: GalileoFeePolicy): VerifiedGalileoFeePolicy {
  if (
    policy.schemaVersion !== 1 ||
    policy.policyId !== 'bond-perpdex-galileo-legacy-fees' ||
    policy.status !== 'approved_for_galileo_testnet_release' ||
    policy.chainId !== GALILEO_CHAIN_ID ||
    policy.transactionType !== 'legacy' ||
    policy.requiredEnvironmentVariable !== GALILEO_GAS_PRICE_ENV ||
    policy.requireExplicitValue !== true
  ) {
    throw new Error('tracked Galileo fee policy identity or release scope mismatch');
  }
  const minimumGasPrice = decimalWei(policy.minimumGasPriceWei, 'minimum Galileo gas price');
  const defaultGasPrice = decimalWei(policy.defaultGasPriceWei, 'default Galileo gas price');
  const maximumGasPrice = decimalWei(policy.maximumGasPriceWei, 'maximum Galileo gas price');
  if (
    minimumGasPrice !== EXPECTED_MINIMUM_GAS_PRICE_WEI ||
    defaultGasPrice !== EXPECTED_DEFAULT_GAS_PRICE_WEI ||
    maximumGasPrice !== EXPECTED_MAXIMUM_GAS_PRICE_WEI
  ) {
    throw new Error('tracked Galileo fee bounds differ from the reviewed release policy');
  }
  if (!(minimumGasPrice <= defaultGasPrice && defaultGasPrice <= maximumGasPrice)) {
    throw new Error('tracked Galileo fee bounds are internally inconsistent');
  }
  return { ...policy, minimumGasPrice, defaultGasPrice, maximumGasPrice };
}

export function loadTrackedGalileoFeePolicy(repoRoot = path.resolve(__dirname, '..')): VerifiedGalileoFeePolicy {
  const policyFile = path.resolve(repoRoot, TRACKED_GALILEO_FEE_POLICY);
  if (!fs.existsSync(policyFile)) throw new Error('tracked Galileo fee policy is missing');
  return validateGalileoFeePolicy(JSON.parse(fs.readFileSync(policyFile, 'utf8')) as GalileoFeePolicy);
}

export function resolveGalileoLegacyGasPrice(
  environment: NodeJS.ProcessEnv = process.env,
  policy = loadTrackedGalileoFeePolicy()
): number {
  const raw = environment[policy.requiredEnvironmentVariable];
  if (raw === undefined || raw === '') {
    throw new Error(
      `${policy.requiredEnvironmentVariable} is required; explicitly confirm ${policy.defaultGasPriceWei} wei or another reviewed in-range value`
    );
  }
  const gasPrice = decimalWei(raw, policy.requiredEnvironmentVariable);
  if (gasPrice < policy.minimumGasPrice) {
    throw new Error(
      `${policy.requiredEnvironmentVariable} is below the reviewed minimum ${policy.minimumGasPriceWei} wei`
    );
  }
  if (gasPrice > policy.maximumGasPrice) {
    throw new Error(
      `${policy.requiredEnvironmentVariable} exceeds the reviewed maximum ${policy.maximumGasPriceWei} wei`
    );
  }
  if (gasPrice > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${policy.requiredEnvironmentVariable} cannot be represented safely by Hardhat`);
  }
  return Number(gasPrice);
}

export function galileoHardhatFeeConfig(environment: NodeJS.ProcessEnv = process.env): { gasPrice: number } {
  return { gasPrice: resolveGalileoLegacyGasPrice(environment) };
}

export class GalileoLegacyFeeWallet extends Wallet {
  readonly reviewedGasPrice: BigNumber;

  constructor(privateKey: string, provider: providers.Provider | undefined, configuredGasPriceWei: number) {
    super(privateKey, provider);
    this.reviewedGasPrice = BigNumber.from(configuredGasPriceWei);
  }

  async populateTransaction(transaction: providers.TransactionRequest): Promise<providers.TransactionRequest> {
    const [requestedType, requestedGasPrice, requestedMaxFee, requestedPriorityFee] = await Promise.all([
      Promise.resolve(transaction.type),
      Promise.resolve(transaction.gasPrice),
      Promise.resolve(transaction.maxFeePerGas),
      Promise.resolve(transaction.maxPriorityFeePerGas),
    ]);
    if (requestedType !== undefined && requestedType !== null && Number(requestedType) !== 0) {
      throw new Error('Galileo deployment signer rejects non-legacy transaction types');
    }
    if (requestedMaxFee !== undefined && requestedMaxFee !== null) {
      throw new Error('Galileo deployment signer rejects EIP-1559 maxFeePerGas');
    }
    if (requestedPriorityFee !== undefined && requestedPriorityFee !== null) {
      throw new Error('Galileo deployment signer rejects EIP-1559 maxPriorityFeePerGas');
    }
    if (
      requestedGasPrice !== undefined &&
      requestedGasPrice !== null &&
      !BigNumber.from(requestedGasPrice).eq(this.reviewedGasPrice)
    ) {
      throw new Error('Galileo deployment transaction attempted to override the reviewed gas price');
    }
    const {
      type: _type,
      gasPrice: _gasPrice,
      maxFeePerGas: _maxFeePerGas,
      maxPriorityFeePerGas: _maxPriorityFeePerGas,
      ...unpricedTransaction
    } = transaction;
    const populated = await super.populateTransaction({
      ...unpricedTransaction,
      type: 0,
      gasPrice: this.reviewedGasPrice,
    });
    if (
      populated.type !== 0 ||
      populated.gasPrice?.toString() !== this.reviewedGasPrice.toString() ||
      populated.maxFeePerGas !== undefined ||
      populated.maxPriorityFeePerGas !== undefined
    ) {
      throw new Error('Galileo deployment signer failed to populate the reviewed legacy gas price');
    }
    return populated;
  }
}

export function validateGalileoLiveFeeQuote(
  configuredGasPriceWei: number,
  quote: GalileoLiveFeeQuote,
  policy = loadTrackedGalileoFeePolicy()
): void {
  const configured = BigInt(configuredGasPriceWei);
  const requiredByQuote = quote.baseFeePerGas + quote.maxPriorityFeePerGas;
  if (quote.gasPrice < policy.minimumGasPrice || quote.gasPrice > policy.maximumGasPrice) {
    throw new Error('live Galileo gas-price quote is outside the reviewed fee bounds');
  }
  if (requiredByQuote > policy.maximumGasPrice) {
    throw new Error('live Galileo base fee plus priority fee exceeds the reviewed maximum');
  }
  if (configured < quote.gasPrice || configured < requiredByQuote) {
    throw new Error('configured Galileo legacy gas price is below the live RPC fee requirement');
  }
}

export async function assertGalileoDeploymentFeePolicy(input: {
  provider: providers.JsonRpcProvider;
  populatedTransaction: providers.TransactionRequest;
  configuredGasPriceWei: number;
}): Promise<GalileoLiveFeeQuote> {
  const [gasPriceHex, maxPriorityFeeHex, latestBlock] = await Promise.all([
    input.provider.send('eth_gasPrice', []),
    input.provider.send('eth_maxPriorityFeePerGas', []),
    input.provider.send('eth_getBlockByNumber', ['latest', false]),
  ]);
  const quote = {
    gasPrice: hexWei(gasPriceHex, 'eth_gasPrice'),
    maxPriorityFeePerGas: hexWei(maxPriorityFeeHex, 'eth_maxPriorityFeePerGas'),
    baseFeePerGas: hexWei(latestBlock?.baseFeePerGas, 'latest block baseFeePerGas'),
  };
  validateGalileoLiveFeeQuote(input.configuredGasPriceWei, quote);
  if (
    input.populatedTransaction.gasPrice?.toString() !== String(input.configuredGasPriceWei) ||
    input.populatedTransaction.maxFeePerGas !== undefined ||
    input.populatedTransaction.maxPriorityFeePerGas !== undefined
  ) {
    throw new Error('Hardhat did not apply the reviewed legacy gas price to a populated Galileo transaction');
  }
  return quote;
}
