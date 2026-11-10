# 0G Mainnet Deployment Configuration

This branch adds 0G mainnet (chain `16661`) configuration to the audited Galileo release pipeline (`bond/galileo-refork`). Nothing in it deploys anything. Every mainnet release gate stays closed until a human fills in the operator-fill inputs and approves the policies listed below.

## Profile selection

`scripts/deployment-config.ts` defines `PERPDEX_NETWORK_PROFILES`. A process picks exactly one profile from the shell environment:

| `PERPDEX_NETWORK` | Chain | Quote token (product 0) | Markets (ids 2,4,6,8) | State dir |
| --- | --- | --- | --- | --- |
| `galileo` (default) | 16602 | USDC.e `0xF2506aa3684871549083d235453a1dcDcCB3396c` | `BTCUSDCPERP` … `0GUSDCPERP` | `deployments/16602/` |
| `og-mainnet` | 16661 | USDC.e `0x1f3aa82227281ca364bfb3d253b0f1af1da6473e` | `BTCUSDCPERP` … `0GUSDCPERP` | `deployments/16661/og-mainnet/` |
| `og-mainnet-usdz` | 16661 | USDZ `0xd4d54bd7379e799417563b1bb42426c9bd4ccb2a` | `BTCUSDZPERP` … `0GUSDZPERP` | `deployments/16661/og-mainnet-usdz/` |

The chain, collateral, release-id, tracked-file and state-path gates all read the selected profile (`PERPDEX_CHAIN_ID`, `PERPDEX_COLLATERAL_*`, `PERPDEX_NETWORK.files`). Both mainnet profiles use chain 16661, so the chain check cannot tell them apart. The collateral address/symbol, the market symbols in the products file, and the per-deployment release/provenance/review files do. Hardhat loads `.env.<profile>.local` and refuses to start if that file tries to change `PERPDEX_NETWORK`.

## Dual collateral = two deployments

