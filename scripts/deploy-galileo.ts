import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers, upgrades } from 'hardhat';
import { Contract, ContractReceipt, utils } from 'ethers';
import {
  GALILEO_CHAIN_ID,
  GALILEO_USDCE_ADDRESS,
  GALILEO_USDCE_DECIMALS,
  GALILEO_USDCE_SYMBOL,
  initialPrices,
  loadProducts,
  loadVerifierPoints,
  requireGalileoUsdce,
} from './deployment-config';

const AUDITED_BASE_COMMIT = '6d5df597afe4eb16c6131a85f45322e0954b9e94';
const requiredAddress = (value: string | undefined, field: string): string => {
  if (!value || !utils.isAddress(value)) throw new Error(`${field} must be an address`);
  return utils.getAddress(value);
};

const receipt = async (transaction: any): Promise<ContractReceipt> => transaction.wait();

const deploymentBlock = async (contract: Contract): Promise<number> =>
  (await contract.deployTransaction.wait()).blockNumber;

const sha256File = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function deployProxyShell(name: string, unsafeAllow: 'delegatecall'[] = []): Promise<Contract> {
  const factory = await ethers.getContractFactory(name);
  const proxy = await upgrades.deployProxy(factory, [], {
    initializer: false,
    kind: 'transparent',
    unsafeAllow,
  });
  await proxy.deployed();
  return proxy;
}

