/**
 * @type import('hardhat/config').HardhatUserConfig
 */
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-solhint';
import '@openzeppelin/hardhat-upgrades';
import '@typechain/hardhat';
import dotenv from 'dotenv';
import 'hardhat-deploy';
import 'solidity-coverage';
import 'hardhat-gas-reporter';
import 'hardhat-contract-sizer';
import 'hardhat-abi-exporter';
import { HardhatUserConfig } from 'hardhat/config';
import { galileoHardhatFeeConfig } from './scripts/galileo-fee-policy';
import { PERPDEX_NETWORK, resolveNetworkProfile } from './scripts/deployment-config';

dotenv.config({
  path: process.env.PERPDEX_ENV_FILE || PERPDEX_NETWORK.files.envFile,
});

// PERPDEX_NETWORK is resolved from the shell before the env file loads; an env
// file must never switch the selected chain profile.
if (resolveNetworkProfile().name !== PERPDEX_NETWORK.name) {
  throw new Error('PERPDEX_NETWORK must be set in the shell environment, not in the env file');
}

const rpcUrl =
  process.env[PERPDEX_NETWORK.rpcUrlEnv] ||
  (PERPDEX_NETWORK.legacyRpcUrlEnv ? process.env[PERPDEX_NETWORK.legacyRpcUrlEnv] : undefined);
const chainId = Number(process.env[PERPDEX_NETWORK.chainIdEnv] || String(PERPDEX_NETWORK.chainId));

if (chainId !== PERPDEX_NETWORK.chainId) {
  throw new Error(`refusing ${PERPDEX_NETWORK.name} configuration for chain ${chainId}`);
}

const networks: HardhatUserConfig['networks'] = {};
const deployerKey = PERPDEX_NETWORK.deployerPrivateKeyEnv
  ? process.env[PERPDEX_NETWORK.deployerPrivateKeyEnv]
  : undefined;
if (rpcUrl && deployerKey) {
  networks[PERPDEX_NETWORK.hardhatNetwork] = {
    url: rpcUrl,
    chainId,
    accounts: [deployerKey],
    ...galileoHardhatFeeConfig(),
    timeout: 120000,
  };
} else if (rpcUrl && PERPDEX_NETWORK.deployerPrivateKeyEnv === null) {
  // Custody-held deployer: read-only network with no local signer.
  networks[PERPDEX_NETWORK.hardhatNetwork] = { url: rpcUrl, chainId, accounts: [], timeout: 120000 };
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.13',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  defaultNetwork: 'hardhat',
  networks,
  contractSizer: {
    runOnCompile: true,
  },
  abiExporter: {
    path: './abis',
    runOnCompile: true,
    clear: true,
    flat: true,
    spacing: 2,
  },
  gasReporter: {
    onlyCalledMethods: true,
    showTimeSpent: true,
  },
  mocha: {
    timeout: 1000000000,
  },
};

export default config;
