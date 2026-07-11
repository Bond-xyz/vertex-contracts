import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { artifacts } from 'hardhat';
import { utils } from 'ethers';

const BASELINE_FILE = path.resolve(__dirname, '..', 'config', 'galileo.contract-baseline.json');
export const ENDPOINT_RUNTIME_BUDGET_BYTES = 24_560;

type ContractBaseline = {
  source: string;
  runtimeBytes: number;
  runtimeCodeHash: string;
  functions: string[];
  events: string[];
  errors: string[];
  storage: string[];
};

type Baseline = {
  schemaVersion: number;
  baselineCommit: string;
  compiler: { solc: string; optimizer: { enabled: boolean; runs: number } };
  contracts: Record<string, ContractBaseline>;
};

export type ContractInterfaceDiffEntry = {
  source: string;
  runtime: {
    beforeBytes: number;
    afterBytes: number;
    deltaBytes: number;
    beforeCodeHash: string;
    afterCodeHash: string;
  };
  functions: { added: string[]; removed: string[] };
  events: { added: string[]; removed: string[] };
  errors: { added: string[]; removed: string[] };
  storage: { appended: string[] };
};

const sorted = (values: string[]) => [...values].sort();
const added = (before: string[], after: string[]) => sorted(after.filter((value) => !before.includes(value)));
const removed = (before: string[], after: string[]) => sorted(before.filter((value) => !after.includes(value)));
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const normalizeStorageType = (value: string): string =>
  value.replace(/(t_(?:contract|struct|enum)\([^)]*\))\d+/g, '$1');

function assertExact(actual: unknown, expected: unknown, label: string): void {
  if (!equal(actual, expected)) throw new Error(`${label} differs from the reviewed contract baseline`);
}

async function snapshotContract(baseline: ContractBaseline) {
  const separator = baseline.source.lastIndexOf(':');
  const sourceName = baseline.source.slice(0, separator);
  const contractName = baseline.source.slice(separator + 1);
  const artifact = await artifacts.readArtifact(baseline.source);
  const buildInfo = await artifacts.getBuildInfo(baseline.source);
  if (!buildInfo) throw new Error(`missing build info for ${baseline.source}`);
  const output = buildInfo.output.contracts[sourceName]?.[contractName];
  if (!output?.storageLayout) throw new Error(`missing storage layout for ${baseline.source}`);
  const iface = new utils.Interface(artifact.abi);
  const signatures = (fragments: Record<string, utils.Fragment>) =>
    sorted(Object.values(fragments).map((fragment) => fragment.format()));
  return {
    solc: buildInfo.solcVersion,
    optimizer: buildInfo.input.settings.optimizer,
    runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
    runtimeCodeHash: utils.keccak256(artifact.deployedBytecode),
    functions: signatures(iface.functions),
    events: signatures(iface.events),
    errors: signatures(iface.errors),
    storage: output.storageLayout.storage.map(
      (entry) => `${entry.slot}:${entry.offset}:${entry.label}:${normalizeStorageType(entry.type)}`
    ),
  };
}

