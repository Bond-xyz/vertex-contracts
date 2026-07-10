import fs from 'fs';
import path from 'path';
import { BigNumber, utils } from 'ethers';

export type ProductConfig = {
  symbol: string;
  productId: number;
  sizeIncrementX18: string;
  minSizeX18: string;
  lpSpreadX18: string;
  risk: {
    longWeightInitial: number;
    shortWeightInitial: number;
    longWeightMaintenance: number;
    shortWeightMaintenance: number;
    priceX18: string;
  };
};

export type GalileoProducts = {
  chainId: number;
  approved: boolean;
  spreads: string;
  products: ProductConfig[];
};

export type VerifierPoint = { x: string; y: string };

const readJson = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as T;

const positive = (value: string, field: string): BigNumber => {
  const parsed = BigNumber.from(value);
  if (parsed.lte(0)) throw new Error(`${field} must be positive`);
  return parsed;
};

export function loadProducts(file: string): GalileoProducts {
  const config = readJson<GalileoProducts>(file);
  if (config.chainId !== 16602) throw new Error('product config chainId must be 16602');
  if (!config.approved) {
    throw new Error(
      'product risk/scaling config is not approved; do not weaken this release gate',
    );
  }
  const expectedIds = [2, 4, 6, 8];
  const ids = config.products.map((product) => product.productId);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    throw new Error('Galileo launch products must be exactly 2,4,6,8 in order');
  }
  for (const product of config.products) {
    const increment = positive(product.sizeIncrementX18, `${product.symbol}.sizeIncrementX18`);
    const minSize = positive(product.minSizeX18, `${product.symbol}.minSizeX18`);
    positive(product.risk.priceX18, `${product.symbol}.risk.priceX18`);
    if (!increment.mod(1_000_000_000).isZero() || !minSize.mod(1_000_000_000).isZero()) {
      throw new Error(`${product.symbol} sizes must preserve audited X18 to X9 storage conversion`);
    }
    const risk = product.risk;
    if (
      risk.longWeightInitial > risk.longWeightMaintenance ||
      risk.shortWeightInitial < risk.shortWeightMaintenance ||
      risk.longWeightInitial < 0 ||
      risk.shortWeightInitial > 2_000_000_000
    ) {
      throw new Error(`${product.symbol} risk weights violate audited bounds`);
    }
  }
  return config;
}

export function loadVerifierPoints(file: string): VerifierPoint[] {
  const config = readJson<{
    chainId: number;
    signerBitmask: number;
    keys: VerifierPoint[];
  }>(file);
  if (config.chainId !== 16602 || config.signerBitmask !== 7) {
    throw new Error('verifier public-key file must target chain 16602 and bitmask 7');
  }
  if (config.keys.length !== 3) {
    throw new Error('audited Endpoint hardcodes bitmask 7; exactly three verifier keys are required');
  }
  for (const [index, point] of config.keys.entries()) {
    const publicKey = utils.hexConcat([
      '0x04',
      utils.hexZeroPad(point.x, 32),
      utils.hexZeroPad(point.y, 32),
    ]);
    try {
      utils.computePublicKey(publicKey, false);
    } catch {
      throw new Error(`verifier public key ${index} is not a secp256k1 point`);
    }
  }
  return config.keys;
}

export function initialPrices(products: ProductConfig[]): string[] {
  const maxId = Math.max(...products.map((product) => product.productId));
  const prices = Array(maxId + 1).fill('0');
  prices[0] = utils.parseUnits('1', 18).toString();
  for (const product of products) prices[product.productId] = product.risk.priceX18;
  return prices;
}
