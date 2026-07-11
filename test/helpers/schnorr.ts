import { BigNumber, BigNumberish, Wallet, utils } from 'ethers';

export const SECP256K1_Q = BigNumber.from(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

const scalarHex = (value: BigNumberish): string =>
  utils.hexZeroPad(BigNumber.from(value).toHexString(), 32);

export type VerifierPoint = { x: BigNumber; y: BigNumber };

export function publicPoint(privateKey: string): VerifierPoint {
  const publicKey = utils.computePublicKey(privateKey, false);
  return {
    x: BigNumber.from(`0x${publicKey.slice(4, 68)}`),
    y: BigNumber.from(`0x${publicKey.slice(68, 132)}`),
  };
}

export function aggregatePrivateKeys(privateKeys: string[]): BigNumber {
  const aggregate = privateKeys.reduce(
    (sum, key) => sum.add(BigNumber.from(key)).mod(SECP256K1_Q),
    BigNumber.from(0),
  );
  if (aggregate.isZero()) throw new Error('zero aggregate verifier key');
  return aggregate;
}

export function signSchnorrForTest(
  privateKeys: string[],
  message: string,
): { e: string; s: string } {
  const privateAggregate = aggregatePrivateKeys(privateKeys);
  const privateAggregateHex = scalarHex(privateAggregate);
  const publicAggregate = publicPoint(privateAggregateHex);
  const parity = publicAggregate.y.mod(2).isZero() ? 27 : 28;
  const px = scalarHex(publicAggregate.x);

  // Deterministic nonce for regression tests only. The production settlement
  // signer must use an independently reviewed nonce implementation.
  const nonce = BigNumber.from(
    utils.keccak256(
      utils.solidityPack(
        ['bytes32', 'bytes32', 'string'],
        [privateAggregateHex, message, 'bond-perpdex-release-test'],
      ),
    ),
  )
    .mod(SECP256K1_Q.sub(1))
    .add(1);
  const noncePublicKey = utils.computePublicKey(scalarHex(nonce), false);
  const nonceAddress = utils.computeAddress(noncePublicKey);
  const e = utils.keccak256(
    utils.solidityPack(
      ['address', 'uint8', 'bytes32', 'bytes32'],
      [nonceAddress, parity, px, message],
    ),
  );
  const s = nonce
    .add(BigNumber.from(e).mul(privateAggregate))
    .mod(SECP256K1_Q);

  return { e, s: scalarHex(s) };
}

export function subaccountFor(wallet: Wallet | string): string {
  const address = typeof wallet === 'string' ? wallet : wallet.address;
  return utils.hexConcat([address, utils.hexZeroPad('0x', 12)]);
}
