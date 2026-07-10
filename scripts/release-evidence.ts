import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BigNumber, BigNumberish, Contract, providers, utils } from 'ethers';
import type { Artifacts } from 'hardhat/types';

export const EIP170_MAX_RUNTIME_BYTES = 24_576;
// Keep a small hard margin below EIP-170 so CI fails before an undeployable build.
export const ENDPOINT_RUNTIME_BUDGET_BYTES = 24_560;

export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// The published slot above is intentionally checked at module load: a truncated
// constant must never silently turn deployment verification into a false pass.
const canonicalAdminSlot = utils.hexZeroPad(
  BigNumber.from(utils.keccak256(utils.toUtf8Bytes('eip1967.proxy.admin')))
    .sub(1)
    .toHexString(),
  32
);
if (EIP1967_ADMIN_SLOT !== canonicalAdminSlot) {
  throw new Error('invalid EIP-1967 admin slot constant');
}

export const RELEASE_ARTIFACTS = {
  sanctions: 'contracts/MockSanctionsList.sol:MockSanctionsList',
  clearinghouseLiq: 'contracts/ClearinghouseLiq.sol:ClearinghouseLiq',
  verifier: 'contracts/Verifier.sol:Verifier',
  endpoint: 'contracts/Endpoint.sol:Endpoint',
  clearinghouse: 'contracts/Clearinghouse.sol:Clearinghouse',
  spotEngine: 'contracts/SpotEngine.sol:SpotEngine',
  perpEngine: 'contracts/PerpEngine.sol:PerpEngine',
  offchainExchange: 'contracts/OffchainExchange.sol:OffchainExchange',
  virtualBook: 'contracts/VirtualBook.sol:VirtualBook',
} as const;

export type ReleaseArtifactKey = keyof typeof RELEASE_ARTIFACTS;

export type ArtifactRuntimeEvidence = {
  contractName: string;
  sourceName: string;
  fullyQualifiedName: string;
  runtimeByteLength: number;
  runtimeCodeHash: string;
  immutableReferences: Array<{ start: number; length: number }>;
};

export type CompilerEvidence = {
  solcVersion: string;
  solcLongVersion: string;
  settings: Record<string, unknown>;
  settingsSha256: string;
};

export type ReleaseBuildEvidence = {
  compiler: CompilerEvidence;
  artifacts: Record<string, ArtifactRuntimeEvidence>;
};

export type ReviewedSourceEvidence = {
  releaseCommit: string;
  sourceTree: string;
};

export type ProxyDeploymentEvidence = {
  proxy: string;
  implementation: string;
  admin: string;
  proxyRuntimeCodeHash: string;
  implementationRuntimeCodeHash: string;
  adminRuntimeCodeHash: string;
};

export type RuntimeDeploymentEvidence = {
  address: string;
  runtimeCodeHash: string;
};

export type VerifierPublicKeyPoint = {
  x: string;
  y: string;
};

type VerifierPublicKeyPointLike = {
  x: BigNumberish;
  y: BigNumberish;
};

type ArtifactShape = {
  contractName: string;
  sourceName: string;
  deployedBytecode: string;
};

