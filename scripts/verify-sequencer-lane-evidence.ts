// Replays a profile's sequencerLeverageEvidence against a local Bond-xyz/bond-perpdex
// checkout. The static gate (assertSequencerLeverageEvidence) proves shape and
// identity; this proves the pinned bytes exist and that the Trading source each lane
// boots descends from the engine floor and admits the lane's quote domain under its
// BOND_PERPS_ENV. Read-only: runs only `git` plumbing on the given checkout.
//
//   BOND_PERPDEX_CHECKOUT=/path/to/bond-perpdex PERPDEX_NETWORK=og-mainnet \
//     yarn verify:og-mainnet:sequencer-lanes
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import {
  PerpdexNetworkProfile,
  resolveNetworkProfile,
  SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT,
  SequencerLaneEvidence,
} from './deployment-config';

export const QUOTE_DOMAIN_REGISTRY_PATH = 'core/types/quote-domains.toml';
export const QUOTE_DOMAIN_SOURCE_PATH = 'core/types/src/quote_domain.rs';
const DEFAULT_QUOTE_DOMAIN = 'USDCE';

export type LaneFinding = { deployment: string; check: string; ok: boolean; detail: string };

function git(checkout: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
}

function tryGit(checkout: string, args: string[]): Buffer | null {
  try {
    return git(checkout, args);
  } catch {
    return null;
  }
}

const isAncestor = (checkout: string, ancestor: string, commit: string) =>
  tryGit(checkout, ['merge-base', '--is-ancestor', ancestor, commit]) !== null;

// `environments` of each [[quote_domain]] in core/types/quote-domains.toml. Fails
// closed (throws) on any block it cannot read rather than guessing.
export function parseQuoteDomainEnvironments(toml: string): Map<string, string[]> {
  const domains = new Map<string, string[]>();
  for (const block of toml.split(/^\[\[quote_domain\]\]\s*$/m).slice(1)) {
    const id = /^quote_domain_id\s*=\s*"([A-Z0-9]+)"/m.exec(block)?.[1];
    const envs = /^environments\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1];
    if (id === undefined || envs === undefined) throw new Error('unreadable [[quote_domain]] block');
    const list = [...envs.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    if (list.length === 0 || domains.has(id)) throw new Error(`invalid quote domain ${id}`);
    domains.set(id, list);
  }
  if (domains.size === 0) throw new Error('no quote domains');
  return domains;
}

// SEPARATE_BOOKS_ENVIRONMENTS in core/types/src/quote_domain.rs (every non-USDCE domain).
export function parseSeparateBooksEnvironments(rust: string): string[] {
  const body = /pub const SEPARATE_BOOKS_ENVIRONMENTS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\];/.exec(rust)?.[1];
  if (body === undefined) throw new Error('SEPARATE_BOOKS_ENVIRONMENTS not found');
  return body
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      if (item === 'LOCAL_ENVIRONMENT') return 'local';
      const literal = /^"([a-z]+)"$/.exec(item)?.[1];
      if (literal === undefined) throw new Error(`unreadable SEPARATE_BOOKS_ENVIRONMENTS item ${item}`);
      return literal;
    });
}

export function quoteDomainAdmitted(checkout: string, commit: string, domain: string, env: string): string | null {
  const registry = parseQuoteDomainEnvironments(
    git(checkout, ['show', `${commit}:${QUOTE_DOMAIN_REGISTRY_PATH}`]).toString()
  );
  const listed = registry.get(domain);
  if (listed === undefined) return `${domain} is not a known quote domain`;
  if (!listed.includes(env))
    return `${QUOTE_DOMAIN_REGISTRY_PATH} lists ${domain} for [${listed.join(', ')}], not ${env}`;
  if (domain !== DEFAULT_QUOTE_DOMAIN) {
    const allowed = parseSeparateBooksEnvironments(
      git(checkout, ['show', `${commit}:${QUOTE_DOMAIN_SOURCE_PATH}`]).toString()
    );
    if (!allowed.includes(env)) {
      return `${QUOTE_DOMAIN_SOURCE_PATH} SEPARATE_BOOKS_ENVIRONMENTS is [${allowed.join(', ')}], not ${env}`;
    }
  }
  return null;
}

export const LANE_BINDING_SCHEMA = 'bond-perpdex/fresh-mainnet-lane-binding/v2';

