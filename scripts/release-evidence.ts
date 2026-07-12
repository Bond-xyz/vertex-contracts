import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BigNumber, BigNumberish, Contract, providers, utils } from 'ethers';
import type { Artifacts } from 'hardhat/types';
import appSolc = require('solc-0.8.13');
import proxySolc = require('solc-0.8.9');
import type { GalileoDeploymentProducts } from './deployment-config';

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
  buildInfoId: string;
  creationByteLength: number;
  creationCodeHash: string;
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

export type BuildSourceEvidence = {
  byteLength: number;
  sha256: string;
  binding: 'reviewed-source-tree' | 'installed-dependency' | 'bundled-upgrades-core-build-input';
  file: string;
};

export type SolcBuildInfoEvidence = CompilerEvidence & {
  buildInfoId: string;
  inputSha256: string;
  outputSha256: string;
  provenanceFile: string;
  provenanceFileSha256: string;
  sources: Record<string, BuildSourceEvidence>;
};

export type ReleaseBuildEvidence = {
  compiler: CompilerEvidence;
  buildInfos: Record<string, SolcBuildInfoEvidence>;
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

export type ContractCreationEvidence = {
  address: string;
  transactionHash: string;
  transactionNonce: number;
  blockNumber: number;
  blockHash: string;
  deployer: string;
};

export type ProxyDeploymentProvenance = {
  proxy: ContractCreationEvidence;
  implementation: ContractCreationEvidence;
  admin: ContractCreationEvidence;
  adminOwner: string;
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
  bytecode: string;
  deployedBytecode: string;
};

type SolcContractOutput = {
  evm: {
    bytecode: { object: string };
    deployedBytecode: {
      object: string;
      immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
    };
  };
};

export type SolcBuildInfoShape = {
  id?: string;
  solcVersion?: string;
  solcLongVersion: string;
  input: {
    settings: Record<string, unknown>;
    sources: Record<string, { content?: string }>;
  };
  output?: {
    contracts: Record<string, Record<string, SolcContractOutput>>;
    errors?: Array<{ severity: string; formattedMessage?: string; message?: string }>;
  };
};

type SolcCompiler = {
  version(): string;
  compile(input: string): string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export const deterministicSha256 = (value: unknown): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

const sha256Text = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export const sha256File = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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

export type VerifierQuorumEvidence = {
  signerCount: number;
  signerBitmask: number;
  publicKeys: VerifierPublicKeyPoint[];
};

function signerMask(points: VerifierPublicKeyPoint[]): number {
  return points.reduce((mask, point, index) => {
    const nonzero = BigNumber.from(point.x).or(BigNumber.from(point.y)).isZero() === false;
    return nonzero ? mask | (1 << index) : mask;
  }, 0);
}

export async function readVerifierQuorumConfiguration(verifier: Contract): Promise<VerifierQuorumEvidence> {
  const publicKeys = await readVerifierPublicKeys(verifier);
  return {
    signerCount: BigNumber.from(await verifier.getSignerCount()).toNumber(),
    signerBitmask: signerMask(publicKeys),
    publicKeys,
  };
}

export async function verifyVerifierQuorumConfiguration(
  verifier: Contract,
  expectedPoints: VerifierPublicKeyPointLike[],
  expectedSignerCount: number,
  expectedSignerBitmask: number
): Promise<VerifierQuorumEvidence> {
  const actual = await readVerifierQuorumConfiguration(verifier);
  assertVerifierPublicKeysMatch(actual.publicKeys, expectedPoints);
  if (actual.signerCount !== expectedSignerCount) {
    throw new Error(`verifier signer count mismatch: expected ${expectedSignerCount}, got ${actual.signerCount}`);
  }
  if (actual.signerBitmask !== expectedSignerBitmask) {
    throw new Error(`verifier signer bitmask mismatch: expected ${expectedSignerBitmask}, got ${actual.signerBitmask}`);
  }
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
  buildInfoId: string,
  immutableReferences: Array<{ start: number; length: number }> = []
): ArtifactRuntimeEvidence {
  return {
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    fullyQualifiedName,
    buildInfoId,
    creationByteLength: runtimeByteLength(artifact.bytecode),
    creationCodeHash: runtimeCodeHash(artifact.bytecode),
    runtimeByteLength: runtimeByteLength(artifact.deployedBytecode),
    runtimeCodeHash: runtimeCodeHash(artifact.deployedBytecode),
    immutableReferences,
  };
}

function prefixedBytecode(object: string, label: string): string {
  if (!/^[0-9a-f]*$/i.test(object) || object.length === 0 || object.length % 2 !== 0) {
    throw new Error(`${label} solc bytecode is not non-empty whole-byte hex`);
  }
  return `0x${object}`;
}

export function assertArtifactMatchesBuildInfo(
  artifact: ArtifactShape,
  output: SolcContractOutput,
  fullyQualifiedName: string
): void {
  const creation = prefixedBytecode(output.evm.bytecode.object, `${fullyQualifiedName} creation`);
  const runtime = prefixedBytecode(output.evm.deployedBytecode.object, `${fullyQualifiedName} runtime`);
  if (artifact.bytecode.toLowerCase() !== creation.toLowerCase()) {
    throw new Error(`${fullyQualifiedName} artifact creation bytecode does not match solc build-info output`);
  }
  if (artifact.deployedBytecode.toLowerCase() !== runtime.toLowerCase()) {
    throw new Error(`${fullyQualifiedName} artifact runtime bytecode does not match solc build-info output`);
  }
}

function compileBuildInfoInput(
  buildInfo: SolcBuildInfoShape,
  compiler: SolcCompiler,
  requiredSolcVersion: string,
  label: string
): NonNullable<SolcBuildInfoShape['output']> {
  const declaredVersion = buildInfo.solcVersion || buildInfo.solcLongVersion.split('+')[0];
  if (declaredVersion !== requiredSolcVersion) {
    throw new Error(`${label} must use exact solc ${requiredSolcVersion}, got ${declaredVersion}`);
  }
  const actualCompiler = compiler.version();
  if (actualCompiler !== `${buildInfo.solcLongVersion}.Emscripten.clang`) {
    throw new Error(`${label} compiler mismatch: expected ${buildInfo.solcLongVersion}, got ${actualCompiler}`);
  }
  const output = JSON.parse(compiler.compile(JSON.stringify(buildInfo.input))) as NonNullable<
    SolcBuildInfoShape['output']
  >;
  const compilerErrors = (output.errors || []).filter((error) => error.severity === 'error');
  if (compilerErrors.length > 0) {
    throw new Error(
      `${label} deterministic compile failed: ${compilerErrors
        .map((error) => error.formattedMessage || error.message)
        .join('\n')}`
    );
  }
  return output;
}

export function reproduceApplicationBuildInfo(
  buildInfo: SolcBuildInfoShape
): NonNullable<SolcBuildInfoShape['output']> {
  if (!buildInfo.output) throw new Error('application build-info has no recorded output');
  const reproduced = compileBuildInfoInput(buildInfo, appSolc, '0.8.13', 'application build');
  const securityRelevantOutput = (output: NonNullable<SolcBuildInfoShape['output']>) => ({
    contracts: output.contracts,
    errors: output.errors || [],
    sourceIds: Object.fromEntries(
      Object.entries((output as unknown as { sources?: Record<string, { id: number }> }).sources || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sourceName, source]) => [sourceName, source.id])
    ),
  });
  // solc-js and Hardhat serialize a few negative AST declaration sentinels differently
  // (signed vs uint32), so compare deterministic bytecode/ABI/errors/source IDs rather than AST JSON spelling.
  if (
    deterministicSha256(securityRelevantOutput(reproduced)) !==
    deterministicSha256(securityRelevantOutput(buildInfo.output))
  ) {
    throw new Error('application build-info output does not match deterministic solc 0.8.13 reproduction');
  }
  return reproduced;
}

