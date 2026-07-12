# Bond PerpDex Galileo Contract Release

This branch starts at audited Vertex V2 commit `6d5df597afe4eb16c6131a85f45322e0954b9e94` and is a **fresh-deploy-only** release. It never upgrades or adopts the existing Fable proxies.

## Explicit source deltas

1. Restore the `Version.sol` implementation omitted by the published audited snapshot so the source compiles.
2. Re-enable `OffchainExchange` EIP-712 order-signature enforcement.
3. Emit `DepositCollateralWithReferral`, which Bond settlement indexes for deposit provenance.
4. Deploy one non-custodial `VirtualBook` marker per product to prevent cross-market signature replay.
5. Pin product zero to the existing Galileo USDC.e and restrict collateral custody to exact quote-token transfers.
6. Add implementation-level monotonic `ACTIVE` → `CLOSE_ONLY` → `WITHDRAWALS_ONLY` release controls without changing the audited Endpoint function or storage surface.
7. Emit exact `WithdrawalSettled` success and `SlowModeTransactionFailed` failure evidence.

The proxy deployment explicitly permits the audited `Clearinghouse` delegatecall to the pinned `ClearinghouseLiq` implementation; no other unsafe OpenZeppelin validation bypass is allowed.

No unsigned batch overload and no `UpdatePerpBalance` transaction exist.

## Galileo collateral gate

The only collateral for this release is the existing 0G Galileo testnet USDC.e:

- chain ID: `16602`
- product ID: `0`
- token: `0xF2506aa3684871549083d235453a1dcDcCB3396c` <!-- gitleaks:allow -- public ERC-20 address -->
- symbol / decimals: `USDC.e` / `6`

The deployer rejects any substitute address or token metadata and never deploys a collateral token. Product zero cannot be changed to a different token after initialization. User deposits and withdrawals are quote-only; a deposit is queued only after the clearinghouse custody balance increases by the exact transferred amount, and a withdrawal returns that same configured token.

`DepositCollateralWithReferral` does not contain an on-chain deposit index. Its immutable event identity is `(chain ID, Endpoint address, transaction hash, log index)`; the settlement database may assign an internal `deposit_idx` only after the configured confirmation depth. Testnet-live acceptance must prove that identity maps to one slow-mode execution and one backend credit. Mock/admin credits and test-funding routes are not permitted release evidence.

## Tracked Red testnet approval and reproducible-build gate

Galileo testnet has one product and release owner: Red. It does not invent a second human or a fake independent reviewer wallet. Deployment instead requires a tracked [`config/galileo.red-testnet-approval.json`](config/galileo.red-testnet-approval.json) committed after the exact reviewed candidate. The artifact binds the candidate commit and tree, deterministic build evidence, product config and product-review evidence, Verifier config, signer count and bitmask, a single-use deployment intent, successful deterministic GitHub CI, and at least one independent agent review. The final approval commit may change only that tracked approval file. Mainnet external review and multisig requirements are explicitly not waived.

The ignored deployment-intent file binds a unique deployment ID and release nonce, expiry, nonzero deployer and sequencer, the deployer's exact pending transaction nonce, and the contract address that nonce must create. Create it from public values only:

```bash
export PERPDEX_DEPLOYER_ADDRESS=0x...
export PERPDEX_SEQUENCER_ADDRESS=0x...
export PERPDEX_DEPLOYMENT_NONCE=1
export PERPDEX_FIRST_TRANSACTION_NONCE=<current-pending-nonce>
export PERPDEX_RELEASE_EXPIRES_AT=<unix-seconds>
export PERPDEX_DEPLOYMENT_INTENT_FILE=./config/galileo.deployment-intent.local.json
corepack yarn intent:galileo
```

The deployer must still have that exact pending nonce, the intent must be unexpired, and the expected first contract address must have no bytecode immediately before the first transaction. The sanctions deployment explicitly consumes that nonce. Once any first transaction is mined, the approval cannot authorize another graph; partial-deployment recovery requires a new intent, a fresh deterministic evidence run, and a new tracked Red approval.

After the product vector, policy, verifier config, deployment intent, GitHub CI, and agent-review evidence are all ready, `corepack yarn approval:galileo:red` creates a pending tracked approval artifact. It never approves itself. Red reviews the exact hashes, changes only `decision` to `approve_exact_galileo_testnet_release`, records `approvedAt`, and commits only that file. The deployment script rejects an approval file supplied from any untracked or environment-overridden location.

