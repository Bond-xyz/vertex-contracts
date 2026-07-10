import fs from 'fs';
import path from 'path';
import { Wallet, utils } from 'ethers';

const root = path.resolve(__dirname, '..');
const privatePath = path.join(
  root,
  'verifier-private-keys.galileo.local.json',
);
const publicPath = path.join(
  root,
  'config',
  'galileo.verifier-public-keys.local.json',
);

if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
  throw new Error('refusing to overwrite an existing Galileo verifier key file');
}

const wallets = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
const points = wallets.map((wallet) => {
  const publicKey = utils.computePublicKey(wallet.privateKey, false);
  return {
    x: `0x${publicKey.slice(4, 68)}`,
    y: `0x${publicKey.slice(68, 132)}`,
  };
});

fs.writeFileSync(
  privatePath,
  `${JSON.stringify(
    {
      chainId: 16602,
      purpose: 'Bond PerpDex Galileo verifier quorum only',
      privateKeys: wallets.map((wallet) => wallet.privateKey),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600, flag: 'wx' },
);
fs.writeFileSync(
  publicPath,
  `${JSON.stringify({ chainId: 16602, signerBitmask: 7, keys: points }, null, 2)}\n`,
  { mode: 0o644, flag: 'wx' },
);

console.log(`created private verifier material at ${privatePath}`);
console.log(`created deployable public verifier material at ${publicPath}`);
console.log('no key values were printed');
