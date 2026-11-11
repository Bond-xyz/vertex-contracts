import {
  OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE,
  PerpdexNetworkProfile,
  SequencerLaneEvidence,
} from '../../scripts/deployment-config';

export type SequencerEvidence = NonNullable<PerpdexNetworkProfile['sequencerLeverageEvidence']['evidence']>;

// The tracked evidence is fully resolved (bond-perpdex f1604545, Trading image from
// publication run 42942405427); negative tests mutate copies of it.
export const RESOLVED_LANES: readonly SequencerLaneEvidence[] = OG_MAINNET_SEQUENCER_LEVERAGE_EVIDENCE.lanes;

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