export async function collectContractInterfaceDiff() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Baseline;
  if (baseline.schemaVersion !== 1) throw new Error('unsupported Galileo contract baseline schema');
  const contracts: Record<string, ContractInterfaceDiffEntry> = {};
  const report = {
    schemaVersion: 1,
    baselineCommit: baseline.baselineCommit,
    compiler: baseline.compiler,
    contracts,
  };

  for (const [key, expected] of Object.entries(baseline.contracts)) {
    const current = await snapshotContract(expected);
    if (
      current.solc !== baseline.compiler.solc ||
      current.optimizer?.enabled !== baseline.compiler.optimizer.enabled ||
      current.optimizer?.runs !== baseline.compiler.optimizer.runs
    ) {
      throw new Error(`${key} compiler settings drifted from the reviewed baseline`);
    }
    const storagePrefix = current.storage.slice(0, expected.storage.length);
    assertExact(storagePrefix, expected.storage, `${key} storage prefix`);
    const contractReport = {
      source: expected.source,
      runtime: {
        beforeBytes: expected.runtimeBytes,
        afterBytes: current.runtimeBytes,
        deltaBytes: current.runtimeBytes - expected.runtimeBytes,
        beforeCodeHash: expected.runtimeCodeHash,
        afterCodeHash: current.runtimeCodeHash,
      },
      functions: {
        added: added(expected.functions, current.functions),
        removed: removed(expected.functions, current.functions),
      },
      events: {
        added: added(expected.events, current.events),
        removed: removed(expected.events, current.events),
      },
      errors: {
        added: added(expected.errors, current.errors),
        removed: removed(expected.errors, current.errors),
      },
      storage: { appended: current.storage.slice(expected.storage.length) },
    };
    report.contracts[key] = contractReport;
  }

  assertExact(contracts.endpoint.functions, { added: [], removed: [] }, 'Endpoint function ABI');
  assertExact(
    contracts.endpoint.events,
    { added: ['SlowModeTransactionFailed(uint64)'], removed: [] },
    'Endpoint event ABI'
  );
  assertExact(contracts.endpoint.errors, { added: ['DepositsDisabled()'], removed: [] }, 'Endpoint error ABI');
  assertExact(contracts.endpoint.storage, { appended: [] }, 'Endpoint storage');
  if (contracts.endpoint.runtime.afterBytes >= ENDPOINT_RUNTIME_BUDGET_BYTES) {
    throw new Error(
      `Endpoint runtime ${contracts.endpoint.runtime.afterBytes} exceeds the ${ENDPOINT_RUNTIME_BUDGET_BYTES}-byte release budget`
    );
  }

  assertExact(
    contracts.clearinghouse.functions,
    { added: ['getReleaseMode()', 'setReleaseMode(uint8)'], removed: [] },
    'Clearinghouse function ABI'
  );
  assertExact(
    contracts.clearinghouse.events,
    {
      added: ['ReleaseModeChanged(uint8,uint8)', 'WithdrawalSettled(bytes32,uint32,address,address,uint128,int128)'],
      removed: [],
    },
    'Clearinghouse event ABI'
  );
  assertExact(
    contracts.clearinghouse.errors,
    {
      added: [
        'ExitModeLiabilitiesRemain(uint32)',
        'ExitModeRequiresCloseOnly()',
        'NewOrdersDisabled()',
        'ReleaseModeRegression()',
      ],
      removed: [],
    },
    'Clearinghouse error ABI'
  );
  assertExact(
    contracts.clearinghouse.storage,
    { appended: ['113:0:releaseMode:t_uint8'] },
    'Clearinghouse appended storage'
  );

  assertExact(contracts.offchainExchange.functions, { added: [], removed: [] }, 'OffchainExchange function ABI');
  assertExact(contracts.offchainExchange.events, { added: [], removed: [] }, 'OffchainExchange event ABI');
  assertExact(
    contracts.offchainExchange.errors,
    { added: ['NewOrdersDisabled()'], removed: [] },
    'OffchainExchange error ABI'
  );
  assertExact(contracts.offchainExchange.storage, { appended: [] }, 'OffchainExchange storage');

  assertExact(contracts.virtualBook.functions, { added: [], removed: [] }, 'VirtualBook function ABI');
  assertExact(contracts.virtualBook.events, { added: [], removed: [] }, 'VirtualBook event ABI');
  assertExact(contracts.virtualBook.errors, { added: [], removed: [] }, 'VirtualBook error ABI');
  assertExact(contracts.virtualBook.storage, { appended: [] }, 'VirtualBook storage');
  if (contracts.virtualBook.runtime.afterCodeHash !== contracts.virtualBook.runtime.beforeCodeHash) {
    throw new Error('VirtualBook runtime changed from the reviewed market-domain marker');
  }

  const canonical = JSON.stringify(report);
  return {
    ...report,
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
  };
}

async function main() {
  const report = await collectContractInterfaceDiff();
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const reportFile = process.env.PERPDEX_CONTRACT_DIFF_REPORT;
  if (reportFile) {
    const resolved = path.resolve(reportFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, output, { mode: 0o600, flag: 'wx' });
    console.log(`Contract diff report written to ${resolved}`);
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