function sourceEvidenceFromFiles(
  repoRoot: string,
  sources: Record<string, { content?: string }>
): Record<string, BuildSourceEvidence> {
  return Object.fromEntries(
    Object.entries(sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceName, source]) => {
        if (typeof source.content !== 'string')
          throw new Error(`build-info source ${sourceName} has no literal content`);
        const reviewedFile = path.resolve(repoRoot, sourceName);
        const dependencyFile = path.resolve(repoRoot, 'node_modules', sourceName);
        const file = fs.existsSync(reviewedFile) ? reviewedFile : dependencyFile;
        if (!fs.existsSync(file)) throw new Error(`build-info source ${sourceName} has no matching reviewed file`);
        const fileContent = fs.readFileSync(file, 'utf8');
        if (fileContent !== source.content) {
          throw new Error(`build-info source ${sourceName} differs from ${path.relative(repoRoot, file)}`);
        }
        const relativeFile = path.relative(repoRoot, file);
        return [
          sourceName,
          {
            byteLength: Buffer.byteLength(source.content),
            sha256: sha256Text(source.content),
            binding: relativeFile.startsWith(`node_modules${path.sep}`)
              ? 'installed-dependency'
              : 'reviewed-source-tree',
            file: relativeFile.split(path.sep).join('/'),
          },
        ];
      })
  );
}

