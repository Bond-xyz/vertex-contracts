# Galileo Gate-1 Contract Interface

This note is the contract-side interface for Bond PerpDex Galileo. It is derived from reviewed candidate
`7ae12f1605e8d3c0790fdfbb98922b6014b00377`, whose public Vertex base is audited commit
`6d5df597afe4eb16c6131a85f45322e0954b9e94` (`vertex-v2-ottersec-a06f33`). The release is fresh-deploy-only.

## Fixed collateral and units

- Chain: 0G Galileo, `16602`.
- Product: quote product `0` only.
- Token: `USDC.e` at `0xF2506aa3684871549083d235453a1dcDcCB3396c` with `6` decimals.
- Contract amounts passed to deposit and withdrawal are USDC.e base units.
- Internal spot balances and fees are X18. One USDC.e is `1e6` token units and `1e18` internal units.
- No collateral token is deployed by this cartridge. Product zero cannot be replaced after initialization.

## Signed batch, order, and nonce domains

### Batch domain

`Endpoint.submitTransactionsChecked(uint64,bytes[],bytes32,bytes32)` has selector `0x10f37344`. The sequencer must
submit the exact current `nSubmissions` index. The Schnorr message starts as `keccak256(abi.encode(idx))` and folds
each encoded transaction in order with `keccak256(abi.encodePacked(previousDigest, transaction))`.

The Endpoint always calls `Verifier.requireValidSignature(..., 7)`. The Galileo verifier configuration therefore has
exactly three distinct keys in slots 0-2 and signer bitmask `7`; all three keys participate in the submitted aggregate
signature. This is separate from wallet EIP-712 signatures.

### Wallet action domain

Direct withdrawals use EIP-712 domain `Vertex` / `0.0.1` / chain ID / Endpoint address and type:

```text
WithdrawCollateral(bytes32 sender,uint32 productId,uint128 amount,uint64 nonce)
```

The Endpoint action nonce is stored by the first 20 bytes of `sender`. All subaccounts belonging to one wallet share
that action-nonce sequence. A successful direct withdrawal consumes the nonce. Slow-mode withdrawal does not consume
this nonce because queue ownership is bound to `msg.sender` and rechecked against the subaccount at execution.

### Order domain and flags

Orders use EIP-712 domain `Vertex` / `0.0.1` / chain ID / the market's unique `VirtualBook` address and type:

```text
Order(bytes32 sender,int128 priceX18,int128 amount,uint64 expiration,uint64 nonce)
```

`VirtualBook.productId()` has selector `0xc5ce3911`. Its per-market address prevents a signature from being replayed
on another product.

The `expiration` field is encoded as follows:

- bits 0-57: UNIX expiration timestamp in seconds;
- bits 58-60: reserved and required to remain zero in Bond encoders;
- bit 61: reduce-only;
- bits 62-63: order type (`0` default, `1` IOC, `2` FOK, `3` post-only).

The official Vertex SDK limits reduce-only construction to IOC or FOK. The contract's safety check is stricter about
effect than encoding: whenever bit 61 is present it clips the remaining amount to the current opposite-signed position.
In Bond `CLOSE_ONLY` mode, every non-system order must carry bit 61. Tests prove an oversized close cannot cross zero or
flip the position.

The order `nonce` is part of the signed digest and the `filledAmounts` replay domain; it is not the Endpoint action
nonce. Vertex clients encode an engine receive deadline in `nonce >> 20` plus low-bit uniqueness. The backend must
generate and persist this value before signing and must never silently substitute an action nonce.

## Transaction ordinals and PerpTick

The audited ordinal surface is unchanged. Gate-1-relevant ordinals are deposit `1`, withdraw `2`, update price `4`,
match orders `6`, execute slow mode `8`, and PerpTick `15`.

PerpTick is encoded as:

```text
uint8(15) || abi.encode(PerpTick({ uint128 time, int128[] avgPriceDiffs }))
```

`time` is UNIX seconds. `avgPriceDiffs` uses X18 quote-price-per-base units and is positional against
`PerpEngine.getProductIds()`. For this release the reviewed atomic array order is BTC `2`, ETH `4`, SOL `6`, 0G `8`.
The contract computes `dt` from the prior PerpTick, caps each absolute price difference to 2% of the product index price,
and applies the time-weighted funding delta. The backend must submit all four entries atomically; per-market or X8/X9
payloads do not match this ABI.

## Direct withdrawal conservation

For product zero:

1. the wallet signs the direct withdrawal and the three-key batch executes it;
2. exactly `requestedAmount` USDC.e base units move from Clearinghouse to the wallet;
3. exactly `1e18` internal quote units are separately debited as the product-zero direct withdrawal fee;
4. `WithdrawalSettled` emits the configured token, recipient, requested amount, and requested-amount X18 delta;
5. total internal balance reduction is requested X18 amount plus the `1e18` direct fee.