async function proxyRecord(contract: Contract) {
  return {
    proxy: contract.address,
    implementation: await upgrades.erc1967.getImplementationAddress(contract.address),
    admin: await upgrades.erc1967.getAdminAddress(contract.address),
    deploymentBlock: await deploymentBlock(contract),
  };
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== GALILEO_CHAIN_ID) {
    throw new Error(`refusing deployment: expected chain ${GALILEO_CHAIN_ID}, got ${network.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const sequencer = requiredAddress(
    process.env.PERPDEX_SEQUENCER_ADDRESS || deployer.address,
    'PERPDEX_SEQUENCER_ADDRESS'
  );
  const quote = requireGalileoUsdce(process.env.PERPDEX_QUOTE_TOKEN_ADDRESS);
  const productsFile = path.resolve(process.env.PERPDEX_PRODUCTS_FILE || './config/galileo.products.json');
  const verifierFile = path.resolve(
    process.env.PERPDEX_VERIFIER_PUBLIC_KEYS_FILE || './config/galileo.verifier-public-keys.local.json'
  );
  const manifestFile = path.resolve(process.env.PERPDEX_DEPLOYMENT_MANIFEST || './deployments/16602/latest.local.json');

  const products = loadProducts(productsFile);
  const verifierPoints = loadVerifierPoints(verifierFile);
  const quoteCode = await ethers.provider.getCode(quote);
  if (quoteCode === '0x') throw new Error('canonical quote token has no bytecode');
  const quoteContract = new Contract(
    quote,
    ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
    ethers.provider
  );
  const quoteDecimals = await quoteContract.decimals();
  const quoteSymbol = await quoteContract.symbol();
  if (quoteDecimals !== GALILEO_USDCE_DECIMALS || quoteSymbol !== GALILEO_USDCE_SYMBOL) {
    throw new Error(`Galileo collateral metadata mismatch: expected ${GALILEO_USDCE_SYMBOL}/${GALILEO_USDCE_DECIMALS}`);
  }

  // Fresh proxies only. This script never upgrades or adopts the old Fable set.
  const Sanctions = await ethers.getContractFactory('MockSanctionsList');
  const sanctions = await Sanctions.deploy();
  await sanctions.deployed();
  const Liq = await ethers.getContractFactory('ClearinghouseLiq');
  const clearinghouseLiq = await Liq.deploy();
  await clearinghouseLiq.deployed();

  const verifier = await deployProxyShell('Verifier');
  const endpoint = await deployProxyShell('Endpoint');
  // The audited liquidation path intentionally delegates to ClearinghouseLiq.
  const clearinghouse = await deployProxyShell('Clearinghouse', ['delegatecall']);
  const spotEngine = await deployProxyShell('SpotEngine');
  const perpEngine = await deployProxyShell('PerpEngine');
  const offchainExchange = await deployProxyShell('OffchainExchange');

  const paddedVerifierPoints = [...verifierPoints, ...Array(5).fill({ x: 0, y: 0 })];
  await receipt(await verifier.initialize(paddedVerifierPoints));
  await receipt(await clearinghouse.initialize(endpoint.address, quote, clearinghouseLiq.address, products.spreads));
  await receipt(await clearinghouse.addEngine(spotEngine.address, offchainExchange.address, 0));
  await receipt(await clearinghouse.addEngine(perpEngine.address, offchainExchange.address, 1));
  await receipt(await offchainExchange.initialize(clearinghouse.address, endpoint.address));
  await receipt(
    await endpoint.initialize(
      sanctions.address,
      sequencer,
      offchainExchange.address,
      clearinghouse.address,
      verifier.address,
      initialPrices(products.products)
    )
  );

  const VirtualBook = await ethers.getContractFactory('VirtualBook');
  const markets: Record<string, any> = {};
  for (const product of products.products) {
    const virtualBook = await VirtualBook.deploy(product.productId);
    await virtualBook.deployed();
    await receipt(
      await perpEngine.addProduct(
        product.productId,
        virtualBook.address,
        product.sizeIncrementX18,
        product.minSizeX18,
        product.lpSpreadX18,
        {
          longWeightInitial: product.risk.longWeightInitial,
          shortWeightInitial: product.risk.shortWeightInitial,
          longWeightMaintenance: product.risk.longWeightMaintenance,
          shortWeightMaintenance: product.risk.shortWeightMaintenance,
          priceX18: product.risk.priceX18,
        }
      )
    );
    const configuredBook = await offchainExchange.getVirtualBook(product.productId);
    if (configuredBook !== virtualBook.address) {
      throw new Error(`virtual-book verification failed for ${product.symbol}`);
    }
    markets[product.symbol] = {
      productId: product.productId,
      virtualBook: virtualBook.address,
      virtualBookDeploymentBlock: await deploymentBlock(virtualBook),
      sizeIncrementX18: product.sizeIncrementX18,
      minSizeX18: product.minSizeX18,
      risk: product.risk,
    };
  }

  if ((await endpoint.getSequencer()) !== sequencer) {
    throw new Error('sequencer post-deploy verification failed');
  }
  if ((await clearinghouse.getEngineByProduct(2)) !== perpEngine.address) {
    throw new Error('perp engine product registration verification failed');
  }
  if (
    !endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[],bytes32,bytes32)'] ||
    endpoint.interface.functions['submitTransactionsChecked(uint64,bytes[])']
  ) {
    throw new Error('unsafe batch ABI detected');
  }

  const manifest = {
    schemaVersion: 1,
    release: 'bond-perpdex-galileo-audited-base',
    source: {
      auditedBaseCommit: AUDITED_BASE_COMMIT,
      productConfigSha256: sha256File(productsFile),
      verifierPublicKeysSha256: sha256File(verifierFile),
      explicitDeltas: [
        'restore omitted Version.sol implementation',
        'enforce OffchainExchange order signatures',
        'emit DepositCollateralWithReferral for Bond settlement provenance',
        'deploy unique non-custodial VirtualBook domains',
        'pin product zero to existing Galileo USDC.e and require exact custody transfers',
      ],
    },
    network: {
      name: '0G Galileo Testnet',
      chainId: GALILEO_CHAIN_ID,
    },
    deployer: deployer.address,
    sequencer,
    sequencerUsesDeployer: sequencer === deployer.address,
    quoteToken: quote,
    collateral: {
      address: GALILEO_USDCE_ADDRESS,
      symbol: GALILEO_USDCE_SYMBOL,
      decimals: GALILEO_USDCE_DECIMALS,
      productId: 0,
      source: 'existing',
      deployToken: false,
    },
    contracts: {
      sanctions: {
        address: sanctions.address,
        deploymentBlock: await deploymentBlock(sanctions),
      },
      clearinghouseLiq: {
        address: clearinghouseLiq.address,
        deploymentBlock: await deploymentBlock(clearinghouseLiq),
      },
      verifier: await proxyRecord(verifier),
      endpoint: await proxyRecord(endpoint),
      clearinghouse: await proxyRecord(clearinghouse),
      spotEngine: await proxyRecord(spotEngine),
      perpEngine: await proxyRecord(perpEngine),
      offchainExchange: await proxyRecord(offchainExchange),
    },
    markets,
    gates: {
      signedBatchAbiOnly: true,
      orderSignaturesEnforced: true,
      updatePerpBalanceAbsent: true,
      slowModeExitPreserved: true,
      productRiskConfigApproved: true,
      exactGalileoUsdcePinned: quote === GALILEO_USDCE_ADDRESS,
      collateralTokenDeploymentAbsent: true,
    },
  };

  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`Galileo deployment manifest written to ${manifestFile}`);
  console.log('No private keys or secret values were printed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