function embeddedSourceEvidence(
  sources: Record<string, { content?: string }>,
  provenanceFile: string
): Record<string, BuildSourceEvidence> {
  return Object.fromEntries(
    Object.entries(sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceName, source]) => {
        if (typeof source.content !== 'string')
          throw new Error(`proxy build source ${sourceName} has no literal content`);
        return [
          sourceName,
          {
            byteLength: Buffer.byteLength(source.content),
            sha256: sha256Text(source.content),
            binding: 'bundled-upgrades-core-build-input',
            file: `${provenanceFile}#input.sources/${sourceName}`,
          },
        ];
      })
  );
}

function buildInfoEvidence(
  buildInfoId: string,
  buildInfo: SolcBuildInfoShape,
  output: NonNullable<SolcBuildInfoShape['output']>,
  provenanceFile: string,
  provenanceFileSha256: string,
  sources: Record<string, BuildSourceEvidence>
): SolcBuildInfoEvidence {
  const solcVersion = buildInfo.solcVersion || buildInfo.solcLongVersion.split('+')[0];
  return {
    buildInfoId,
    solcVersion,
    solcLongVersion: buildInfo.solcLongVersion,
    settings: buildInfo.input.settings,
    settingsSha256: deterministicSha256(buildInfo.input.settings),
    inputSha256: deterministicSha256(buildInfo.input),
    outputSha256: deterministicSha256(output),
    provenanceFile,
    provenanceFileSha256,
    sources,
  };
}

function collectOpenZeppelinProxyBuildEvidence(repoRoot: string): {
  buildInfo: SolcBuildInfoEvidence;
  artifacts: Record<string, ArtifactRuntimeEvidence>;
} {
  const buildInfoFile = require.resolve('@openzeppelin/upgrades-core/artifacts/build-info.json');
  const packageBuildInfo = JSON.parse(fs.readFileSync(buildInfoFile, 'utf8')) as SolcBuildInfoShape;
  const output = compileBuildInfoInput(packageBuildInfo, proxySolc, '0.8.9', 'OpenZeppelin proxy build');
  const buildInfoId = 'openzeppelin-upgrades-core-proxies-solc-0.8.9';
  const artifacts: Record<string, ArtifactRuntimeEvidence> = {};
  for (const [key, contractName] of [
    ['transparentUpgradeableProxy', 'TransparentUpgradeableProxy'],
    ['proxyAdmin', 'ProxyAdmin'],
  ] as const) {
    const sourceName = `@openzeppelin/contracts/proxy/transparent/${contractName}.sol`;
    const fullyQualifiedName = `${sourceName}:${contractName}`;
    const artifactFile = require.resolve(`@openzeppelin/upgrades-core/artifacts/${sourceName}/${contractName}.json`);
    const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8')) as ArtifactShape;
    const contractOutput = output.contracts?.[sourceName]?.[contractName];
    if (!contractOutput) throw new Error(`recompiled proxy output is missing ${fullyQualifiedName}`);
    assertArtifactMatchesBuildInfo(artifact, contractOutput, fullyQualifiedName);
    const immutableReferences = Object.values(contractOutput.evm.deployedBytecode.immutableReferences || {}).flat();
    artifacts[key] = artifactEvidence(artifact, fullyQualifiedName, buildInfoId, immutableReferences);
  }
  const provenanceFile = path.relative(repoRoot, buildInfoFile).split(path.sep).join('/');
  return {
    buildInfo: buildInfoEvidence(
      buildInfoId,
      packageBuildInfo,
      output,
      provenanceFile,
      sha256File(buildInfoFile),
      embeddedSourceEvidence(packageBuildInfo.input.sources, provenanceFile)
    ),
    artifacts,
  };
}