The fee is read on chain with `SpotEngine.getWithdrawFee(0)`. The event's `requestedAmountDeltaX18` deliberately
excludes the separate direct fee so reconciliation must account for both values.

## Slow withdrawal and sequencer-off exit

Slow withdrawal is raw ordinal `2` plus the unsigned `WithdrawCollateral` tuple. Queue submission:

- requires the submitting wallet to match the first 20 bytes of the subaccount at execution;
- transfers exactly `1_000_000` USDC.e base units from that wallet to Endpoint as the slow queue fee;
- schedules execution at queue-block timestamp plus `259_200` seconds;
- can be executed by any address after the timeout without the sequencer;
- transfers exactly the requested same-token amount and charges no additional internal direct-withdraw fee.

Successful execution emits `WithdrawalSettled`. A failed execution advances the audited FIFO cursor and emits
`SlowModeTransactionFailed(index)` but no success event; the requested USDC.e remains in Clearinghouse and the internal balance is unchanged. The audited queue
has no cancellation ABI and the queue fee is non-refundable. Backend status must therefore distinguish `queued`,
`completed` (finalized success event), and `failed` (finalized failure event and cursor advance). It must not
invent a `cancelled` state. Adding cancellability or a persistent per-index status mapping would require a separately
reviewed Endpoint redesign because the reviewed Endpoint is at the EIP-170 size boundary.

Local Hardhat time travel proves the state transition at three days, including a public executor and failed execution,
but it is not evidence that a live Galileo transaction remained executable for 72 wall-clock hours. Live acceptance
still requires a real queued exit, 72-hour wait, public execution, receipt, and balance reconciliation.

## Monotonic release modes

Clearinghouse starts at `ACTIVE` (`0`) and may only move forward:

1. `ACTIVE` (`0`): deposits and normal order matching enabled;
2. `CLOSE_ONLY` (`1`): new deposits, unflagged orders, AMM swaps, and LP minting disabled; reduce-only orders are clipped
   to existing positions; direct and slow withdrawals remain enabled;
3. `WITHDRAWALS_ONLY` (`2`): all matching disabled; direct and slow withdrawals remain enabled. Entry requires the
   current mode to be `CLOSE_ONLY`; every perp must have zero open interest, available settlement, LP supply/reserves,
   and X-account base/vQuote; every spot product must have zero borrows, LP supply/reserves, and X-account balance; and
   every non-quote spot product must have zero deposits.

The transition is monotonic within this implementation. A deposit already in custody before shutdown may still finish
its queued ledger credit so the owner can withdraw it; new custody intake is rejected before token transfer.

This is not cryptographically irreversible at the proxy-system level: the ProxyAdmin owner can replace an
implementation. Gate 1 records that authority explicitly and its release procedure forbids using an upgrade to bypass
or reset shutdown state. Moving ProxyAdmin to a reviewed multisig or timelock is a separate operator/governance decision and
must be completed before describing shutdown as admin-irreversible.

The enumerable on-chain gate cannot prove every account's `vQuoteBalance` is zero. `SettlePnl` remains executable in
withdrawals-only mode, but the operator must enumerate recorded subaccounts, settle and reconcile per-account PnL, and
prove final token custody conservation before retiring the graph.

## Deployment, verification, and abandonment

The release remains fail-closed while the tracked Red Galileo-testnet approval is absent, the product-vector review
contains a mismatch, or `config/galileo.products.json` has `approved: false`. Galileo testnet does not invent a second
human reviewer wallet; its tracked approval must bind exact candidate, build, config, CI, agent-review, and deployment-
intent evidence. Mainnet external review remains required. No script selects verifier custody or risk parameters.

`corepack yarn diff:galileo` verifies the current ABI, storage prefix, compiler settings, runtime hashes, and Endpoint
size against the exact reviewed candidate. The fresh deployment manifest records that diff, all roles, exact product
parameters, contract creation transactions, proxy implementations/admins, bytecode hashes, the collateral assertion,
and pending explorer verification at `https://chainscan-galileo.0g.ai`.

Before any deposit, rollback means never publishing the new registry and abandoning the parallel graph. After any
deposit, rollback means remaining in `CLOSE_ONLY` until perp open interest, available settlement, LP/system reserves,
spot borrows, X-account balances, and non-quote deposits are zero and every recorded account's PnL is reconciled; only
then may the operator move to `WITHDRAWALS_ONLY`, complete and reconcile every same-token exit, and remove the graph
from the registry. It never means adopting old proxy state, deleting the incumbent stack, or upgrading an unreviewed
implementation in place.
