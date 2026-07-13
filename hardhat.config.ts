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

dotenv.config({
  path: process.env.PERPDEX_ENV_FILE || '.env.galileo.local',
});

const galileoRpcUrl = process.env.PERPDEX_GALILEO_RPC_URL || process.env.GALILEO_RPC_URL;
const galileoDeployerKey = process.env.PERPDEX_GALILEO_DEPLOYER_PRIVATE_KEY;
const galileoChainId = Number(process.env.GALILEO_CHAIN_ID || '16602');

if (galileoChainId !== 16602) {
  throw new Error(`refusing Galileo configuration for chain ${galileoChainId}`);
}

const networks: HardhatUserConfig['networks'] = {};
if (galileoRpcUrl && galileoDeployerKey) {
  networks.galileo = {
    url: galileoRpcUrl,
    chainId: galileoChainId,
    accounts: [galileoDeployerKey],
    ...galileoHardhatFeeConfig(),
    timeout: 120000,
  };
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
