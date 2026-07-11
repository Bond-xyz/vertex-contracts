# Bond PerpDex Galileo Contract Release

This branch starts at audited Vertex V2 commit `6d5df597afe4eb16c6131a85f45322e0954b9e94` and is a **fresh-deploy-only** release. It never upgrades or adopts the existing Fable proxies.

## Explicit source deltas

1. Restore the `Version.sol` implementation omitted by the published audited snapshot so the source compiles.
2. Re-enable `OffchainExchange` EIP-712 order-signature enforcement.
3. Emit `DepositCollateralWithReferral`, which Bond settlement indexes for deposit provenance.
4. Deploy one non-custodial `VirtualBook` marker per product to prevent cross-market signature replay.
5. Pin product zero to the existing Galileo USDC.e and restrict collateral custody to exact quote-token transfers.

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

## Signed review and reproducible-build gate

Deployment requires a clean committed checkout and one EIP-712 release attestation signed outside the deployment process by a reviewer named in the tracked [`config/galileo.release-policy.json`](config/galileo.release-policy.json). Environment variables cannot change the reviewer allowlist or policy. The signed payload binds the policy version and hash, chain and exact USDC.e collateral identity, release commit and source tree, deterministic build-evidence digest, product-config digest, Verifier-config digest, signer count, and signer bitmask.

`corepack yarn evidence:galileo` produces only an unsigned review request containing the EIP-712 domain, types, payload, and digest. It never creates a signature or accepted attestation. The independent reviewer checks the clean commit and evidence, signs the exact payload using their normal external signing process, and returns a local JSON object with `schemaVersion`, the unchanged `payload`, and the 65-byte `signature`. The deployer stores it at the ignored path selected by `PERPDEX_RELEASE_ATTESTATION_FILE`.

The deployment script validates the signature against tracked policy and recomputes the clean Git commit/tree plus every bound digest immediately before its first transaction. After all transactions, it repeats the complete validation and refuses to write a schema-v4 deployment manifest if the signature, reviewer, commit/tree, policy, build, products, or Verifier evidence drifted. The standalone verifier repeats the signed-evidence check and compares it to both the local checkout and schema-v4 manifest.

Build evidence does not trust artifact/build-info agreement alone. It deterministically recompiles each application build input with exact solc `0.8.13`, then requires the security-relevant compiler output and every artifact's creation/runtime bytecode to match. OpenZeppelin upgrades-core deploys prebuilt `TransparentUpgradeableProxy` and `ProxyAdmin` artifacts originally compiled by exact solc `0.8.9`; the evidence collector deterministically recompiles that package's embedded build input with exact `0.8.9` and requires byte-for-byte equality. Both compiler versions, full settings, input/output hashes, source hashes, creation hashes, and runtime hashes are included in the signed build-evidence digest.

Post-deploy verification also reads each transparent proxy's EIP-1967 implementation and admin slots and compares proxy, implementation, and ProxyAdmin runtime bytecode to the reviewed artifact hashes. It verifies the Clearinghouse's active liquidation delegate target and runtime; all eight live Verifier public-key slots, the exact signer count, and signer bitmask `7`; every VirtualBook's immutable product ID; the exact Spot and Perp product-ID sets; every Perp risk weight and price; size increment, minimum size, and LP spread; Clearinghouse spreads; and the product-zero quote token. CI rejects Endpoint runtime bytecode at or above 24,560 bytes, before the 24,576-byte EIP-170 ceiling.

## Release gate

```bash
HUSKY=0 corepack yarn install --frozen-lockfile --ignore-engines
corepack yarn force-compile
corepack yarn test:release
```

The release suite includes negative regressions for blocked-policy, unsigned, forged, unallowlisted, stale, and operator-conflicted reviewer attestations; source/settings/compiler and paired artifact/build-info tampering; pre-transaction and pre-manifest fail-closed behavior; a one-byte artifact mutation; historical Verifier signer-count corruption; wrong signer count and bitmask; signed bitmask-`7` execution; and every live market/risk mismatch class.

Generate three independent Galileo-only verifier keys without printing them:

```bash
corepack yarn keys:galileo
```

The deployment remains fail-closed until both tracked blockers are resolved in a reviewed commit:

1. `config/galileo.release-policy.json` names at least one independent reviewer, pins their checksum address, and changes `status` to `approved_for_galileo_testnet_release`. The reviewer address must differ from both deployer and sequencer.
2. `config/galileo.products.json` is explicitly set to `approved: true` after Rust/contract X18 golden-vector review.

Neither blocker may be bypassed with an environment variable.

## Fresh deployment command

Use the existing ignored backend env file without copying or printing it:

```bash
export PERPDEX_ENV_FILE=/Users/blackbera/Desktop/Bond/perpdex-rust-backend/contracts/core/.env.galileo.local
export PERPDEX_VERIFIER_PUBLIC_KEYS_FILE=./config/galileo.verifier-public-keys.local.json
export PERPDEX_PRODUCTS_FILE=./config/galileo.products.json
export PERPDEX_RELEASE_ATTESTATION_FILE=./config/galileo.release-attestation.local.json
export PERPDEX_DEPLOYMENT_MANIFEST=./deployments/16602/latest.local.json
corepack yarn deploy:galileo
corepack yarn verify:galileo
```

Required post-deploy integrations are deliberately outside this contract cartridge: Rust batch Schnorr signing, wallet order/withdrawal signature persistence, X9/X8-to-X18 conversion, audited-array `PerpTick` encoding, and removal of type 33.
