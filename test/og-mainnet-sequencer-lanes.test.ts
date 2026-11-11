import { expect } from 'chai';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE,
  PerpdexNetworkProfile,
  resolveNetworkProfile,
  SEQUENCER_RESERVED_TRADING_DATABASES,
  SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT,
  SEQUENCER_TRADING_IMAGE_REPOSITORY,
  SequencerLaneEvidence,
} from '../scripts/deployment-config';
import { assertSequencerLeverageEvidence } from '../scripts/stork-deployment-snapshot';
import {
  parseQuoteDomainEnvironments,
  parseSeparateBooksEnvironments,
  LANE_BINDING_SCHEMA,
  laneBindingRefusals,
  verifySequencerLaneEvidence,
} from '../scripts/verify-sequencer-lane-evidence';
import { RESOLVED_LANES, SequencerEvidence, withLane, withSequencerEvidence } from './helpers/sequencer-lanes';

const mainnet = resolveNetworkProfile('og-mainnet');
const usdz = resolveNetworkProfile('og-mainnet-usdz');
const LANE_DIR = 'deploy/candidates/production/fresh-mainnet-launch';
const gate = (profile: PerpdexNetworkProfile) => () => assertSequencerLeverageEvidence(profile);

describe('og-mainnet sequencer lane evidence', () => {
  it('pins both lanes to bond-perpdex f1604545 (#2973 configs, #2977 bindings) with exact blob and SHA-256', () => {
    for (const profile of [mainnet, usdz]) {
      expect(profile.sequencerLeverageEvidence.required).to.equal(true);
      expect(profile.sequencerLeverageEvidence.evidence).to.equal(OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE);
    }
    const evidence = OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE;
    expect(evidence.repository).to.equal('Bond-xyz/bond-perpdex');
    expect(evidence.commit).to.equal('f16045451a96ad3ac77299903fdde200b2ac0044');
    expect(evidence.tree).to.equal('bc5fdc649e3e31c3f280d3b0b53d1f318dc346d9');
    expect(evidence.maxLeverage).to.equal(1);
    expect(evidence.shortOpeningCollateralPpb).to.equal(1_000_000_001);
    expect(SEQUENCER_TRADING_IMAGE_FLOOR_COMMIT).to.equal('d7b15fd713355866f35fa5ccf971936ea47a4d47');
    const byLane = Object.fromEntries(evidence.lanes.map((lane) => [lane.deployment, lane]));
    expect(byLane['og-mainnet'].files).to.deep.equal([
      {
        path: `${LANE_DIR}/og-mainnet/trading.toml`,
        blob: '3d25e144fee422d7dc7892d98c369c2f6c9f0cd1',
        sha256: 'd1b4a190021bf0b746dbdb3101213101d950cfc8cf96755f0608d89db2872ccf',
      },
      {
        path: `${LANE_DIR}/og-mainnet/lane-binding.json`,
        blob: '0972b7b56114d9347e54fd8f13f86f77eb9ebf09',
        sha256: 'e2e385b02d90af3bfa348871c76f67f1688ce4bfeca641a62478a409063b8545',
      },
    ]);
    expect(byLane['og-mainnet-usdz'].files).to.deep.equal([
      {
        path: `${LANE_DIR}/og-mainnet-usdz/trading.toml`,
        blob: 'e3b5188881d7f00f13f1ba40fec0c65a086c999b',
        sha256: 'b7482a19440e5a452aa107bf16bd5fe61fa1dcc2aeb83cccc56b910ee2d1209e',
      },
      {
        path: `${LANE_DIR}/og-mainnet-usdz/lane-binding.json`,
        blob: 'eb9d3d78bdf6efc5d88ac2e314e90e342caf513b',
        sha256: 'e48697f21eb8b8606f487fa666d12aff9f5be91babfeba3f471d091bc553f30a',
      },
    ]);
    expect(byLane['og-mainnet'].runtimeConfigPath).to.equal(`${LANE_DIR}/og-mainnet/trading.toml`);
    expect(byLane['og-mainnet-usdz'].runtimeConfigPath).to.equal(`${LANE_DIR}/og-mainnet-usdz/trading.toml`);
    expect(byLane['og-mainnet'].laneBindingPath).to.equal(`${LANE_DIR}/og-mainnet/lane-binding.json`);
    expect(byLane['og-mainnet-usdz'].laneBindingPath).to.equal(`${LANE_DIR}/og-mainnet-usdz/lane-binding.json`);
    expect(byLane['og-mainnet'].environment).to.deep.equal({
      bondPerpsEnv: 'prod',
      quoteDomain: 'USDCE',
      separateQuoteBooksEnabled: false,
      database: {
        name: 'bond_perpdex_prod_og_mainnet_trading',
        iamUser: 'bond-perpdex-prod-og-trd%40g-bond.iam',
        url: 'postgresql://bond-perpdex-prod-og-trd%40g-bond.iam@127.0.0.1:5432/bond_perpdex_prod_og_mainnet_trading?sslmode=disable',
      },
    });
    expect(byLane['og-mainnet-usdz'].environment).to.deep.equal({
      bondPerpsEnv: 'prod',
      quoteDomain: 'USDZ',
      separateQuoteBooksEnabled: true,
      database: {
        name: 'bond_perpdex_prod_og_mainnet_usdz_trading',
        iamUser: 'bond-perpdex-prod-og-usdz-trd%40g-bond.iam',
        url: 'postgresql://bond-perpdex-prod-og-usdz-trd%40g-bond.iam@127.0.0.1:5432/bond_perpdex_prod_og_mainnet_usdz_trading?sslmode=disable',
      },
    });
  });

  it('binds both lanes to the protected-main Trading image built from f1604545', () => {
    for (const lane of OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE.lanes) {
      expect(lane.tradingArtifact).to.deep.equal({
        repository: 'us-central1-docker.pkg.dev/g-bond/bond-perpdex-services/trading',
        digest: 'sha256:914762fd8d5868dbea330716bdc2a398812c5a18e8a820beddd0b00508c09bd4',
        sourceCommit: 'f16045451a96ad3ac77299903fdde200b2ac0044',
        sourceTree: 'bc5fdc649e3e31c3f280d3b0b53d1f318dc346d9',
        publicationRunId: '42942405427',
      });
      expect(lane.tradingArtifact.repository).to.equal(SEQUENCER_TRADING_IMAGE_REPOSITORY);
    }
    // The tracked profiles pass the static gate with no fixture overrides.
    for (const profile of [mainnet, usdz]) {
      expect(gate(profile)).not.to.throw();
    }
  });

  it('still fails closed by name when any lane field is reset to unresolved', () => {
    const blank = {
      repository: SEQUENCER_TRADING_IMAGE_REPOSITORY,
      digest: null,
      sourceCommit: null,
      sourceTree: null,
      publicationRunId: null,
    };
    const lanes = RESOLVED_LANES.map((lane) => ({
      ...lane,
      environment: { ...lane.environment, database: null },
      tradingArtifact: blank,
    }));
    for (const profile of [mainnet, usdz]) {
      let message = '';
      try {
        assertSequencerLeverageEvidence(withSequencerEvidence(profile, { lanes }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.contain(`${profile.name} sequencer lane evidence is unresolved`);
      for (const deployment of ['og-mainnet', 'og-mainnet-usdz']) {
        expect(message).to.contain(`${deployment} DATABASE_URL identity`);
        expect(message).to.contain(`${deployment} Trading image digest (>= d7b15fd7)`);
      }
    }
  });

  it('passes both profiles once every lane binds config, environment, database and image', () => {
    for (const profile of [mainnet, usdz]) {
      expect(gate(withSequencerEvidence(profile))).not.to.throw();
    }
  });

  it('reports a single unresolved field by lane', () => {
    expect(
      gate(
        withLane(mainnet, 'og-mainnet-usdz', (lane) => ({
          ...lane,
          environment: { ...lane.environment, database: null },
        }))
      )
    ).to.throw('sequencer lane evidence is unresolved: og-mainnet-usdz DATABASE_URL identity');
    const unpinned = {
      ...RESOLVED_LANES[0].tradingArtifact,
      digest: null,
      sourceCommit: null,
      sourceTree: null,
      publicationRunId: null,
    };
    expect(gate(withLane(usdz, 'og-mainnet', (lane) => ({ ...lane, tradingArtifact: unpinned })))).to.throw(
      'sequencer lane evidence is unresolved: og-mainnet Trading image digest (>= d7b15fd7)'
    );
  });

  it('binds each lane to its own runtime config file', () => {
    const [usdcLane, usdzLane] = RESOLVED_LANES;
    // Swapped config files: byte-identical but for a comment, so path and blob must bind the lane.
    expect(
      gate(
        withSequencerEvidence(mainnet, {
          lanes: [{ ...usdcLane, files: usdzLane.files, runtimeConfigPath: usdzLane.runtimeConfigPath }, usdzLane],
        })
      )
    ).to.throw(
      'og-mainnet runtime config deploy/candidates/production/fresh-mainnet-launch/og-mainnet-usdz/trading.toml is not under a og-mainnet lane directory'
    );
    // Both lanes mounting the same bytes.
    const sameBytes = { ...usdzLane, files: [{ ...usdzLane.files[0], blob: usdcLane.files[0].blob }] };
    expect(gate(withSequencerEvidence(mainnet, { lanes: [usdcLane, sameBytes] }))).to.throw(
      'runtime config is shared with lane og-mainnet'
    );
    expect(
      gate(
        withLane(mainnet, 'og-mainnet', (lane) => ({ ...lane, runtimeConfigPath: `${LANE_DIR}/og-mainnet/other.toml` }))
      )
    ).to.throw('og-mainnet runtime config is not one of its reviewed files');
    expect(
      gate(withLane(mainnet, 'og-mainnet', (lane) => ({ ...lane, runtimeConfigPath: '../og-mainnet/trading.toml' })))
    ).to.throw('runtime config is not one of its reviewed files');
  });

  it('binds each lane to its own lane-binding.json beside its runtime config', () => {
    const [usdcLane, usdzLane] = RESOLVED_LANES;
    const binding = (deployment: string, patch: Partial<SequencerLaneEvidence>) =>
      withLane(mainnet, deployment, (lane) => ({ ...lane, ...patch }));
    expect(gate(binding('og-mainnet', { laneBindingPath: undefined as unknown as string }))).to.throw(
      'og-mainnet lane binding is not one of its reviewed files'
    );
    expect(gate(binding('og-mainnet', { laneBindingPath: usdcLane.runtimeConfigPath }))).to.throw(
      'lane binding is not one of its reviewed files'
    );
    expect(gate(binding('og-mainnet', { files: [usdcLane.files[0]] }))).to.throw(
      'og-mainnet lane binding is not one of its reviewed files'
    );
    // The other lane's binding, listed as this lane's file.
    expect(
      gate(
        binding('og-mainnet', {
          files: [usdcLane.files[0], usdzLane.files[1]],
          laneBindingPath: usdzLane.laneBindingPath,
        })
      )
    ).to.throw('og-mainnet lane binding');
    // A binding file outside the lane directory.
    const stray = { ...usdcLane.files[1], path: `${LANE_DIR}/og-mainnet/sub/lane-binding.json` };
    expect(gate(binding('og-mainnet', { files: [usdcLane.files[0], stray], laneBindingPath: stray.path }))).to.throw(
      'is not beside its runtime config'
    );
    // Both lanes carrying the same binding bytes.
    const sameBytes = { ...usdzLane.files[1], blob: usdcLane.files[1].blob };
    expect(gate(binding('og-mainnet-usdz', { files: [usdzLane.files[0], sameBytes] }))).to.throw(
      'og-mainnet-usdz lane binding is shared with lane og-mainnet'
    );
  });

  it('binds BOND_PERPS_ENV=prod and the lane quote domain', () => {
    const env = (deployment: string, patch: Partial<SequencerLaneEvidence['environment']>) =>
      withLane(mainnet, deployment, (lane) => ({ ...lane, environment: { ...lane.environment, ...patch } }));
    for (const bondPerpsEnv of ['staging', 'preprod', 'Prod', '', undefined]) {
      expect(gate(env('og-mainnet', { bondPerpsEnv: bondPerpsEnv as string }))).to.throw('BOND_PERPS_ENV must be prod');
    }
    // Quote domains swapped between the two lanes.
    expect(gate(env('og-mainnet', { quoteDomain: 'USDZ', separateQuoteBooksEnabled: true }))).to.throw(
      'og-mainnet quote domain "USDZ" does not match its collateral USDCE'
    );
    expect(gate(env('og-mainnet-usdz', { quoteDomain: 'USDCE', separateQuoteBooksEnabled: false }))).to.throw(
      'og-mainnet-usdz quote domain "USDCE" does not match its collateral USDZ'
    );
    expect(gate(env('og-mainnet-usdz', { quoteDomain: 'usdz' }))).to.throw('does not match its collateral USDZ');
    expect(gate(env('og-mainnet-usdz', { separateQuoteBooksEnabled: false }))).to.throw(
      'PERPDEX_SEPARATE_QUOTE_BOOKS_ENABLED must be true exactly for a non-USDCE quote domain'
    );
    expect(gate(env('og-mainnet', { separateQuoteBooksEnabled: true }))).to.throw(
      'PERPDEX_SEPARATE_QUOTE_BOOKS_ENABLED must be true exactly'
    );
    expect(gate(withLane(mainnet, 'og-mainnet', (lane) => ({ ...lane, environment: null })))).to.throw(
      'workload environment is missing'
    );
  });

  it('binds each lane to its own fresh database by a passwordless IAM DATABASE_URL', () => {
    const [usdcLane, usdzLane] = RESOLVED_LANES;
    const db = (deployment: string, database: unknown) =>
      withLane(mainnet, deployment, (lane) => ({ ...lane, environment: { ...lane.environment, database } }));
    const usdcDb = usdcLane.environment.database;
    const own = usdzLane.environment.database;
    if (usdcDb === null || own === null) throw new Error('resolved fixture lanes carry databases');
    // Both lanes on one database (and one IAM user).
    expect(gate(db('og-mainnet-usdz', usdcDb))).to.throw(
      'og-mainnet-usdz database bond_perpdex_prod_og_mainnet_trading is shared with lane og-mainnet'
    );
    const otherUser = 'bond-perpdex-prod-trd-other%40g-bond.iam';
    const sameUser = {
      ...own,
      iamUser: usdcDb.iamUser,
      url: `postgresql://${usdcDb.iamUser}@127.0.0.1:5432/${own.name}?sslmode=disable`,
    };
    expect(gate(db('og-mainnet-usdz', sameUser))).to.throw('database IAM user is shared with lane og-mainnet');
    // The live private-beta lineage database is never a fresh lane.
    for (const name of SEQUENCER_RESERVED_TRADING_DATABASES) {
      expect(
        gate(
          db('og-mainnet', {
            name,
            iamUser: otherUser,
            url: `postgresql://${otherUser}@127.0.0.1:5432/${name}?sslmode=disable`,
          })
        )
      ).to.throw(`database ${name} belongs to the live private-beta lineage`);
    }
    for (const bad of [
      { ...own, url: own.url.replace('%40g-bond.iam@', '%40g-bond.iam:secret@') },
      { ...own, url: own.url.replace('127.0.0.1', '10.0.0.5') },
      { ...own, url: own.url.replace(own.name, 'bond_perpdex_prod_other') },
      { ...own, iamUser: otherUser },
      { ...own, url: `${own.url}&x=1` },
      { ...own, name: 'Bad-Name' },
      { ...own, url: undefined },
    ]) {
      expect(gate(db('og-mainnet-usdz', bad))).to.throw('DATABASE_URL is not a passwordless Cloud SQL IAM URL');
    }
  });

  it('binds an immutable Trading image: full digest, source commit/tree and publication run together', () => {
    const artifact = (patch: Record<string, unknown>) =>
      withLane(mainnet, 'og-mainnet-usdz', (lane) => ({
        ...lane,
        tradingArtifact: { ...lane.tradingArtifact, ...patch },
      }));
    expect(gate(artifact({ repository: 'us-central1-docker.pkg.dev/g-bond/other/trading' }))).to.throw(
      'Trading image repository must be'
    );
    for (const digest of ['latest', 'sha256:' + 'A'.repeat(64), 'sha256:' + 'a'.repeat(63), 'a'.repeat(64)]) {
      expect(gate(artifact({ digest }))).to.throw('Trading image digest must be sha256:<64 lowercase hex>');
    }
    // A digest alone, without the source and run it came from, is not evidence.
    for (const missing of ['sourceCommit', 'sourceTree', 'publicationRunId']) {
      expect(gate(artifact({ [missing]: null }))).to.throw('Trading artifact is partially resolved');
    }
    expect(gate(artifact({ sourceCommit: 'main' }))).to.throw('Trading image source commit must be a 40-character');
    expect(gate(artifact({ sourceTree: 'x'.repeat(40) }))).to.throw('Trading image source tree must be a 40-character');
    expect(gate(artifact({ publicationRunId: '0' }))).to.throw('publication run must be an Actions run id');
    expect(gate(withLane(mainnet, 'og-mainnet', (lane) => ({ ...lane, tradingArtifact: null })))).to.throw(
      'Trading artifact is missing'
    );
  });
});

describe('sequencer lane evidence verifier (synthetic bond-perpdex checkout)', () => {
  const quoteDomains = (usdzEnvs: string) => `# quote domains
[[quote_domain]]
quote_domain_id = "USDCE"
environments = ["local", "development", "staging", "preprod", "prod"]

[[quote_domain]]
quote_domain_id = "USDZ"
environments = [${usdzEnvs}]   # comment
`;
  const quoteDomainRs = (envs: string) =>
    `pub const LOCAL_ENVIRONMENT: &str = "local";\npub const SEPARATE_BOOKS_ENVIRONMENTS: [&str; 3] = [${envs}];\n`;
  let checkout: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', checkout, ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
    })
      .toString()
      .trim();
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.writeFileSync(path.join(checkout, file), text);
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const laneBindingJson = (lane: SequencerLaneEvidence, patch: Record<string, unknown> = {}) =>
    JSON.stringify(
      {
        schema: LANE_BINDING_SCHEMA,
        status: 'inactive',
        deployment: lane.deployment,
        environment: lane.environment,
        workloadEnv: {
          BOND_PERPS_ENV: lane.environment.bondPerpsEnv,
          PERPDEX_QUOTE_DOMAIN: lane.environment.quoteDomain,
          PERPDEX_SEPARATE_QUOTE_BOOKS_ENABLED: String(lane.environment.separateQuoteBooksEnabled),
          DATABASE_URL: lane.environment.database?.url,
        },
        runtimeConfig: lane.runtimeConfigPath,
        tradingImage: null,
        ...patch,
      },
      null,
      2
    ) + '\n';
  let floor: string;
  let config: string;
  let prodAdmits: string;
  let offFloor: string;

  before(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-perpdex-lanes-'));
    git('init', '-q');
    write('core/types/quote-domains.toml', quoteDomains('"local", "development", "staging"'));
    write('core/types/src/quote_domain.rs', quoteDomainRs('LOCAL_ENVIRONMENT, "development", "staging"'));
    floor = commit('floor');
    write(`${LANE_DIR}/og-mainnet/trading.toml`, '# og-mainnet (USDC.e)\nmax_leverage = 1\n');
    write(`${LANE_DIR}/og-mainnet-usdz/trading.toml`, '# og-mainnet-usdz (USDZ)\nmax_leverage = 1\n');
    for (const lane of RESOLVED_LANES) write(lane.laneBindingPath, laneBindingJson(lane));
    config = commit('lanes');
    write('core/types/quote-domains.toml', quoteDomains('"local", "development", "staging", "prod"'));
    write('core/types/src/quote_domain.rs', quoteDomainRs('LOCAL_ENVIRONMENT, "development", "staging", "prod"'));
    prodAdmits = commit('admit USDZ in prod');
    const branch = git('symbolic-ref', '--short', 'HEAD');
    git('checkout', '-q', '--orphan', 'unrelated');
    offFloor = commit('unrelated root');
    git('checkout', '-q', '-f', branch);
  });
  after(() => fs.rmSync(checkout, { recursive: true, force: true }));

  const fileEvidence = (file: string) => {
    const bytes = execFileSync('git', ['-C', checkout, 'show', `${config}:${file}`]);
    return {
      path: file,
      blob: git('rev-parse', `${config}:${file}`),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  };
  const profileFor = (
    sourceCommit: string | null,
    tamper: (lane: SequencerLaneEvidence) => SequencerLaneEvidence = (l) => l
  ) =>
    withSequencerEvidence(mainnet, {
      commit: config,
      tree: git('rev-parse', `${config}^{tree}`),
      lanes: RESOLVED_LANES.map((lane) =>
        tamper({
          ...lane,
          files: [fileEvidence(lane.runtimeConfigPath), fileEvidence(lane.laneBindingPath)],
          tradingArtifact: {
            ...lane.tradingArtifact,
            sourceCommit,
            sourceTree: sourceCommit === null ? null : git('rev-parse', `${sourceCommit}^{tree}`),
          },
        })
      ),
    });
  const failed = (profile: PerpdexNetworkProfile, source = floor) =>
    verifySequencerLaneEvidence(profile, checkout, source)
      .filter((finding) => !finding.ok)
      .map((finding) => `${finding.deployment} ${finding.check}: ${finding.detail}`);

  it('verifies bytes, floor ancestry and prod quote-domain admission for both lanes', () => {
    expect(failed(profileFor(prodAdmits))).to.deep.equal([]);
  });

  it('refuses USDZ under prod when the Trading source does not admit it (90c79ef4 shape)', () => {
    expect(failed(profileFor(config))).to.deep.equal([
      `og-mainnet-usdz quote domain USDZ under BOND_PERPS_ENV=prod at ${config.slice(
        0,
        8
      )}: core/types/quote-domains.toml lists USDZ for [local, development, staging], not prod`,
    ]);
    // Registry alone is not enough: the Rust separate-books allowlist must admit prod too.
    write('core/types/quote-domains.toml', quoteDomains('"local", "development", "staging", "prod"'));
    write('core/types/src/quote_domain.rs', quoteDomainRs('LOCAL_ENVIRONMENT, "development", "staging"'));
    const registryOnly = commit('registry only');
    expect(failed(profileFor(registryOnly))).to.deep.equal([
      `og-mainnet-usdz quote domain USDZ under BOND_PERPS_ENV=prod at ${registryOnly.slice(
        0,
        8
      )}: core/types/src/quote_domain.rs SEPARATE_BOOKS_ENVIRONMENTS is [local, development, staging], not prod`,
    ]);
  });

  it('refuses an unresolved image, a source before the floor, and tampered bytes', () => {
    const unresolved = failed(profileFor(null));
    expect(unresolved).to.include('og-mainnet Trading artifact: digest unresolved (no image at or after floor)');
    expect(unresolved).to.include('og-mainnet-usdz Trading artifact: digest unresolved (no image at or after floor)');
    expect(failed(profileFor(offFloor))).to.include.members([
      `og-mainnet Trading source at or after floor: ${offFloor}`,
      `og-mainnet-usdz Trading source at or after floor: ${offFloor}`,
    ]);
    // Floor after the config commit: the lane files predate the engine floor.
    expect(failed(profileFor(prodAdmits), prodAdmits)).to.include(
      `* config commit at or after floor: ${prodAdmits} ancestor of ${config}`
    );
    const tampered = failed(
      profileFor(prodAdmits, (lane) =>
        lane.deployment === 'og-mainnet' ? { ...lane, files: [{ ...lane.files[0], sha256: '0'.repeat(64) }] } : lane
      )
    );
    expect(tampered).to.have.length(1);
    expect(tampered[0]).to.match(/^og-mainnet file .*og-mainnet\/trading\.toml/);
    const wrongTree = withSequencerEvidence(profileFor(prodAdmits), {
      ...(profileFor(prodAdmits).sequencerLeverageEvidence.evidence as SequencerEvidence),
      tree: '0'.repeat(40),
    });
    expect(failed(wrongTree)[0]).to.match(/^\* config commit tree/);
  });

  it('replays each lane-binding.json against the lane deployment, env, database and runtime config', () => {
    const [usdcLane, usdzLane] = RESOLVED_LANES;
    expect(laneBindingRefusals(laneBindingJson(usdcLane), usdcLane)).to.deep.equal([]);
    expect(laneBindingRefusals(laneBindingJson(usdzLane), usdzLane)).to.deep.equal([]);
    // Swapped bindings: each names the other lane.
    expect(laneBindingRefusals(laneBindingJson(usdzLane), usdcLane).join('; ')).to.match(
      /^deployment "og-mainnet-usdz" != "og-mainnet"; runtimeConfig .*; environment .*; workloadEnv /
    );
    const wrongDb = { ...usdcLane.environment, database: usdzLane.environment.database };
    expect(laneBindingRefusals(laneBindingJson(usdcLane, { environment: wrongDb }), usdcLane)[0]).to.match(
      /^environment .*bond_perpdex_prod_og_mainnet_usdz_trading/
    );
    const env = { BOND_PERPS_ENV: 'staging' };
    expect(laneBindingRefusals(laneBindingJson(usdcLane, { workloadEnv: env }), usdcLane)[0]).to.match(/^workloadEnv /);
    expect(laneBindingRefusals(laneBindingJson(usdcLane, { schema: 'v1' }), usdcLane)[0]).to.match(/^schema /);
    expect(
      laneBindingRefusals(laneBindingJson(usdcLane, { tradingImage: { digest: 'sha256:' + 'b'.repeat(64) } }), usdcLane)
    ).to.deep.equal([
      `tradingImage {"digest":"sha256:${'b'.repeat(64)}"} does not name ${usdcLane.tradingArtifact.digest}`,
    ]);
    const named = { digest: usdcLane.tradingArtifact.digest };
    expect(laneBindingRefusals(laneBindingJson(usdcLane, { tradingImage: named }), usdcLane)).to.deep.equal([]);
    expect(laneBindingRefusals('not json', usdcLane)).to.deep.equal(['lane binding is not JSON']);
  });

  it('refuses a lane whose committed binding names another lane or is missing', () => {
    const [usdcLane, usdzLane] = RESOLVED_LANES;
    write(usdcLane.laneBindingPath, laneBindingJson(usdzLane));
    const swapped = commit('swap og-mainnet binding');
    // File evidence pins the bytes at `filesAt`; the verifier reads the binding at `at`.
    const pinned = (at: string, filesAt = at) =>
      withSequencerEvidence(mainnet, {
        commit: at,
        tree: git('rev-parse', `${at}^{tree}`),
        lanes: RESOLVED_LANES.map((lane) => ({
          ...lane,
          files: [lane.runtimeConfigPath, lane.laneBindingPath].map((file) => {
            const bytes = execFileSync('git', ['-C', checkout, 'show', `${filesAt}:${file}`]);
            return {
              path: file,
              blob: git('rev-parse', `${filesAt}:${file}`),
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            };
          }),
          tradingArtifact: { ...lane.tradingArtifact, sourceCommit: at, sourceTree: git('rev-parse', `${at}^{tree}`) },
        })),
      });
    // HEAD carries the earlier registry-only commit, so filter to binding findings.
    const bad = failed(pinned(swapped)).filter((finding) => finding.includes(' lane binding '));
    expect(bad).to.have.length(1);
    expect(bad[0]).to.match(/^og-mainnet lane binding .*: deployment "og-mainnet-usdz" != "og-mainnet"/);
    git('rm', '-q', usdcLane.laneBindingPath);
    const missing = commit('drop og-mainnet binding');
    expect(failed(pinned(missing, swapped))).to.include.members([
      `og-mainnet lane binding ${usdcLane.laneBindingPath}: missing at config commit`,
    ]);
  });

  it('parses the quote-domain registry and allowlist fail-closed', () => {
    expect(parseQuoteDomainEnvironments(quoteDomains('"staging"')).get('USDZ')).to.deep.equal(['staging']);
    expect(() => parseQuoteDomainEnvironments('[[quote_domain]]\nquote_domain_id = "USDZ"\n')).to.throw('unreadable');
    expect(() => parseQuoteDomainEnvironments('')).to.throw('no quote domains');
    expect(parseSeparateBooksEnvironments(quoteDomainRs('LOCAL_ENVIRONMENT, "prod"'))).to.deep.equal(['local', 'prod']);
    expect(() => parseSeparateBooksEnvironments(quoteDomainRs('OTHER_CONST'))).to.throw('unreadable');
    expect(() => parseSeparateBooksEnvironments('')).to.throw('not found');
  });
});
