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

## Reviewed build provenance gate

Deployment requires a clean checkout and five mandatory inputs supplied by an independent reviewer:

- `PERPDEX_REVIEWED_RELEASE_COMMIT`
- `PERPDEX_REVIEWED_SOURCE_TREE`
- `PERPDEX_REVIEWED_BUILD_EVIDENCE_SHA256`
- `PERPDEX_REVIEWED_PRODUCT_CONFIG_SHA256`
- `PERPDEX_REVIEWED_VERIFIER_PUBLIC_KEYS_SHA256`

After reviewing the exact clean commit, the reviewer—not the deployer—runs `corepack yarn evidence:galileo` with the reviewed product and public-key file paths. The reviewer transfers the resulting five values to the deployer for the ignored local environment file. The deployment script never derives an expected hash from the file it is validating: it checks all five reviewer-pinned values before loading a signer or sending any transaction, then recomputes the three SHA-256 values after deployment before writing the manifest. The standalone post-deploy verifier requires the same reviewer inputs and compares them to both the clean checkout and schema-v3 manifest.

Build evidence byte-compares every application artifact's creation and runtime bytecode to its Hardhat solc build-info output and binds every build-info source input to the matching reviewed source-tree or installed dependency file. The release application remains compiled by exact solc `0.8.13`. OpenZeppelin upgrades-core deploys prebuilt `TransparentUpgradeableProxy` and `ProxyAdmin` artifacts originally compiled by exact solc `0.8.9`; the evidence collector deterministically recompiles the package's embedded build input with that exact compiler and requires byte-for-byte equality. Both compiler versions, full settings, input/output hashes, source hashes, creation hashes, and runtime hashes are included in the reviewer-pinned build-evidence digest.

Post-deploy verification also reads each transparent proxy's EIP-1967 implementation and admin slots and compares proxy, implementation, and ProxyAdmin runtime bytecode to the reviewed artifact hashes. It verifies the Clearinghouse's active liquidation delegate target and runtime; all eight live Verifier public-key slots, the exact signer count, and signer bitmask `7`; every VirtualBook's immutable product ID; the exact Spot and Perp product-ID sets; every Perp risk weight and price; size increment, minimum size, and LP spread; Clearinghouse spreads; and the product-zero quote token. CI rejects Endpoint runtime bytecode at or above 24,560 bytes, before the 24,576-byte EIP-170 ceiling.

## Release gate

```bash
HUSKY=0 corepack yarn install --frozen-lockfile --ignore-engines
corepack yarn force-compile
corepack yarn test:release
```

The release suite includes negative regressions for a one-byte artifact mutation, historical Verifier signer-count corruption, signed bitmask-`7` execution, and every live market/risk mismatch class.

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
