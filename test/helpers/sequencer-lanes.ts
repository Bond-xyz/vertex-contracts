import {
  OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE,
  PerpdexNetworkProfile,
  SEQUENCER_TRADING_IMAGE_REPOSITORY,
  SequencerLaneEvidence,
} from '../../scripts/deployment-config';

export type SequencerEvidence = NonNullable<PerpdexNetworkProfile['sequencerLeverageEvidence']['evidence']>;

// Synthetic, fully resolved lane bindings (test-only placeholder digests and
// databases; never used by a profile). Starts from the tracked evidence so the
// config files, quote domains and BOND_PERPS_ENV are the real ones.
export function resolvedLane(lane: SequencerLaneEvidence, index: number): SequencerLaneEvidence {
  const suffix = lane.deployment === 'og-mainnet' ? 'usdce' : 'usdz';
  const iamUser = `bond-perpdex-prod-trd-${suffix}%40g-bond.iam`;
  const name = `bond_perpdex_prod_fresh_${suffix}_trading`;
  return {
    ...lane,
    environment: {
      ...lane.environment,
      database: { name, iamUser, url: `postgresql://${iamUser}@127.0.0.1:5432/${name}?sslmode=disable` },
    },
    tradingArtifact: {
      repository: SEQUENCER_TRADING_IMAGE_REPOSITORY,
      digest: `sha256:${String(index + 1).repeat(64)}`,
      sourceCommit: 'e'.repeat(40),
      sourceTree: 'f'.repeat(40),
      publicationRunId: '42999999999',
    },
  };
}

export const RESOLVED_LANES: readonly SequencerLaneEvidence[] =
  OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE.lanes.map(resolvedLane);

export function withSequencerEvidence(
  profile: PerpdexNetworkProfile,
  overrides: Partial<SequencerEvidence> = {}
): PerpdexNetworkProfile {
  return {
    ...profile,
    sequencerLeverageEvidence: {
      required: true,
      evidence: { ...OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE, lanes: RESOLVED_LANES, ...overrides } as SequencerEvidence,
    },
  };
}

export function withLane(
  profile: PerpdexNetworkProfile,
  deployment: string,
  edit: (lane: SequencerLaneEvidence) => unknown
): PerpdexNetworkProfile {
  return withSequencerEvidence(profile, {
    lanes: RESOLVED_LANES.map((lane) =>
      lane.deployment === deployment ? (edit(lane) as SequencerLaneEvidence) : lane
    ),
  });
}
