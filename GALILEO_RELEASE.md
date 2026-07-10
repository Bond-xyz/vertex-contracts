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
- token: `0xF2506aa3684871549083d235453a1dcDcCB3396c`
- symbol / decimals: `USDC.e` / `6`

The deployer rejects any substitute address or token metadata and never deploys a collateral token. Product zero cannot be changed to a different token after initialization. User deposits and withdrawals are quote-only; a deposit is queued only after the clearinghouse custody balance increases by the exact transferred amount, and a withdrawal returns that same configured token.

`DepositCollateralWithReferral` does not contain an on-chain deposit index. Its immutable event identity is `(transaction hash, log index)`; the settlement database may assign an internal `deposit_idx` only after the configured confirmation depth. Testnet-live acceptance must prove that identity maps to one slow-mode execution and one backend credit. Mock/admin credits and test-funding routes are not permitted release evidence.

## Reviewed build provenance gate

Deployment requires a clean checkout plus reviewer-pinned `PERPDEX_REVIEWED_RELEASE_COMMIT` and `PERPDEX_REVIEWED_SOURCE_TREE`. Obtain the two values with `git rev-parse HEAD` and `git rev-parse HEAD^{tree}` only after review, then copy them into the ignored local environment file. The deployment manifest records those values, the exact solc version and settings, and every reviewed artifact runtime hash.

Post-deploy verification re-derives the clean Git and artifact evidence, reads each transparent proxy's EIP-1967 implementation and admin slots, and compares proxy, implementation, and ProxyAdmin runtime bytecode to the reviewed artifact hashes. CI also rejects Endpoint runtime bytecode at or above 24,560 bytes, before the 24,576-byte EIP-170 ceiling.

## Release gate

```bash
HUSKY=0 corepack yarn install --frozen-lockfile --ignore-engines
corepack yarn force-compile
corepack yarn test:release
```

Generate three independent Galileo-only verifier keys without printing them:

```bash
corepack yarn keys:galileo
```

The deployment remains fail-closed until `config/galileo.products.json` is explicitly approved after Rust/contract X18 golden-vector review.

## Fresh deployment command

Use the existing ignored backend env file without copying or printing it:

```bash
export PERPDEX_ENV_FILE=/Users/blackbera/Desktop/Bond/perpdex-rust-backend/contracts/core/.env.galileo.local
export PERPDEX_VERIFIER_PUBLIC_KEYS_FILE=./config/galileo.verifier-public-keys.local.json
export PERPDEX_PRODUCTS_FILE=./config/galileo.products.json
export PERPDEX_DEPLOYMENT_MANIFEST=./deployments/16602/latest.local.json
corepack yarn deploy:galileo
corepack yarn verify:galileo
```

Required post-deploy integrations are deliberately outside this contract cartridge: Rust batch Schnorr signing, wallet order/withdrawal signature persistence, X9/X8-to-X18 conversion, audited-array `PerpTick` encoding, and removal of type 33.