// Replays a lane-binding.json (bond-perpdex fresh-mainnet-lane-binding/v2) against the
// lane's evidence. Returns refusals; empty means the binding names exactly this lane.
export function laneBindingRefusals(bindingJson: string, lane: SequencerLaneEvidence): string[] {
  let binding: Record<string, unknown> | null;
  try {
    binding = JSON.parse(bindingJson);
  } catch {
    return ['lane binding is not JSON'];
  }
  const refusals: string[] = [];
  const expect = (what: string, actual: unknown, wanted: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      refusals.push(`${what} ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
    }
  };
  expect('schema', binding?.schema, LANE_BINDING_SCHEMA);
  expect('deployment', binding?.deployment, lane.deployment);
  expect('runtimeConfig', binding?.runtimeConfig, lane.runtimeConfigPath);
  expect('environment', binding?.environment, lane.environment);
  const env = lane.environment;
  expect('workloadEnv', binding?.workloadEnv, {
    BOND_PERPS_ENV: env.bondPerpsEnv,
    PERPDEX_QUOTE_DOMAIN: env.quoteDomain,
    PERPDEX_SEPARATE_QUOTE_BOOKS_ENABLED: String(env.separateQuoteBooksEnabled),
    DATABASE_URL: env.database?.url,
  });
  // The binding may leave the image to the release evidence (null), never name another.
  const image = binding?.tradingImage;
  if (image !== null && image !== undefined && JSON.stringify(image).indexOf(String(lane.tradingArtifact.digest)) < 0) {
    refusals.push(`tradingImage ${JSON.stringify(image)} does not name ${lane.tradingArtifact.digest}`);
  }
  return refusals;
}

export function verifySequencerLaneEvidence(
  profile: PerpdexNetworkProfile,
  checkout: string,
  floorCommit: string = SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT
): LaneFinding[] {
  const evidence = profile.sequencerLeverageEvidence.evidence;
  if (evidence === null) return [{ deployment: profile.name, check: 'evidence', ok: false, detail: 'unresolved' }];
  const findings: LaneFinding[] = [];
  const add = (deployment: string, check: string, ok: boolean, detail: string) =>
    findings.push({ deployment, check, ok, detail });
  const tree = tryGit(checkout, ['rev-parse', '--verify', `${evidence.commit}^{tree}`])
    ?.toString()
    .trim();
  add('*', 'config commit tree', tree === evidence.tree, `${evidence.commit} -> ${tree ?? 'missing'}`);
  const floorOk = isAncestor(checkout, floorCommit, evidence.commit);
  add('*', 'config commit at or after floor', floorOk, `${floorCommit} ancestor of ${evidence.commit}`);
  for (const lane of evidence.lanes) {
    for (const file of lane.files) {
      const blob = tryGit(checkout, ['rev-parse', '--verify', `${evidence.commit}:${file.path}`])
        ?.toString()
        .trim();
      const bytes = blob === undefined ? null : git(checkout, ['cat-file', 'blob', blob]);
      const sha256 = bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
      add(
        lane.deployment,
        `file ${file.path}`,
        blob === file.blob && sha256 === file.sha256,
        `blob ${blob ?? 'missing'} sha256 ${sha256 ?? 'missing'}`
      );
    }
    const bindingBytes = tryGit(checkout, ['show', `${evidence.commit}:${lane.laneBindingPath}`]);
    const bindingRefusals =
      bindingBytes === null ? ['missing at config commit'] : laneBindingRefusals(bindingBytes.toString(), lane);
    add(
      lane.deployment,
      `lane binding ${lane.laneBindingPath}`,
      bindingRefusals.length === 0,
      bindingRefusals.join('; ') || 'deployment, environment, workload env and runtime config match'
    );
    const artifact = lane.tradingArtifact;
    let source = artifact.sourceCommit;
    if (source === null) {
      add(lane.deployment, 'Trading artifact', false, 'digest unresolved (no image at or after floor)');
      // Still show whether the config commit's own source would admit the lane.
      source = evidence.commit;
    } else {
      const artifactTree = tryGit(checkout, ['rev-parse', '--verify', `${source}^{tree}`])
        ?.toString()
        .trim();
      add(
        lane.deployment,
        'Trading source tree',
        artifactTree === artifact.sourceTree,
        `${source} -> ${artifactTree ?? 'missing'}`
      );
      add(lane.deployment, 'Trading source at or after floor', isAncestor(checkout, floorCommit, source), source);
    }
    const refusal = quoteDomainAdmitted(checkout, source, lane.environment.quoteDomain, lane.environment.bondPerpsEnv);
    add(
      lane.deployment,
      `quote domain ${lane.environment.quoteDomain} under BOND_PERPS_ENV=${
        lane.environment.bondPerpsEnv
      } at ${source.slice(0, 8)}`,
      refusal === null,
      refusal ?? 'admitted'
    );
  }
  return findings;
}

if (require.main === module) {
  const checkout = process.env.BOND_PERPDEX_CHECKOUT;
  if (!checkout) throw new Error('BOND_PERPDEX_CHECKOUT must name a local Bond-xyz/bond-perpdex checkout');
  const profile = resolveNetworkProfile();
  const findings = verifySequencerLaneEvidence(profile, checkout);
  for (const finding of findings) {
    console.log(`${finding.ok ? 'PASS' : 'FAIL'} ${finding.deployment} ${finding.check}: ${finding.detail}`);
  }
  if (findings.some((finding) => !finding.ok)) {
    console.error(`${profile.name} sequencer lane evidence does not verify; mainnet deployment stays blocked`);
    process.exitCode = 1;
  }
}