export async function collectReleaseBuildEvidence(artifacts: Artifacts): Promise<ReleaseBuildEvidence> {
  const repoRoot = repositoryRoot();
  const releaseArtifacts: Record<string, ArtifactRuntimeEvidence> = {};
  let compiler: CompilerEvidence | undefined;
  const buildInfos: Record<string, SolcBuildInfoEvidence> = {};
  const reproducedOutputs = new Map<string, NonNullable<SolcBuildInfoShape['output']>>();

  for (const [key, fullyQualifiedName] of Object.entries(RELEASE_ARTIFACTS)) {
    const artifact = (await artifacts.readArtifact(fullyQualifiedName)) as ArtifactShape;
    const buildInfo = (await artifacts.getBuildInfo(fullyQualifiedName)) as SolcBuildInfoShape | undefined;
    if (!buildInfo) throw new Error(`missing build info for ${fullyQualifiedName}`);
    if (!buildInfo.output) throw new Error(`build info has no output for ${fullyQualifiedName}`);
    const buildInfoId = `hardhat-${buildInfo.id || deterministicSha256(buildInfo.input)}`;
    let reproducedOutput = reproducedOutputs.get(buildInfoId);
    if (!reproducedOutput) {
      reproducedOutput = reproduceApplicationBuildInfo(buildInfo);
      reproducedOutputs.set(buildInfoId, reproducedOutput);
    }
    const contractOutput = reproducedOutput.contracts?.[artifact.sourceName]?.[artifact.contractName];
    if (!contractOutput) throw new Error(`build info output is missing ${fullyQualifiedName}`);
    assertArtifactMatchesBuildInfo(artifact, contractOutput, fullyQualifiedName);
    const immutableReferences = Object.values(
      contractOutput.evm.deployedBytecode.immutableReferences || {}
    ).flat() as Array<{ start: number; length: number }>;
    releaseArtifacts[key] = artifactEvidence(artifact, fullyQualifiedName, buildInfoId, immutableReferences);
    const candidate: CompilerEvidence = {
      solcVersion: buildInfo.solcVersion || buildInfo.solcLongVersion.split('+')[0],
      solcLongVersion: buildInfo.solcLongVersion,
      settings: buildInfo.input.settings as Record<string, unknown>,
      settingsSha256: deterministicSha256(buildInfo.input.settings),
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
    if (!buildInfos[buildInfoId]) {
      const generatedBuildInfoFile = path.resolve(repoRoot, 'artifacts', 'build-info', `${buildInfo.id}.json`);
      if (!buildInfo.id || !fs.existsSync(generatedBuildInfoFile)) {
        throw new Error(`generated build-info file is missing for ${fullyQualifiedName}`);
      }
      buildInfos[buildInfoId] = buildInfoEvidence(
        buildInfoId,
        buildInfo,
        reproducedOutput,
        path.relative(repoRoot, generatedBuildInfoFile).split(path.sep).join('/'),
        sha256File(generatedBuildInfoFile),
        sourceEvidenceFromFiles(repoRoot, buildInfo.input.sources)
      );
    }
  }

  const proxyBuild = collectOpenZeppelinProxyBuildEvidence(repoRoot);
  Object.assign(releaseArtifacts, proxyBuild.artifacts);
  buildInfos[proxyBuild.buildInfo.buildInfoId] = proxyBuild.buildInfo;

  if (!compiler) throw new Error('release compiler evidence is empty');
  assertRuntimeSizeBudget(
    'Endpoint',
    (await artifacts.readArtifact(RELEASE_ARTIFACTS.endpoint)).deployedBytecode,
    ENDPOINT_RUNTIME_BUDGET_BYTES
  );
  return { compiler, buildInfos, artifacts: releaseArtifacts };
}

export const releaseBuildEvidenceSha256 = (build: ReleaseBuildEvidence): string => deterministicSha256(build);

export function assertFreshOpenZeppelinManifestAbsent(
  repoRoot: string,
  chainId: number,
  manifestFile = `.openzeppelin/unknown-${chainId}.json`
): void {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('OpenZeppelin manifest chain ID is invalid');
  const manifestDir = path.resolve(repoRoot, '.openzeppelin');
  const candidates = new Set([
    path.resolve(repoRoot, manifestFile),
    path.resolve(manifestDir, `unknown-${chainId}.json`),
  ]);
  for (const candidate of candidates) {
    const relative = path.relative(manifestDir, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('OpenZeppelin manifest path escapes the repository manifest directory');
    }
    if (fs.existsSync(candidate)) {
      throw new Error(`fresh deployment requires absent OpenZeppelin network manifest: ${candidate}`);
    }
  }
}

export async function collectContractCreationEvidence(
  provider: providers.Provider,
  address: string,
  transactionHash: string,
  expectedDeployer: string,
  label: string,
  minimumNonce = 0
): Promise<ContractCreationEvidence> {
  const expectedAddress = utils.getAddress(address);
  const deployer = utils.getAddress(expectedDeployer);
  if (!utils.isHexString(transactionHash, 32)) throw new Error(`${label} creation transaction hash is invalid`);
  const transaction = await provider.getTransaction(transactionHash);
  if (!transaction) throw new Error(`${label} creation transaction is unavailable`);
  if (transaction.to !== null) throw new Error(`${label} provenance is not a contract-creation transaction`);
  if (utils.getAddress(transaction.from) !== deployer) throw new Error(`${label} creation deployer mismatch`);
  if (!Number.isSafeInteger(transaction.nonce) || transaction.nonce < minimumNonce) {
    throw new Error(`${label} creation nonce predates the signed deployment intent`);
  }
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} creation transaction did not succeed`);
  if (!receipt.contractAddress || utils.getAddress(receipt.contractAddress) !== expectedAddress) {
    throw new Error(`${label} creation receipt contract address mismatch`);
  }
  if ((await provider.getCode(expectedAddress)) === '0x') throw new Error(`${label} creation address has no bytecode`);
  return {
    address: expectedAddress,
    transactionHash: transaction.hash,
    transactionNonce: transaction.nonce,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    deployer,
  };
}

export async function verifyContractCreationEvidence(
  provider: providers.Provider,
  recorded: ContractCreationEvidence,
  expectedAddress: string,
  expectedDeployer: string,
  label: string,
  minimumNonce = 0
): Promise<void> {
  const actual = await collectContractCreationEvidence(
    provider,
    expectedAddress,
    recorded.transactionHash,
    expectedDeployer,
    label,
    minimumNonce
  );
  if (deterministicSha256(actual) !== deterministicSha256(recorded)) {
    throw new Error(`${label} creation transaction/block provenance mismatch`);
  }
}

export async function verifyProxyAdminOwner(
  provider: providers.Provider,
  adminAddress: string,
  expectedOwner: string,
  label = 'ProxyAdmin'
): Promise<string> {
  const admin = new Contract(adminAddress, ['function owner() view returns (address)'], provider);
  const owner = utils.getAddress(await admin.owner());
  if (owner !== utils.getAddress(expectedOwner)) throw new Error(`${label} owner mismatch`);
  return owner;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function loadCurrentCleanSourceEvidence(repoRoot: string): ReviewedSourceEvidence {
  const releaseCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  const sourceTree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  return loadReviewedSourceEvidence(repoRoot, releaseCommit, sourceTree);
}

export function loadReviewedSourceEvidence(
  repoRoot: string,
  expectedCommit: string | undefined,
  expectedTree: string | undefined
): ReviewedSourceEvidence {
  if (!expectedCommit || !/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error('reviewed release commit must be a 40-character Git object');
  }
  if (!expectedTree || !/^[0-9a-f]{40}$/i.test(expectedTree)) {
    throw new Error('reviewed source tree must be a 40-character Git object');
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

type LiveContract = Record<string, (...args: unknown[]) => Promise<unknown>>;

export type LiveMarketContracts = {
  clearinghouse: LiveContract;
  spotEngine: LiveContract;
  perpEngine: LiveContract;
  offchainExchange: LiveContract;
};

async function overloadedCall(
  contract: LiveContract,
  signature: string,
  fallback: string,
  args: unknown[] = []
): Promise<unknown> {
  const method = contract[signature] || contract[fallback];
  if (typeof method !== 'function') throw new Error(`live contract is missing ${signature}`);
  return method(...args);
}

function exactNumberSet(actual: unknown[], expected: number[], label: string): void {
  const actualValues = actual.map((value) => BigNumber.from(value).toNumber()).sort((left, right) => left - right);
  const expectedValues = [...expected].sort((left, right) => left - right);
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(`${label} mismatch: expected ${expectedValues.join(',')}, got ${actualValues.join(',')}`);
  }
}

function exactNumberish(actual: unknown, expected: BigNumberish, label: string): void {
  let matches = false;
  try {
    matches = BigNumber.from(actual).eq(BigNumber.from(expected));
  } catch {
    matches = false;
  }
  if (!matches) throw new Error(`${label} mismatch`);
}

function tupleValue(value: unknown, name: string, index: number): unknown {
  const tuple = value as Record<string | number, unknown>;
  return tuple?.[name] ?? tuple?.[index];
}

export async function verifyLiveMarketConfiguration(
  contracts: LiveMarketContracts,
  reviewedConfig: Pick<GalileoDeploymentProducts, 'spreads' | 'products'>,
  expectedQuoteToken: string
): Promise<void> {
  const expectedProductIds = reviewedConfig.products.map((product) => product.productId);
  const spotProductIds = await overloadedCall(contracts.spotEngine, 'getProductIds()', 'getProductIds');
  const perpProductIds = await overloadedCall(contracts.perpEngine, 'getProductIds()', 'getProductIds');
  exactNumberSet(spotProductIds, [0], 'spot-engine product ID set');
  exactNumberSet(perpProductIds, expectedProductIds, 'perp-engine product ID set');

  exactNumberish(await contracts.clearinghouse.getSpreads(), reviewedConfig.spreads, 'clearinghouse spreads');
  const expectedQuote = utils.getAddress(expectedQuoteToken);
  const clearinghouseQuote = utils.getAddress(await contracts.clearinghouse.getQuote());
  if (clearinghouseQuote !== expectedQuote) throw new Error('clearinghouse quote token mismatch');
  const spotQuote = utils.getAddress(await contracts.spotEngine.getToken(0));
  if (spotQuote !== expectedQuote) throw new Error('spot-engine product 0 token mismatch');

  for (const product of reviewedConfig.products) {
    const label = `${product.symbol} product ${product.productId}`;
    const risk = await contracts.perpEngine.getRisk(product.productId);
    for (const [name, index, expected] of [
      ['longWeightInitialX18', 0, BigNumber.from(product.risk.longWeightInitial).mul(1_000_000_000)],
      ['shortWeightInitialX18', 1, BigNumber.from(product.risk.shortWeightInitial).mul(1_000_000_000)],
      ['longWeightMaintenanceX18', 2, BigNumber.from(product.risk.longWeightMaintenance).mul(1_000_000_000)],
      ['shortWeightMaintenanceX18', 3, BigNumber.from(product.risk.shortWeightMaintenance).mul(1_000_000_000)],
      ['priceX18', 4, product.risk.priceX18],
    ] as const) {
      exactNumberish(tupleValue(risk, name, index), expected, `${label} risk.${name}`);
    }
    exactNumberish(
      await contracts.offchainExchange.getSizeIncrement(product.productId),
      product.sizeIncrementX18,
      `${label} size increment`
    );
    exactNumberish(
      await contracts.offchainExchange.getMinSize(product.productId),
      product.minSizeX18,
      `${label} min size`
    );
    const lpParams = await contracts.offchainExchange.getLpParams(product.productId);
    exactNumberish(tupleValue(lpParams, 'lpSpreadX18', 0), product.lpSpreadX18, `${label} LP spread`);
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
  if (releaseBuildEvidenceSha256(recorded) !== releaseBuildEvidenceSha256(reviewed)) {
    throw new Error('deployment manifest build evidence does not match reviewed local artifacts');
  }
}

export const repositoryRoot = (): string => path.resolve(__dirname, '..');
