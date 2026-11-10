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

Vertex `Endpoint` has exactly one quote token (product 0). USDC.e and USDZ collateral are therefore two independent graphs on chain 16661, each with its own Endpoint, Clearinghouse, engines, Verifier, ProxyAdmin and virtual books. Shared between them: the audited contract baseline (`config/og-mainnet.contract-baseline.json`, byte-identical to Galileo's), the fee policy (`config/og-mainnet.fee-policy.json`) and the verifier quorum (`config/og-mainnet.verifier-public-keys.json`). Each deployment has its own products, product-approval review, collateral provenance, release policy and Stork policy.

## Operators

| Role | Value | Where it is bound |
| --- | --- | --- |
| Sequencer | `0x2a83BE9CC98d70c20EAC0d8c35b1D035B2741C59` (Fordefi production vault) | Profile pin. `resolveSequencer` refuses any other `PERPDEX_SEQUENCER_ADDRESS`. |
| Contract admin / owner | `0x7a3A932F1cc402941f3238292c80d138dA49Be25` (Fordefi Vault 1.3) | Profile pin, recorded as `ownershipHandoff` in the address plan. |
| Deployer | Fordefi deployer wallet, **not yet created** | Supplied at deploy time as `PERPDEX_DEPLOYER_ADDRESS`, the same way Galileo does it. |
| Verifier quorum | 3 secp256k1 keys, bitmask 7 | Public points in `config/og-mainnet.verifier-public-keys.json`. The private halves are only in GCP Secret Manager `g-bond`: `perpdex-mainnet-verifier-key-0/1/2`. |

Fordefi vault UUID / chain id (`evm_16661`) are custody-side inputs and are not used by this repository.

## Fail-closed state on this branch

- `deploy-galileo.ts` refuses mainnet profiles before any RPC call: it signs only with a local EOA under the tracked Red testnet approval. A mainnet deployment needs a reviewed custody (Fordefi) signing path and the external-reviewer attestation path (`release-attestation.ts`).
- The release policies use `external_reviewer_signature` with an empty `reviewers` list and status `pending_og_mainnet_review`.
- The fee policy has status `pending_og_mainnet_review` with null gas bounds.
- The Stork policies are `blocked_pending_reviewed_cross_feed_timestamp_spread` with no runtime backend release bound.
- The product files and product reviews are `approved: false` / `pending_red_approval`.
- The collateral provenance carries `null` for every value that could not be sourced deterministically. `loadTrackedCollateralProvenance` refuses while any null remains.
- `bind-galileo-backend-runtime.ts` and `generate-testnet-verifier-keys.ts` are Galileo-only.

`yarn review:og-mainnet:products` (in CI) checks that both mainnet review packets are structurally valid and lists the pending inputs.

## Operator-fill inputs

| Input | File / pin |
| --- | --- |
| Fordefi deployer address | `PERPDEX_DEPLOYER_ADDRESS` at deploy time |
| 0G mainnet gas-price bounds | `config/og-mainnet.fee-policy.json` + `pins.feeBoundsWei` |
| External reviewer address(es) | `config/og-mainnet*.release-policy.json` `reviewers` |
| Contract packet base commit/tree (the merged commit of this config) | product reviews `contractSource` + `pins.contractPacketBase` |
| `normalizedCarriedFieldTupleSha256` (both deployments) | collateral provenance + `pins.normalizedCarriedFieldTupleSha256` |
| Super-app registry source for USDZ (regenerate the super-app registry first; it predates USDZ) | `config/og-mainnet-usdz.collateral-provenance.json` `sources.bondSuperApp` |
| Stork cross-feed spread decision and runtime backend release | `config/og-mainnet*.stork-deployment-policy.json` |
| Red approval of products and product vectors | `config/og-mainnet*.products.json`, `*.product-approval-review.json` |

After any tracked config file changes, recompute the SHA-256 fields that bind it (the product review's `provenanceSha256` and `policySha256`).

## Running the two deployments

The OpenZeppelin network manifest path is fixed per chain (`.openzeppelin/unknown-16661.json`), and preparation requires it to be absent. Run each mainnet deployment from its own clean checkout, with its own `.env.<profile>.local`.
