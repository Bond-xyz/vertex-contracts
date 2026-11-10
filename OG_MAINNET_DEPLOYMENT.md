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
| Release reviewer | Adam, sole external reviewer (`external_reviewer_signature`, 1 signature, no multisig) | Profile pin `releaseReviewer`. The reviewer allowlist stays empty, and the release stays blocked, until Adam's signing address is filled in. The reviewer must differ from the deployer and sequencer. |
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

- Release policies: `reviewers: []` (Adam's address is pending) and status `pending_og_mainnet_review`. The external attestation path refuses until both are set and Adam has signed.
- The Stork policies are `blocked_pending_reviewed_cross_feed_timestamp_spread`, with no runtime backend release bound.
- Products and product reviews are `approved: false` / `pending_red_approval`. The contract packet commit/tree in the reviews is `null`.
- Collateral provenance: `normalizedCarriedFieldTupleSha256` is `null` for both deployments, and USDZ `sources.bondSuperApp` is `null`. `loadTrackedCollateralProvenance` refuses while any null remains.
- The deployer balance must be funded before the first transaction.
- `bind-galileo-backend-runtime.ts` and `generate-testnet-verifier-keys.ts` are Galileo-only.

The fee policy (`config/og-mainnet.fee-policy.json`) is approved with bounds min 2000000007, default 4000000007, max 20000000000 wei, around the observed `eth_gasPrice` 4000000007 at block 49846964. At deploy time you still have to set `PERPDEX_OG_MAINNET_GAS_PRICE_WEI` explicitly, and it is checked against the live RPC fee quote.

`yarn review:og-mainnet:products` (in CI) checks that both mainnet review packets are structurally valid and lists the pending inputs.

## Operator-fill inputs

| Input | File / pin |
| --- | --- |
| Adam's reviewer signing address | `pins` `releaseReviewer.address` + `config/og-mainnet*.release-policy.json` `reviewers` |
| Adam's signed release attestation (deploy time) | `config/<profile>.release-attestation.local.json` |
| Contract packet base commit/tree (the merged commit of this config) | product reviews `contractSource` + `pins.contractPacketBase` |
| `normalizedCarriedFieldTupleSha256` (both deployments) | collateral provenance + `pins.normalizedCarriedFieldTupleSha256` |
| Super-app registry source for USDZ (regenerate the super-app registry first; it predates USDZ) | `config/og-mainnet-usdz.collateral-provenance.json` `sources.bondSuperApp` |
| Stork cross-feed spread decision and runtime backend release | `config/og-mainnet*.stork-deployment-policy.json` |
| Red approval of products and product vectors | `config/og-mainnet*.products.json`, `*.product-approval-review.json` |

After any tracked config file changes, recompute the SHA-256 fields that bind it (the product review's `provenanceSha256` and `policySha256`).

## Running the two deployments

The OpenZeppelin network manifest path is fixed per chain (`.openzeppelin/unknown-16661.json`), and preparation requires it to be absent. Run each mainnet deployment from its own clean checkout, with its own `.env.<profile>.local`.
