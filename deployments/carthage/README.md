# carthage dedicated Galileo contract set

Deployed 2026-09-30 on 0G Galileo testnet (chain 16602) from this branch's
base commit `d3010540c8d18d60a691df2bd75f401582c9eb86` (`bond/galileo-refork`,
audited OtterSec base `6d5df597afe4eb16c6131a85f45322e0954b9e94`,
tag `vertex-v2-ottersec-a06f33`). The Solidity tree is untouched; this
branch only adds the isolated-environment deploy script and the records of
the resulting set for the `bond-perpdex-carthage` backend isolate.

| Contract | Proxy | Deployment block |
| --- | --- | --- |
| Endpoint | `0xf5B0c66E2f0B6298c3ADf2d86A126cF847aE5b29` | 57613240 (initialized at 57614000) |
| Clearinghouse | `0x5da0df9CDf67ad634c34702925e11e745AD9BE10` | 57613284 |
| SpotEngine | `0xDb6b1A4110ae3fa04594C292e3cd9EC1C997dDd8` | 57613322 |
| PerpEngine | `0x01432b0b0C160e440Bbb07e4b36F645Ae3BCde42` | 57613371 |
| OffchainExchange | `0x795Bec0412237E81635c0A633AB76E647E3a9D48` | 57613423 |
| Verifier | `0x6bA6Cf6992C80ce6957a3884C25511810ec815ae` | 57613188 |
| MockSanctionsList | `0x01f192e97EEdb3C1fEc69218Cf7Db4B7971EAbef` | 57613109 |
| ClearinghouseLiq | `0x5B3E601aBC41837C1B5502fCab853Ef9732EC825` | 57613125 |

Deployer / contract and ProxyAdmin owner: `0xd9Fc78DA656F15f9418b7817B2070Ae10Bb53C77`.
Sequencer (settlement signer): `0xA54Eb7eBC07ec22Be83752B9D9c14a7f9502C010`.
Collateral: the shared Galileo USDC.e `0xF2506aa3684871549083d235453a1dcDcCB3396c` (product 0).
Markets: BTC (2), ETH (4), SOL (6), 0G (8) with `VirtualBook` markers; see
`deployment.json` for every address, block, transaction and runtime code hash.

Reproduce (from a clean checkout of the base commit, deploy script untracked):

```bash
export PERPDEX_CONTRACT_SOURCE_PIN=$PWD/deployments/carthage/contract-source.json
export PERPDEX_DEPLOY_INPUTS=$PWD/deployments/carthage/deploy-inputs.json
export PERPDEX_INITIAL_PRICES=$PWD/deployments/carthage/initial-prices.json
export GALILEO_RPC_URL=https://evmrpc-testnet.0g.ai PERPDEX_GALILEO_GAS_PRICE_WEI=4000000007
export PERPDEX_GALILEO_DEPLOYER_PRIVATE_KEY=...   # never committed
TS_NODE_TRANSPILE_ONLY=1 npx hardhat run --no-compile scripts/deploy-galileo-carthage.ts --network galileo
```

Initial prices were taken from CoinGecko at deployment time; the reference
pipeline's signed Stork snapshot, single-use intent and tracked Red approval
were not run for this isolate.