Vertex `Endpoint` has exactly one quote token (product 0). USDC.e and USDZ collateral are therefore two independent graphs on chain 16661, each with its own Endpoint, Clearinghouse, engines, Verifier, ProxyAdmin and virtual books. Shared between them: the audited contract baseline (`config/og-mainnet.contract-baseline.json`, byte-identical to Galileo's) and the fee policy (`config/og-mainnet.fee-policy.json`). Each deployment has its own products, product-approval review, collateral provenance, release policy, Stork policy and **verifier quorum**.

### Why the verifier quorums must differ

`Endpoint.submitTransactionsChecked` verifies the quorum signature over `digest = keccak256(abi.encode(idx))`, then folds in each transaction: `digest = keccak256(abi.encodePacked(digest, tx_i))`. The digest has no `chainId` and no `address(this)`. If both Endpoints trusted the same three keys, a batch signed for one deployment would also verify on the other whenever their `nSubmissions` matched. Separate quorums remove that cross-Endpoint replay.

`loadVerifierConfig` enforces this invariant via `assertDistinctVerifierQuorum`, using each profile's `distinctVerifierQuorumFrom` list. It refuses a mainnet verifier config if it shares any key with the sibling deployment's config, or if the sibling config is missing. `test/network-profile.test.ts` covers the tracked configs and the shared-key regressions.

## Operators

| Role | Value | Where it is bound |
| --- | --- | --- |
| Deployer | `0x07b735E020549ba56AAb8e3370d102C2Df6cabF7`, a local hot key like on testnet (no custody signer) | Profile pin `operators.deployer`, enforced by the deployment intent, the address plan, and `deploy-galileo.ts` (signer address check before any RPC). The key is read from `PERPDEX_OG_MAINNET_DEPLOYER_PRIVATE_KEY`; it lives in GCP Secret Manager `g-bond` as `perpdex-mainnet-deployer-private-key`. |
| Sequencer | `0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59` (Fordefi production vault) | Profile pin. `resolveSequencer` and the deployment intent refuse any other value. |
| Contract admin / owner | `0x7a3A932F1cc402941f3238292c80d138dA49Be25` (Fordefi Vault 1.3) | Profile pin, recorded as `ownershipHandoff` in the address plan. The handoff is not executed by this pipeline. |
| Release reviewer | Adam (sole reviewer; `external_reviewer_signature`, 1 signature, no multisig), delegated to the deployer wallet `0x07b735E020549ba56AAb8e3370d102C2Df6cabF7` | Profile pin `releaseReviewer` (`mayBeDeployer: true`) plus `reviewers` in both release policies. The reviewer-independence check is relaxed for the deployer role on mainnet profiles only. The reviewer still has to differ from the sequencer, and Galileo keeps the full check. |
| Verifier quorum (USDC.e) | 3 secp256k1 keys, bitmask 7 | Public points in `config/og-mainnet.verifier-public-keys.json`. The private halves are only in GCP Secret Manager `g-bond`: `perpdex-mainnet-verifier-key-0/1/2`. |
| Verifier quorum (USDZ) | 3 distinct secp256k1 keys, bitmask 7 | Public points in `config/og-mainnet-usdz.verifier-public-keys.json`. The private halves are only in GCP Secret Manager `g-bond`: `perpdex-mainnet-usdz-verifier-key-0/1/2`. |

## Approval and signing path

`deploy-galileo.ts` and `verify-galileo-deployment.ts` verify release approval through `collectAndVerifyReleaseApproval` (`scripts/release-approval.ts`):

- `galileo`: the tracked Red testnet approval (unchanged).
- `og-mainnet*`: a signed EIP-712 `ReleaseAttestation` from the allowlisted reviewer, read from `PERPDEX_RELEASE_ATTESTATION_FILE`, default `config/<profile>.release-attestation.local.json` (untracked). The signature binds:
  - the exact clean release commit and tree
  - the build evidence and products
  - the Stork policy and collateral provenance
  - the verifier quorum
  - the single-use deployment intent

  The product review must also be approved. Evidence is re-verified before the first preparation transaction, after preparation, and before writing the manifest. `yarn evidence:galileo` (with `PERPDEX_NETWORK` set) prints the unsigned request for the reviewer to sign.

## Fail-closed gates still open on this branch

- Release policies have status `pending_og_mainnet_review`, and no signed attestation exists. The external attestation path refuses until both change.

Deploy-time approval flow:
1. Adam gives verbal approval of the exact candidate.
2. `yarn evidence:galileo` (with `PERPDEX_NETWORK` set) prints the unsigned EIP-712 request.
3. The request is signed with the deployer key and saved to `config/<profile>.release-attestation.local.json`.
4. The gate lifts. Steps 3 and 4 happen only after the release policy status is set to `approved_for_og_mainnet_release` in a reviewed commit.
- The Stork policies are `blocked_pending_reviewed_cross_feed_timestamp_spread`, with no runtime backend release bound.
- Products and product reviews are `approved: false` / `pending_red_approval`. The reviews pin the merged contract packet `15287abc32072de7cbe820119682dce73e044eb1` (tree `a9cbb18229e9ce65c23cd413339036fc2b44971c`).
- Collateral provenance: USDZ `sources.bondSuperApp` is still `null`, because the super-app generated registry has no USDZ entry yet. `loadTrackedCollateralProvenance` refuses while any null remains.

### Carried-field tuple hash (`canonical_json_v1`)

For mainnet, `normalizedCarriedFieldTupleSha256` is computed by `carriedFieldTupleSha256` (`scripts/deployment-config.ts`). The input is a tuple of exactly these fields from the provenance file:
- `provenanceId`
- `chainId`
- `collateral`: `address` (EIP-55 checksum), `symbol`, `decimals`, `productId`
- `selection`

The tuple is serialized as canonical JSON (keys sorted recursively, no whitespace, UTF-8), and the hash is the hex SHA-256 of that string. Each collateral profile gets its own value: og-mainnet `af864f08…1371`, og-mainnet-usdz `d111b00f…5855`. `loadTrackedCollateralProvenance` recomputes the hash from the file and requires it to equal the profile pin. Galileo keeps its reviewed legacy literal (`legacy_literal`); this derivation does not reproduce that value.
- The deployer balance must be funded before the first transaction.
- `bind-galileo-backend-runtime.ts` and `generate-testnet-verifier-keys.ts` are Galileo-only.

The fee policy (`config/og-mainnet.fee-policy.json`) is approved with bounds min 2000000007, default 4000000007, max 20000000000 wei, around the observed `eth_gasPrice` 4000000007 at block 49846964. At deploy time you still have to set `PERPDEX_OG_MAINNET_GAS_PRICE_WEI` explicitly, and it is checked against the live RPC fee quote.

`yarn review:og-mainnet:products` (in CI) checks that both mainnet review packets are structurally valid and lists the pending inputs.

## Operator-fill inputs

| Input | File / pin |
| --- | --- |
| Release policy activation + deployer-key-signed attestation after Adam's approval (deploy time) | `config/og-mainnet*.release-policy.json` `status`, `config/<profile>.release-attestation.local.json` |
| Super-app registry source for USDZ (regenerate the super-app registry first; it predates USDZ) | `config/og-mainnet-usdz.collateral-provenance.json` `sources.bondSuperApp` |
| Stork cross-feed spread decision and runtime backend release | `config/og-mainnet*.stork-deployment-policy.json` |
| Red approval of products and product vectors | `config/og-mainnet*.products.json`, `*.product-approval-review.json` |

After any tracked config file changes, recompute the SHA-256 fields that bind it (the product review's `provenanceSha256` and `policySha256`).

## Stork aggregator rotation

Stork rotated its aggregator signer. Mainnet snapshots must be signed by the **current** key `0x0bb53E0d5E89778DCD13C2720667D292368dD053`. The previous key `0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44` is replay-only: `verifyStorkSignedFeed` refuses any new mainnet snapshot feed signed with it. Galileo stays on the previous key, so its historical evidence still verifies.

The provenance (`profile.storkAggregator.provenance`, copied verbatim into each mainnet Stork policy as `verifier.aggregatorKeyProvenance`) is Bond-xyz/bond-perpdex `966205f8` (tree `935edbc3`):
- `core/types/src/stork.rs`: `STORK_AGGREGATOR_PUBLIC_KEY` is the current key; `STORK_PREVIOUS_AGGREGATOR_PUBLIC_KEY` is the previous one.
- `docs/requirements/ORACLE_MANIPULATION_GUARD.md`: the current key was independently confirmed through Stork's documented EVM deployments (`storkPublicKey()`), and the previous key is kept for replay only.
- `deploy/base/price-oracle/resources.yaml`: the deployed price oracle pins the current key.

Blob and SHA-256 values are pinned per file. A policy whose key or provenance doesn't match the profile is refused.

## Launch risk: exactly 1x (Red = Adam)

Both mainnet deployments launch at a maximum of **1x leverage**. Perp initial health is `quote + vQuote + Σ amount·price·weight`, with the weights taken from `RiskHelper._getWeightX18`. Opening a long of notional N against collateral Q therefore leaves initial health `Q − N·(1 − longWeightInitial)`, and a short leaves `Q − N·(shortWeightInitial − 1)`. For exactly 1x:

| weight (×1e9) | og-mainnet / og-mainnet-usdz | Galileo |
| --- | --- | --- |
| longWeightInitial | 0 | 950_000_000 |
| shortWeightInitial | 2_000_000_001 | 1_050_000_000 |
| longWeightMaintenance | 500_000_000 | 975_000_000 |
| shortWeightMaintenance | 1_500_000_000 | 1_025_000_000 |

Longs are capped at exactly 1x. `shortWeightInitial` is 2.000000001, not 2.0, because `BaseEngine.getHealthContribution` treats weight `2 * ONE` as its spot-short sentinel and returns `int128.min`. Shorts are therefore capped at 1/1.000000001x. `loadProducts` always refuses `shortWeightInitial == 2e9`, and the ceiling is profile-scoped: Galileo keeps 2e9 and mainnet allows exactly 2_000_000_001. Maintenance keeps Galileo's half-of-initial ratio (50% maintenance margin). `profile.riskModel` pins these values, the product-review validator enforces them, `test/og-mainnet-1x-contract.test.ts` checks this against the real contract health math:
- the 2e9 sentinel regression;
- the exact 1x long boundary;
- a full 1x short is refused;
- a 1x short becomes liquidatable at +33.3%;
- with zero insurance, bad debt is socialized across open interest.

**Short-side epsilon:** the short bound is conservative, not an exact zero. A short with notional equal to its collateral has initial health `-1e-9 × notional`, so it is refused. A short needs collateral of at least `ceil(short notional × 1_000_000_001 / 1_000_000_000)`. Because `OffchainExchange` matching bypasses health, the sequencer's integer `max_leverage = 1` cap alone, which reserves exactly the notional, would let a full 1x short open already unhealthy. Deployment stays blocked until backend exact-order admission adds that short-side ppb buffer (or an equivalent). The gate requires `shortOpeningCollateralPpb ≥ shortWeightInitial − 1e9` in the sequencer evidence. Perp health values a short at the oracle mark, not the fill price, and matching debits fees from quote after the fill. A short of size s filled at price F with oracle mark M needs `Q ≥ shortWeightInitial·M·s − F·s`, which is the ppb reserve on mark notional plus `(M − F)·s`. So the evidence must also declare `shortAdmissionBasis: 'post_fill_initial_health_at_oracle_mark'` and `feesReservedSeparately: true`. A ppb reserve on fill (or mark) notional alone lets a short filled below mark open unhealthy. Longs (weight 0) need only the fill notional plus fees.

**Sequencer cap gate:** `OffchainExchange` matching does not enforce health, so the sequencer's `max_leverage` is what actually enforces 1x. `assertSequencerLeverageEvidence` (first step of `collectGalileoStaticReleasePolicy`) refuses mainnet until `profile.sequencerLeverageEvidence.evidence` is set. It must pin the reviewed production trading runtime config (repository, commit, tree, and per-file blob and SHA-256) with `maxLeverage = 1` for both lanes (`og-mainnet` and `og-mainnet-usdz`). A mainnet profile that sets `required: false` is refused; only the tracked Galileo testnet may skip the gate.

**Insurance fund:** the deployment config has no insurance setting. `Clearinghouse.insurance` starts at 0 and only changes through owner `depositInsurance`, which this pipeline never calls. Insurance is therefore zero at launch.

**Stork:** Red (Adam) approved a 3-second cross-feed signed-timestamp spread for both deployments. The runtime backend release binding is still pending.

## Running the two deployments

The OpenZeppelin network manifest path is fixed per chain (`.openzeppelin/unknown-16661.json`), and preparation requires it to be absent. Run each mainnet deployment from its own clean checkout, with its own `.env.<profile>.local`.
