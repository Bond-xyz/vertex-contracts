import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { utils } from 'ethers';
import {
  GALILEO_CHAIN_ID,
  GALILEO_RELEASE_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
} from './deployment-config';

export const GALILEO_DEPLOYMENT_SCRIPT_SHA256 = '99dba0b0bc60b36b5ca10b5d9f46f68370e24e347806ab3c75d0c751bbaba5c3';
export const GALILEO_PREPARE_TRANSACTION_COUNT = 24;
export const GALILEO_FINALIZE_TRANSACTION_COUNT = 5;

type PlannedTransaction = {
  phase: 'prepare' | 'finalize';
  nonce: number;
  kind: 'CREATE' | 'CALL';
  action: string;
  address: string;
};

const nonzeroAddress = (value: string, label: string): string => {
  if (!utils.isAddress(value)) throw new Error(`${label} must be an address`);
  const address = utils.getAddress(value);
  if (address === utils.getAddress(ethersZeroAddress)) throw new Error(`${label} must not be zero`);
  return address;
};

const ethersZeroAddress = '0x0000000000000000000000000000000000000000';

const safeNonce = (value: number): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value + GALILEO_PREPARE_TRANSACTION_COUNT + GALILEO_FINALIZE_TRANSACTION_COUNT > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('first transaction nonce must leave room for the complete Galileo transaction sequence');
  }
  return value;
};

const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function assertGalileoDeploymentScriptMatchesPlan(
  deployScript = path.resolve(__dirname, 'deploy-galileo.ts')
): void {
  if (sha256File(deployScript) !== GALILEO_DEPLOYMENT_SCRIPT_SHA256) {
    throw new Error('deployment script changed; rederive and review the transaction-offset plan');
  }
}