The deployment script recomputes the approved candidate boundary and every bound digest immediately before its first transaction. It rejects a zero operator, mismatched deployer/sequencer intent, duplicate Verifier keys, and any pre-existing Galileo OpenZeppelin network manifest. After all transactions, it repeats the complete validation and refuses to write a schema-v9 deployment manifest if the approval, intent, candidate, policy, build, product review, Verifier evidence, CI evidence, agent review, or reviewed contract diff drifted. The standalone verifier repeats the same checks against both the local checkout and schema-v9 manifest.

Build evidence does not trust artifact/build-info agreement alone. It deterministically recompiles each application build input with exact solc `0.8.13`, then requires the security-relevant compiler output and every artifact's creation/runtime bytecode to match. OpenZeppelin upgrades-core deploys prebuilt `TransparentUpgradeableProxy` and `ProxyAdmin` artifacts originally compiled by exact solc `0.8.9`; the evidence collector deterministically recompiles that package's embedded build input with exact `0.8.9` and requires byte-for-byte equality. Both compiler versions, full settings, input/output hashes, source hashes, creation hashes, and runtime hashes are included in the signed build-evidence digest.

Post-deploy verification also reads each transparent proxy's EIP-1967 implementation and admin slots and compares proxy, implementation, and ProxyAdmin runtime bytecode to the reviewed artifact hashes. A deployment starts only when `.openzeppelin/unknown-16602.json` is absent, forces new implementation deployments, and records each proxy, implementation, and ProxyAdmin creation transaction hash, deployer nonce, block number/hash, and address. The verifier replays those receipts and requires the shared ProxyAdmin owner to remain the signed deployer. It also verifies the Clearinghouse's active liquidation delegate target and runtime; all eight live Verifier public-key slots, three distinct verifier keys, the exact signer count, and signer bitmask `7`; every VirtualBook's immutable product ID; the exact Spot and Perp product-ID sets; every Perp risk weight and price; size increment, minimum size, and LP spread; Clearinghouse spreads; and the product-zero quote token. CI rejects Endpoint runtime bytecode at or above 24,560 bytes, before the 24,576-byte EIP-170 ceiling.

## Release gate

```bash
HUSKY=0 corepack yarn install --frozen-lockfile --ignore-engines
corepack yarn force-compile
corepack yarn diff:galileo
corepack yarn test:release
```

The release suite includes negative regressions for tracked Red approval scope and provenance drift; the retained external-signature implementation used by future mainnet policy; duplicate Verifier keys; stale valid OpenZeppelin manifests; source/settings/compiler and paired artifact/build-info tampering; pre-transaction and pre-manifest fail-closed behavior; a one-byte artifact mutation; historical Verifier signer-count corruption; wrong signer count and bitmask; signed bitmask-`7` execution; creation-transaction and ProxyAdmin-owner provenance; and every live market/risk mismatch class.

Generate three independent Galileo-only verifier keys without printing them:

```bash
corepack yarn keys:galileo
```

## Four-market Stork price packet

The approved static launch vector contains only sizing and 20x risk weights. It contains no BTC, ETH, SOL, or 0G reference price. Finalization requires one untracked packet containing the exact signed `BTCUSD`, `ETHUSD`, `SOLUSD`, and `0GUSD` Stork proofs plus a canonical Galileo observation block. The packet creator verifies feed identity, price/proof parity, the pinned aggregator signature, median-v1 checksum, signed freshness and future skew, the observation block timestamp, and the reviewed cross-feed signed-timestamp spread before it writes the packet. Finalization verifies the packet again before every price-bearing broadcast and against every receipt block.

The cross-feed maximum signed-timestamp spread is deliberately `null` in [`config/galileo.stork-deployment-policy.json`](config/galileo.stork-deployment-policy.json). Red is the decision owner. While it is null, the validator requires the exact fail-closed pair `status = blocked_pending_reviewed_cross_feed_timestamp_spread` and `coherence.decision = pending_explicit_red_policy_input`. After Red supplies the exact reviewed integer, the only accepted testnet pair is `status = approved_for_galileo_testnet_release` and `coherence.decision = approve_exact_galileo_testnet_cross_feed_timestamp_spread`. Arbitrary or mixed states fail before packet creation, deployment intent creation, graph preparation, or finalization. The Stork coherence decision does not replace the separately tracked Red release approval. No proposed value, including three seconds, is an approved substitute.

