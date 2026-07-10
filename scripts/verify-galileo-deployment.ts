import fs from 'fs';
import path from 'path';
import { ethers } from 'hardhat';

async function main() {
  const manifestFile = path.resolve(
    process.env.PERPDEX_DEPLOYMENT_MANIFEST ||
      './deployments/16602/latest.local.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 16602 || manifest.network.chainId !== 16602) {
    throw new Error('manifest/network chain mismatch');
  }

  const addresses = [
    manifest.quoteToken,
    manifest.contracts.sanctions.address,
    manifest.contracts.clearinghouseLiq.address,
    manifest.contracts.verifier.proxy,
    manifest.contracts.endpoint.proxy,
    manifest.contracts.clearinghouse.proxy,
    manifest.contracts.spotEngine.proxy,
    manifest.contracts.perpEngine.proxy,
    manifest.contracts.offchainExchange.proxy,
    ...Object.values(manifest.markets).map((market: any) => market.virtualBook),
  ];
  for (const address of addresses) {
    if ((await ethers.provider.getCode(address)) === '0x') {
      throw new Error(`missing bytecode at ${address}`);
    }
  }

  const endpoint = await ethers.getContractAt(
    'Endpoint',
    manifest.contracts.endpoint.proxy,
  );
  const clearinghouse = await ethers.getContractAt(
    'Clearinghouse',
    manifest.contracts.clearinghouse.proxy,
  );
  const exchange = await ethers.getContractAt(
    'OffchainExchange',
    manifest.contracts.offchainExchange.proxy,
  );
  if ((await endpoint.getSequencer()) !== manifest.sequencer) {
    throw new Error('sequencer mismatch');
  }
  for (const market of Object.values(manifest.markets) as any[]) {
    if ((await clearinghouse.getEngineByProduct(market.productId)) !== manifest.contracts.perpEngine.proxy) {
      throw new Error(`engine mismatch for product ${market.productId}`);
    }
    if ((await exchange.getVirtualBook(market.productId)) !== market.virtualBook) {
      throw new Error(`virtual-book mismatch for product ${market.productId}`);
    }
  }

  console.log('Galileo deployment verification passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