const sha256Json = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const sha256File = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function verifyConfigFileSha256(file: string, expected: string, label: string): string {
  if (!/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error(`${label} manifest SHA-256 is invalid`);
  }
  const actual = sha256File(file);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function uint256Hex(value: BigNumberish, label: string): string {
  let parsed: BigNumber;
  try {
    parsed = BigNumber.from(value);
  } catch (error) {
    throw new Error(`${label} is not a uint256: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.lt(0)) throw new Error(`${label} is not a uint256`);
  try {
    return utils.hexZeroPad(parsed.toHexString(), 32).toLowerCase();
  } catch {
    throw new Error(`${label} exceeds uint256`);
  }
}

export function normalizeVerifierPublicKeys(points: VerifierPublicKeyPointLike[]): VerifierPublicKeyPoint[] {
  if (!Array.isArray(points) || points.length !== 8) {
    throw new Error(
      `verifier public-key evidence must contain exactly eight points, got ${Array.isArray(points) ? points.length : 0}`
    );
  }
  return points.map((point, index) => ({
    x: uint256Hex(point.x, `verifier public key ${index}.x`),
    y: uint256Hex(point.y, `verifier public key ${index}.y`),
  }));
}

export function assertVerifierPublicKeysMatch(
  actualPoints: VerifierPublicKeyPointLike[],
  expectedPoints: VerifierPublicKeyPointLike[],
  label = 'verifier public key'
): void {
  const actual = normalizeVerifierPublicKeys(actualPoints);
  const expected = normalizeVerifierPublicKeys(expectedPoints);
  for (let index = 0; index < 8; index += 1) {
    if (actual[index].x !== expected[index].x || actual[index].y !== expected[index].y) {
      throw new Error(`${label} slot ${index} mismatch`);
    }
  }
}

export async function readVerifierPublicKeys(verifier: Contract): Promise<VerifierPublicKeyPoint[]> {
  const points = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const point = await verifier.getPubkey(index);
      return { x: point.x ?? point[0], y: point.y ?? point[1] };
    })
  );
  return normalizeVerifierPublicKeys(points);
}

export async function verifyVerifierPublicKeys(
  verifier: Contract,
  expectedPoints: VerifierPublicKeyPointLike[]
): Promise<VerifierPublicKeyPoint[]> {
  const actual = await readVerifierPublicKeys(verifier);
  assertVerifierPublicKeysMatch(actual, expectedPoints);
  return actual;
}

export function runtimeByteLength(deployedBytecode: string): number {
  if (!utils.isHexString(deployedBytecode) || deployedBytecode === '0x') {
    throw new Error('runtime bytecode must be non-empty hex');
  }
  return utils.arrayify(deployedBytecode).length;
}

export function runtimeCodeHash(deployedBytecode: string): string {
  runtimeByteLength(deployedBytecode);
  return utils.keccak256(deployedBytecode);
}

export function assertRuntimeSizeBudget(label: string, deployedBytecode: string, budgetBytes: number): number {
  const bytes = runtimeByteLength(deployedBytecode);
  if (bytes >= budgetBytes) {
    throw new Error(
      `${label} runtime is ${bytes} bytes; hard budget requires < ${budgetBytes} bytes (EIP-170 max ${EIP170_MAX_RUNTIME_BYTES})`
    );
  }
  return bytes;
}

function artifactEvidence(
  artifact: ArtifactShape,
  fullyQualifiedName: string,
  immutableReferences: Array<{ start: number; length: number }> = []
): ArtifactRuntimeEvidence {
  return {
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    fullyQualifiedName,
    runtimeByteLength: runtimeByteLength(artifact.deployedBytecode),
    runtimeCodeHash: runtimeCodeHash(artifact.deployedBytecode),
    immutableReferences,
  };
}

function readOpenZeppelinArtifact(contractName: 'ProxyAdmin' | 'TransparentUpgradeableProxy') {
  const source = `@openzeppelin/contracts/proxy/transparent/${contractName}.sol`;
  const artifactPath = require.resolve(`@openzeppelin/upgrades-core/artifacts/${source}/${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as ArtifactShape;
  return artifactEvidence(artifact, `${source}:${contractName}`);
}

export async function collectReleaseBuildEvidence(artifacts: Artifacts): Promise<ReleaseBuildEvidence> {
  const releaseArtifacts: Record<string, ArtifactRuntimeEvidence> = {};
  let compiler: CompilerEvidence | undefined;

  for (const [key, fullyQualifiedName] of Object.entries(RELEASE_ARTIFACTS)) {
    const artifact = await artifacts.readArtifact(fullyQualifiedName);
    const buildInfo = await artifacts.getBuildInfo(fullyQualifiedName);
    if (!buildInfo) throw new Error(`missing build info for ${fullyQualifiedName}`);
    const immutableReferences = Object.values(
      buildInfo.output.contracts[artifact.sourceName][artifact.contractName].evm.deployedBytecode.immutableReferences ||
        {}
    ).flat() as Array<{ start: number; length: number }>;
    releaseArtifacts[key] = artifactEvidence(artifact, fullyQualifiedName, immutableReferences);
    const candidate: CompilerEvidence = {
      solcVersion: buildInfo.solcVersion,
      solcLongVersion: buildInfo.solcLongVersion,
      settings: buildInfo.input.settings as Record<string, unknown>,
      settingsSha256: sha256Json(buildInfo.input.settings),
    };
    if (!compiler) {
      compiler = candidate;
    } else if (
      compiler.solcVersion !== candidate.solcVersion ||
      compiler.solcLongVersion !== candidate.solcLongVersion ||
      compiler.settingsSha256 !== candidate.settingsSha256
    ) {
      throw new Error(`release artifact compiler mismatch at ${fullyQualifiedName}`);
    }
  }

  releaseArtifacts.transparentUpgradeableProxy = readOpenZeppelinArtifact('TransparentUpgradeableProxy');
  releaseArtifacts.proxyAdmin = readOpenZeppelinArtifact('ProxyAdmin');

  if (!compiler) throw new Error('release compiler evidence is empty');
  assertRuntimeSizeBudget(
    'Endpoint',
    (await artifacts.readArtifact(RELEASE_ARTIFACTS.endpoint)).deployedBytecode,
    ENDPOINT_RUNTIME_BUDGET_BYTES
  );
  return { compiler, artifacts: releaseArtifacts };
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function loadReviewedSourceEvidence(
  repoRoot: string,
  expectedCommit: string | undefined,
  expectedTree: string | undefined
): ReviewedSourceEvidence {
  if (!expectedCommit || !/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error('PERPDEX_REVIEWED_RELEASE_COMMIT must be the reviewed 40-character commit');
  }
  if (!expectedTree || !/^[0-9a-f]{40}$/i.test(expectedTree)) {
    throw new Error('PERPDEX_REVIEWED_SOURCE_TREE must be the reviewed 40-character tree');
  }
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) throw new Error('refusing release evidence from a dirty source tree');
  const releaseCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  const sourceTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  if (releaseCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(`reviewed release commit mismatch: expected ${expectedCommit}, got ${releaseCommit}`);
  }
  if (sourceTree.toLowerCase() !== expectedTree.toLowerCase()) {
    throw new Error(`reviewed source tree mismatch: expected ${expectedTree}, got ${sourceTree}`);
  }
  return { releaseCommit, sourceTree };
}

function storageAddress(value: string): string {
  return utils.getAddress(utils.hexDataSlice(utils.hexZeroPad(value, 32), 12));
}

async function codeHashAt(provider: providers.Provider, address: string, label: string): Promise<string> {
  const code = await provider.getCode(address);
  if (code === '0x') throw new Error(`${label} has no runtime bytecode at ${address}`);
  return runtimeCodeHash(code);
}

export async function runtimeCodeHashAt(provider: providers.Provider, address: string, label: string): Promise<string> {
  return codeHashAt(provider, address, label);
}

function normalizedImmutableRuntime(
  deployedBytecode: string,
  immutableReferences: Array<{ start: number; length: number }>
): string {
  const bytes = utils.arrayify(deployedBytecode);
  for (const reference of immutableReferences) {
    if (reference.start < 0 || reference.length <= 0 || reference.start + reference.length > bytes.length) {
      throw new Error('artifact immutable reference is outside runtime bytecode');
    }
    bytes.fill(0, reference.start, reference.start + reference.length);
  }
  return utils.hexlify(bytes);
}

export async function inspectProxyDeployment(
  provider: providers.Provider,
  proxy: string
): Promise<ProxyDeploymentEvidence> {
  const implementation = storageAddress(await provider.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT));
  const admin = storageAddress(await provider.getStorageAt(proxy, EIP1967_ADMIN_SLOT));
  return {
    proxy: utils.getAddress(proxy),
    implementation,
    admin,
    proxyRuntimeCodeHash: await codeHashAt(provider, proxy, 'proxy'),
    implementationRuntimeCodeHash: await codeHashAt(provider, implementation, 'implementation'),
    adminRuntimeCodeHash: await codeHashAt(provider, admin, 'proxy admin'),
  };
}

function sameHash(actual: string, expected: string, label: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} runtime hash mismatch: expected ${expected}, got ${actual}`);
  }
}

export async function verifyRuntimeArtifact(
  provider: providers.Provider,
  address: string,
  artifact: ArtifactRuntimeEvidence,
  label: string,
  expectedExactRuntimeCodeHash?: string
): Promise<string> {
  const code = await provider.getCode(address);
  if (code === '0x') throw new Error(`${label} has no runtime bytecode at ${address}`);
  const exactHash = runtimeCodeHash(code);
  if (expectedExactRuntimeCodeHash) {
    sameHash(exactHash, expectedExactRuntimeCodeHash, `${label} exact manifest`);
  }
  const reviewedTemplate = normalizedImmutableRuntime(code, artifact.immutableReferences);
  sameHash(runtimeCodeHash(reviewedTemplate), artifact.runtimeCodeHash, `${label} artifact`);
  return exactHash;
}

export async function verifyActiveClearinghouseLiq(
  provider: providers.Provider,
  clearinghouse: Contract,
  record: RuntimeDeploymentEvidence,
  artifact: ArtifactRuntimeEvidence
): Promise<string> {
  const active = utils.getAddress(await clearinghouse.getClearinghouseLiq());
  const expected = utils.getAddress(record.address);
  if (active !== expected) {
    throw new Error(`active ClearinghouseLiq target mismatch: expected ${expected}, got ${active}`);
  }
  await verifyRuntimeArtifact(
    provider,
    active,
    artifact,
    'active clearinghouse liquidation implementation',
    record.runtimeCodeHash
  );
  return active;
}

export async function verifyVirtualBookProductId(
  provider: providers.Provider,
  virtualBookAddress: string,
  expectedProductId: BigNumberish,
  label: string
): Promise<void> {
  const virtualBook = new Contract(
    virtualBookAddress,
    ['function productId() external view returns (uint32)'],
    provider
  );
  const actual = BigNumber.from(await virtualBook.productId());
  const expected = BigNumber.from(expectedProductId);
  if (!actual.eq(expected)) {
    throw new Error(`${label} productId mismatch: expected ${expected.toString()}, got ${actual.toString()}`);
  }
}

export async function verifyProxyDeployment(
  provider: providers.Provider,
  record: ProxyDeploymentEvidence,
  implementationArtifact: ArtifactRuntimeEvidence,
  proxyArtifact: ArtifactRuntimeEvidence,
  adminArtifact: ArtifactRuntimeEvidence,
  label: string
): Promise<void> {
  const actual = await inspectProxyDeployment(provider, record.proxy);
  for (const field of ['implementation', 'admin'] as const) {
    if (actual[field] !== utils.getAddress(record[field])) {
      throw new Error(`${label} EIP-1967 ${field} mismatch`);
    }
  }
  sameHash(actual.proxyRuntimeCodeHash, record.proxyRuntimeCodeHash, `${label} proxy manifest`);
  sameHash(
    actual.implementationRuntimeCodeHash,
    record.implementationRuntimeCodeHash,
    `${label} implementation manifest`
  );
  sameHash(actual.adminRuntimeCodeHash, record.adminRuntimeCodeHash, `${label} admin manifest`);
  sameHash(actual.proxyRuntimeCodeHash, proxyArtifact.runtimeCodeHash, `${label} proxy artifact`);
  sameHash(
    actual.implementationRuntimeCodeHash,
    implementationArtifact.runtimeCodeHash,
    `${label} implementation artifact`
  );
  sameHash(actual.adminRuntimeCodeHash, adminArtifact.runtimeCodeHash, `${label} admin artifact`);
}

export function assertBuildEvidenceMatches(recorded: ReleaseBuildEvidence, reviewed: ReleaseBuildEvidence) {
  if (JSON.stringify(recorded) !== JSON.stringify(reviewed)) {
    throw new Error('deployment manifest build evidence does not match reviewed local artifacts');
  }
}

export const repositoryRoot = (): string => path.resolve(__dirname, '..');
