import { utils } from 'ethers';

export function isCanonicalGalileoRuntimeCodeHash(value: unknown): value is string {
  return typeof value === 'string' && utils.isHexString(value, 32);
}
