# Galileo testnet contract cutover checklist

This is the command order for the restricted Galileo release. It never permits
mock collateral, an unresolved backend artifact, a reused nonce plan, or a
price-bearing transaction before the signed Stork packet is verified.

## 1. Build and test the exact contract candidate

```bash
git fetch origin bond/galileo-refork
git status --short
git rev-parse HEAD
HUSKY=0 corepack yarn install --frozen-lockfile --ignore-engines
corepack yarn force-compile
corepack yarn diff:galileo
corepack yarn test:release
```

The checkout must be clean. CI and an independent review must refer to the
same final candidate commit later recorded in the Red approval artifact.

## 2. Bind the retained backend artifact before activating release policy

The runtime source is exact commit
`4d479bd167d4cc98dce373af214a5d109b9cad33`. Obtain the immutable retained
Linux artifact manifest as a local read-only file and independently review its
SHA-256. Do not type a guessed hash.

```bash
export PERPDEX_BACKEND_RUNTIME_SOURCE_COMMIT=4d479bd167d4cc98dce373af214a5d109b9cad33
export PERPDEX_BACKEND_ARTIFACT_MANIFEST_FILE=/absolute/path/to/reviewed-retained-artifact-manifest.json
export PERPDEX_REVIEWED_BACKEND_ARTIFACT_MANIFEST_SHA256=<exact-sha-from-separate-artifact-review>
test "$(shasum -a 256 "$PERPDEX_BACKEND_ARTIFACT_MANIFEST_FILE" | awk '{print $1}')" = \
  "$PERPDEX_REVIEWED_BACKEND_ARTIFACT_MANIFEST_SHA256"
corepack yarn bind:galileo:backend
git diff -- config/galileo.stork-deployment-policy.json config/galileo.release-policy.json
```

The command refuses any other backend commit, a hash that does not match the
manifest bytes, partial prior bindings, or a dirty tracked checkout. It writes
the immutable runtime binding first and activates the testnet policy second,
so an interrupted run remains fail-closed. Review and commit only those two
policy changes, then obtain green deterministic CI and independent review for
that exact commit.

## 3. Prepare public verifier and unsigned nonce evidence

Use the existing protected three-key Galileo verifier quorum. Copy only its
public-key JSON into the ignored local path; never print or copy private-key
material into this repository.

```bash
install -m 0600 /absolute/protected/path/verifier-public-keys.json \
  ./config/galileo.verifier-public-keys.local.json

export PERPDEX_ENV_FILE=/Users/blackbera/Desktop/Bond/perpdex-rust-backend/contracts/core/.env.galileo.local
set -a
source "$PERPDEX_ENV_FILE" >/dev/null 2>&1
set +a
export PERPDEX_DEPLOYER_ADDRESS="$(cast wallet address --private-key "$PERPDEX_GALILEO_DEPLOYER_PRIVATE_KEY")"
export PERPDEX_SEQUENCER_ADDRESS="$PERPDEX_DEPLOYER_ADDRESS"
test "$(cast chain-id --rpc-url "$GALILEO_RPC_URL")" = 16602
export PERPDEX_FIRST_TRANSACTION_NONCE="$(cast nonce --block pending --rpc-url "$GALILEO_RPC_URL" "$PERPDEX_DEPLOYER_ADDRESS")"
export PERPDEX_ADDRESS_PLAN_FILE=./deployments/16602/address-plan.local.json
corepack yarn plan:galileo:addresses
```

Before creating the intent, inspect all 19 `CREATE` entries in the plan with
`cast code --rpc-url "$GALILEO_RPC_URL" <address>` and require `0x` for every
one. Also require live USDC.e at
`0xF2506aa3684871549083d235453a1dcDcCB3396c`, symbol `USDC.e`, decimals `6`,
and adequate native gas. If the pending nonce changes, delete the ignored plan
and regenerate it. Do not edit a plan.

## 4. Create the single-use intent and tracked Red approval

Create the intent only after the final backend binding commit and while the
address plan is still current. Use a unique positive release nonce and an
expiry long enough for CI/review/deployment but not a reusable open-ended one.