After that decision is committed and reviewed, create the untracked verified packet from a no-secret Stork response and matching public block evidence:

```bash
export PERPDEX_STORK_RAW_RESPONSE_FILE=./config/galileo.stork-raw-response.local.json
export PERPDEX_STORK_OBSERVATION_BLOCK_FILE=./config/galileo.stork-observation-block.local.json
export PERPDEX_STORK_SNAPSHOT_FILE=./config/galileo.stork-deployment-snapshot.local.json
corepack yarn snapshot:galileo:stork
```

The packet records each feed identity, exact X18 value, signed timestamp, signature proof, observation block, final runtime source/artifact binding, policy hash, and deterministic packet hash in the final manifest. It is never a tracked source file and never contains Stork credentials.

The backend commit `1d174da2f130cf6f4f03b29029a002d92acc76f8` is only the reviewed protocol baseline used for the withdrawal, sizing, and Stork compatibility checks in this packet. It is not the deployable backend. The final runtime source commit and immutable artifact-manifest SHA-256 are deliberately `null` in the tracked Stork policy. Release preparation remains blocked until the final reviewed Linux artifact supplies both values together; the policy hash then binds them into the deployment intent, Red approval, attestation, Stork packet, and final manifest.

The deployment remains fail-closed until all tracked blockers are resolved in a reviewed candidate:

1. Red supplies the exact cross-feed maximum signed-timestamp spread. It is currently unset and blocks every release phase.
2. Bind the exact final backend source commit and immutable Linux artifact-manifest SHA-256. The reviewed `1d174da2` protocol baseline cannot fill either field.
3. The reviewed Stork policy and Galileo-only release policy change to their approved testnet states; mainnet external review remains required.
4. Generate three Galileo-only Verifier keys, a current single-use deployment intent, and successful deterministic CI plus independent-agent review evidence for the exact candidate.
5. Generate the pending tracked Red approval, have Red approve the exact hashes, and commit only that artifact after the candidate.
6. Capture and verify one fresh four-feed Stork packet immediately before finalization. Any missing, stale, future-skewed, incoherent, tampered, or reorged evidence stops before the next transaction.

No blocker may be bypassed with an environment variable.

## Shutdown and withdrawal contract

The exact ABI, flag, nonce, funding-tick, fee, slow-exit, mode, and rollback contract is recorded in [`GALILEO_GATE1_CONTRACT_INTERFACE.md`](GALILEO_GATE1_CONTRACT_INTERFACE.md). Local time travel is regression evidence, not a substitute for the required live 72-hour Galileo exit.

## Fresh deployment command

Use the existing ignored backend env file without copying or printing it:

```bash
export PERPDEX_ENV_FILE=/Users/blackbera/Desktop/Bond/perpdex-rust-backend/contracts/core/.env.galileo.local
export PERPDEX_VERIFIER_PUBLIC_KEYS_FILE=./config/galileo.verifier-public-keys.local.json
export PERPDEX_PRODUCTS_FILE=./config/galileo.products.json
export PERPDEX_PRODUCT_REVIEW_FILE=./config/galileo.product-approval-review.json
export PERPDEX_RED_APPROVAL_FILE=./config/galileo.red-testnet-approval.json
export PERPDEX_DEPLOYMENT_INTENT_FILE=./config/galileo.deployment-intent.local.json
export PERPDEX_STORK_SNAPSHOT_FILE=./config/galileo.stork-deployment-snapshot.local.json
export PERPDEX_PREPARED_DEPLOYMENT=./deployments/16602/prepared.local.json
export PERPDEX_FINALIZATION_JOURNAL=./deployments/16602/finalization.local.json
export PERPDEX_DEPLOYMENT_MANIFEST=./deployments/16602/latest.local.json
export PERPDEX_DEPLOY_PHASE=prepare
corepack yarn deploy:galileo
export PERPDEX_DEPLOY_PHASE=finalize
corepack yarn deploy:galileo
corepack yarn verify:galileo
```

The prepare phase deploys only the uninitialized, non-price-bearing graph. The finalize phase is the first path allowed to initialize prices or add markets, and it cannot start without the fresh verified Stork packet.

Required post-deploy integrations are deliberately outside this contract cartridge: Rust batch Schnorr signing, wallet order/withdrawal signature persistence, X9/X8-to-X18 conversion, audited-array `PerpTick` encoding, and removal of type 33.