export function createGalileoAddressPlan(deployerInput: string, sequencerInput: string, nonceInput: number) {
  const deployer = nonzeroAddress(deployerInput, 'deployer');
  const sequencer = nonzeroAddress(sequencerInput, 'sequencer');
  const firstTransactionNonce = safeNonce(nonceInput);
  const createAddress = (offset: number): string =>
    utils.getContractAddress({ from: deployer, nonce: firstTransactionNonce + offset });

  const contracts = {
    sanctions: { address: createAddress(0), creationNonce: firstTransactionNonce },
    clearinghouseLiq: { address: createAddress(1), creationNonce: firstTransactionNonce + 1 },
    proxyAdmin: { address: createAddress(3), creationNonce: firstTransactionNonce + 3 },
    verifier: {
      implementation: createAddress(2),
      implementationCreationNonce: firstTransactionNonce + 2,
      proxy: createAddress(4),
      proxyCreationNonce: firstTransactionNonce + 4,
    },
    endpoint: {
      implementation: createAddress(5),
      implementationCreationNonce: firstTransactionNonce + 5,
      proxy: createAddress(6),
      proxyCreationNonce: firstTransactionNonce + 6,
    },
    clearinghouse: {
      implementation: createAddress(7),
      implementationCreationNonce: firstTransactionNonce + 7,
      proxy: createAddress(8),
      proxyCreationNonce: firstTransactionNonce + 8,
    },
    spotEngine: {
      implementation: createAddress(9),
      implementationCreationNonce: firstTransactionNonce + 9,
      proxy: createAddress(10),
      proxyCreationNonce: firstTransactionNonce + 10,
    },
    perpEngine: {
      implementation: createAddress(11),
      implementationCreationNonce: firstTransactionNonce + 11,
      proxy: createAddress(12),
      proxyCreationNonce: firstTransactionNonce + 12,
    },
    offchainExchange: {
      implementation: createAddress(13),
      implementationCreationNonce: firstTransactionNonce + 13,
      proxy: createAddress(14),
      proxyCreationNonce: firstTransactionNonce + 14,
    },
    virtualBooks: {
      '2': { address: createAddress(20), creationNonce: firstTransactionNonce + 20 },
      '4': { address: createAddress(21), creationNonce: firstTransactionNonce + 21 },
      '6': { address: createAddress(22), creationNonce: firstTransactionNonce + 22 },
      '8': { address: createAddress(23), creationNonce: firstTransactionNonce + 23 },
    },
  };

  const create = (offset: number, action: string): PlannedTransaction => ({
    phase: 'prepare',
    nonce: firstTransactionNonce + offset,
    kind: 'CREATE',
    action,
    address: createAddress(offset),
  });
  const call = (
    offset: number,
    phase: PlannedTransaction['phase'],
    action: string,
    address: string
  ): PlannedTransaction => ({
    phase,
    nonce: firstTransactionNonce + offset,
    kind: 'CALL',
    action,
    address,
  });

  const prepare: PlannedTransaction[] = [
    create(0, 'sanctions.deploy'),
    create(1, 'clearinghouseLiq.deploy'),
    create(2, 'verifier.implementation.deploy'),
    create(3, 'proxyAdmin.deploy'),
    create(4, 'verifier.proxy.deploy'),
    create(5, 'endpoint.implementation.deploy'),
    create(6, 'endpoint.proxy.deploy'),
    create(7, 'clearinghouse.implementation.deploy'),
    create(8, 'clearinghouse.proxy.deploy'),
    create(9, 'spotEngine.implementation.deploy'),
    create(10, 'spotEngine.proxy.deploy'),
    create(11, 'perpEngine.implementation.deploy'),
    create(12, 'perpEngine.proxy.deploy'),
    create(13, 'offchainExchange.implementation.deploy'),
    create(14, 'offchainExchange.proxy.deploy'),
    call(15, 'prepare', 'verifier.initialize', contracts.verifier.proxy),
    call(16, 'prepare', 'clearinghouse.initialize', contracts.clearinghouse.proxy),
    call(17, 'prepare', 'clearinghouse.addEngine.spot', contracts.clearinghouse.proxy),
    call(18, 'prepare', 'clearinghouse.addEngine.perp', contracts.clearinghouse.proxy),
    call(19, 'prepare', 'offchainExchange.initialize', contracts.offchainExchange.proxy),
    create(20, 'virtualBook.2.deploy'),
    create(21, 'virtualBook.4.deploy'),
    create(22, 'virtualBook.6.deploy'),
    create(23, 'virtualBook.8.deploy'),
  ];
  const finalize: PlannedTransaction[] = [
    call(24, 'finalize', 'endpoint.initialize', contracts.endpoint.proxy),
    call(25, 'finalize', 'perpEngine.addProduct.2', contracts.perpEngine.proxy),
    call(26, 'finalize', 'perpEngine.addProduct.4', contracts.perpEngine.proxy),
    call(27, 'finalize', 'perpEngine.addProduct.6', contracts.perpEngine.proxy),
    call(28, 'finalize', 'perpEngine.addProduct.8', contracts.perpEngine.proxy),
  ];

  return {
    schemaVersion: 1,
    release: GALILEO_RELEASE_ID,
    network: { name: '0G Galileo Testnet', chainId: GALILEO_CHAIN_ID },
    deploymentScriptSha256: GALILEO_DEPLOYMENT_SCRIPT_SHA256,
    deployer,
    sequencer,
    expectedRoles: {
      contractOwner: deployer,
      proxyAdminOwner: deployer,
      sequencer,
      verifierSignerCount: 3,
      verifierSignerBitmask: 7,
    },
    parameters: {
      collateral: {
        address: GALILEO_USDCE_ADDRESS,
        symbol: GALILEO_USDCE_SYMBOL,
        decimals: GALILEO_USDCE_DECIMALS,
        productId: 0,
        deployToken: false,
      },
      productIds: [2, 4, 6, 8],
      clearinghouseSpreadsX18: '0',
      lpSpreadsX18: ['0', '0', '0', '0'],
      maximumLeverage: 20,
      storkMaxAgeSeconds: 30,
      storkMaxFutureSkewSeconds: 2,
      storkMaxSignedTimestampSpreadSeconds: 3,
      finalityConfirmations: 12,
      initialReleaseMode: 0,
    },
    firstTransactionNonce,
    expectedFirstContract: contracts.sanctions.address,
    contracts,
    preparation: {
      transactionCount: GALILEO_PREPARE_TRANSACTION_COUNT,
      finalizationStartingNonce: firstTransactionNonce + GALILEO_PREPARE_TRANSACTION_COUNT,
      transactions: prepare,
    },
    finalization: {
      transactionCount: GALILEO_FINALIZE_TRANSACTION_COUNT,
      lastNonce: firstTransactionNonce + GALILEO_PREPARE_TRANSACTION_COUNT + GALILEO_FINALIZE_TRANSACTION_COUNT - 1,
      transactions: finalize,
    },
  };
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function writeGalileoAddressPlan(): void {
  const deployScript = path.resolve(__dirname, 'deploy-galileo.ts');
  assertGalileoDeploymentScriptMatchesPlan(deployScript);
  const nonce = Number(required(process.env.PERPDEX_FIRST_TRANSACTION_NONCE, 'PERPDEX_FIRST_TRANSACTION_NONCE'));
  const plan = createGalileoAddressPlan(
    required(process.env.PERPDEX_DEPLOYER_ADDRESS, 'PERPDEX_DEPLOYER_ADDRESS'),
    required(process.env.PERPDEX_SEQUENCER_ADDRESS, 'PERPDEX_SEQUENCER_ADDRESS'),
    nonce
  );
  const output = path.resolve(process.env.PERPDEX_ADDRESS_PLAN_FILE || './deployments/16602/address-plan.local.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`created unsigned Galileo address plan at ${output}`);
  console.log(`expected first contract: ${plan.expectedFirstContract}`);
  console.log('No private key or secret value was read.');
}

if (require.main === module) writeGalileoAddressPlan();