```bash
export PERPDEX_DEPLOYMENT_NONCE=<unique-positive-integer>
export PERPDEX_RELEASE_EXPIRES_AT=<unix-seconds>
export PERPDEX_DEPLOYMENT_INTENT_FILE=./config/galileo.deployment-intent.local.json
corepack yarn intent:galileo

export PERPDEX_PRODUCTS_FILE=./config/galileo.products.json
export PERPDEX_PRODUCT_REVIEW_FILE=./config/galileo.product-approval-review.json
export PERPDEX_VERIFIER_PUBLIC_KEYS_FILE=./config/galileo.verifier-public-keys.local.json
corepack yarn evidence:galileo > ./config/galileo.review-request.local.json
```

After deterministic GitHub CI and independent-agent review are captured as
untracked JSON evidence bound to the exact candidate commit:

```bash
export PERPDEX_CI_EVIDENCE_FILE=/absolute/path/to/ci-evidence.json
export PERPDEX_AGENT_REVIEW_EVIDENCE_FILE=/absolute/path/to/agent-review-evidence.json
corepack yarn approval:galileo:red
```

Red reviews the exact hashes, changes only `decision` to
`approve_exact_galileo_testnet_release`, records `approvedAt`, and commits only
`config/galileo.red-testnet-approval.json`. Re-run the release suite after that
approval-only commit.

## 5. Final no-broadcast recheck

Immediately before `prepare`, repeat chain ID, pending nonce, 19 empty-code
checks, USDC.e code/metadata, native gas, intent expiry, clean checkout, exact
approved candidate ancestry, and absence of `.openzeppelin/unknown-16602.json`.
Any drift requires a fresh plan, intent, CI evidence, review, and Red approval.

## 6. Prepare the non-price-bearing graph

```bash
export PERPDEX_RED_APPROVAL_FILE=./config/galileo.red-testnet-approval.json
export PERPDEX_PREPARED_DEPLOYMENT=./deployments/16602/prepared.local.json
export PERPDEX_FINALIZATION_JOURNAL=./deployments/16602/finalization.local.json
export PERPDEX_DEPLOYMENT_MANIFEST=./deployments/16602/latest.local.json
export PERPDEX_QUOTE_TOKEN_ADDRESS=0xF2506aa3684871549083d235453a1dcDcCB3396c # gitleaks:allow -- public ERC-20 address
export PERPDEX_DEPLOY_PHASE=prepare
corepack yarn deploy:galileo
```

This broadcasts 24 preparation transactions only. It must finish with Endpoint
uninitialized, no perp products/prices, one expected ProxyAdmin, and a durable
prepared packet. Do not continue if its ending nonce or graph differs from the
reviewed address plan.

## 7. Capture signed Stork evidence and finalize

Obtain a fresh credential-free raw Stork response for exactly BTC/USD,
ETH/USD, SOL/USD, and 0G/USD plus a matching canonical Galileo observation
block. Store both files mode `0600`; never put the Stork API key in either.

```bash
export PERPDEX_STORK_RAW_RESPONSE_FILE=./config/galileo.stork-raw-response.local.json
export PERPDEX_STORK_OBSERVATION_BLOCK_FILE=./config/galileo.stork-observation-block.local.json
export PERPDEX_STORK_SNAPSHOT_FILE=./config/galileo.stork-deployment-snapshot.local.json
corepack yarn snapshot:galileo:stork

export PERPDEX_DEPLOY_PHASE=finalize
corepack yarn deploy:galileo
corepack yarn verify:galileo
```

The snapshot and every price-bearing receipt must satisfy signed proof parity,
maximum age 30 seconds, maximum future skew 2 seconds, maximum cross-feed
spread 3 seconds, and observation-block canonicality. Final verification must
reach 12 confirmations and prove bytecode, roles, ProxyAdmin owner, product
sets, risk parameters, VirtualBook product IDs, exact collateral, finalization
journal, and schema-v9 manifest. Only then may the backend/frontend consume the
fresh addresses.
