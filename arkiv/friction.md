# Friction report: building Groundtruth on Arkiv

Environment for every entry unless stated: `@arkiv-network/sdk` 0.8.1, `viem` 2.57.7, Node.js 22.23.1, Fedora Linux, Tiramisu testnet (chain ID `7738577`), 18 October 2026.

Each entry says whether we **reproduced** it ourselves or **inferred** it from the SDK source or docs. Smooth paths we tested are listed too.

---

## 1. Faucet cannot pay out when its balance drops below one claim (reproduced, blocking)

- **Surface:** Arkiv Hub faucet, https://hub.arkiv.network/faucet
- **Steps:** Sign in, enter recipient `0xC3c2cca0513ee2538Df4b1e2bd6529cE31abf920`, solve the CAPTCHA, claim.
- **Expected:** 10 testnet GLM arrives, or a clear "faucet is empty, try later" message.
- **Actual:** The page shows a raw viem error:
  `insufficient funds for gas * price + value: have 9995400999990802000 want 10000000000000000000`
  from the faucet wallet `0x815Ad950ae49102952C10ceBB18901E9e28AC712` (`viem@2.51.3`). We confirmed the faucet wallet's balance on-chain: 9.9954 GLM. Every claim fails, for every user, until someone refills it, even though 9.99 GLM would fund thousands of transactions at the current 1 gwei gas price.
- **Impact:** This was our only path to testnet GLM, and it blocked our first entity write on deadline day.
- **Suggested fix:** Pay `min(perClaim, balance - gasReserve)` when the balance is low; show a human-readable "faucet empty" state; alert operators below a threshold (for example 100 GLM). A second funding path (a Discord bot or a dev-only top-up endpoint behind the Hub login) would remove the single point of failure.

## 2. Entity expiry emits no event, so lapse detection needs a timer (inferred from the SDK, then designed around)

- **Surface:** `watchEntityEvents` (SDK 0.8.1), `EntityEvent` union in `src/types/events.ts`
- **Expected:** An `EntityExpired` event, or a documented way to be notified when an entity's lifetime ends. Groundtruth's shutdown detection *is* a lease expiring.
- **Actual:** The union is `EntityCreated | EntityPatched | ExpiryExtended | OwnershipTransferred | EntityDeleted`. Expiry is silent.
- **Workaround:** The dashboard tracks each lease's `expiresAt` block, estimates the head block from a 2-second block time, and checks every 5 seconds (`checkLeases()` in `web/main.ts`). A lease past its expiry is only dropped after a successful query made *after* that moment confirms it was not renewed; until then the probe shows "overdue". Without that check, a dashboard whose feed had silently died marked every region dark (entry 13).
- **Suggested fix:** Emit an `EntityExpired` log when the engine prunes an entity, or document how to watch for it. Even an event batched at block boundaries would let apps drop their timers.

## 3. `ExpiryExtended` does not say who extended (inferred from SDK types)

- **Surface:** `ExpiryExtendedEvent` in `src/types/events.ts`
- **Expected:** With `permissionlessExtension`, the extender matters. In Groundtruth, an extension means "another network confirmed this block".
- **Actual:** The event carries the entity's `owner`, not the sender. The SDK's own doc comment says to read the transaction's sender if you need it.
- **Workaround:** The dashboard labels any extension of evidence as "corroborated by another network" because only other networks' probes extend evidence (`corroborate()` in `probe/probe.ts` skips its own wallet and ASN). A third party extending would be mislabelled.
- **Suggested fix:** Add an `extendedBy` field to the event.

## 4. One failing extension reverts the whole batch (inferred from the docs; designed around)

- **Surface:** `executeBatch`, `extendEntity` (SDK 0.8.1)
- **Expected:** Being able to put "renew my lease" and "corroborate other probes' evidence" in one batch.
- **Actual:** The SDK docs say an extension that does not move the expiry later is rejected. Two probes corroborating the same evidence in the same block could make one extension non-increasing, and that would revert the whole batch, including the round's measurements.
- **Workaround:** Measurements and the lease renewal go in one batch (they must land together); corroboration extensions go in a separate transaction whose failure is logged and ignored. We also skip entities already extended to at least 90% of the corroborated lifetime.
- **Suggested fix:** An "extend to at least" mode that is a no-op instead of a revert when the entity already lives longer.

## 5. A bare `number` attribute is `i32` (tested; worked as documented)

- **Surface:** Attribute values, `src/attr/values.ts`
- **Tested:** `render(and(eq("project", "groundtruth"), eq("kind", "measurement"), gte("ts", 0)))` renders `ts >= i32(0)`. Bare numbers in `createEntity` attributes are stored as `i32` too, so writes and range queries match without explicit type tags.
- **Note for other builders:** Unix seconds in `i32` overflow in January 2038. Fine for a 48-hour measurement, but long-lived data should use `u64(...)` on both the write and the query side.

## 6. A query must have at least one filter (tested; behaves as designed)

- **Steps:** `client.select({ key: true }).limit(2).fetch()` with no `where`.
- **Expected:** Either the first page of all entities or a clear error.
- **Actual:** `InvalidPredicateError: A query needs at least one filter …` A clear message. We always filter on `project = "groundtruth"`, so this did not affect us.

## 7. Raw JSON-RPC query works exactly as the SDK renders it (tested; smooth)

- **Steps:** `render()` the SDK expression, then send it with curl as `arkiv_query` with `{"select": {...}, "limit": "0xc8"}`.
- **Actual:** `{"jsonrpc":"2.0","id":1,"result":{"data":[],"blockNumber":"0xb4666"}}`. The command is on the dashboard's "Verify without us" section and in `arkiv/schema.md`. Being able to show judges the same query without our code is what makes the Censorship Resistance claim checkable.
- **Suggestion:** Document `arkiv_query`'s parameter shape (hex `limit`, the `select` object) on the docs site; we found it in `src/types/rpcSchema.ts`.

## 8. Docs and README drift (observed)

- The SDK README's install snippet shows `"@arkiv-network/sdk": "^0.6.0"` while npm serves 0.8.1.
- The README's sample private key (`0xc360…6cf9`) had a balance of 0 when we checked, so the copy-paste path fails without the faucet.
- **Suggested fix:** Generate the version in the README at release time; drop the shared sample key or point to the faucet first.

## 9. Explorer URL scheme is undocumented (observed)

- **Surface:** https://tiramisu.explorer.arkiv.network
- **Expected:** Documented deep links for entities, addresses and transactions, so dashboards can link to on-chain proof.
- **Actual:** We found `/entity/<key>`, `/address/<addr>` and `/tx/<hash>` in the explorer's JavaScript bundle. `/api/v2/stats` (Blockscout-style) returns 404.
- **Suggested fix:** One line in the docs listing the URL patterns.

## 10. Writing from an unfunded wallet fails with an opaque error (reproduced)

- **Surface:** `executeBatch` (SDK 0.8.1) from a wallet with a balance of 0
- **Steps:** `node probe/probe.ts --lab --rounds 1 --key-env PROBE_KEY_A --asn 64500 --isp "Lab ISP A" --region IN-LAB-NORTH` with an unfunded key.
- **Expected:** "insufficient funds" (what viem reports for a plain transfer, as the faucet error in entry 1 shows).
- **Actual:** `Transaction failed: Execution error without revert data`.
- **Workaround:** The probe now checks `getBalance` at start-up and exits with a clear message and the faucet link.
- **Suggested fix:** Pre-flight the balance in `sendArkivTransaction`, or map the node's error to an `InsufficientFundsError`.

## 11. Anonymous query budget runs out, and the SDK stalls for the whole Retry-After instead of failing (reproduced, high impact)

- **Surface:** Tiramisu public RPC `arkiv_query`; `createPublicClient` with the default viem `http()` transport (SDK 0.8.1, viem 2.57.7)
- **Steps:** From one IP, run a few dozen dashboard-style queries (`select({ key, creator, expiresAt, attributes })` with `and(eq, eq, gte)`, plus `or()` on `verdict`) over roughly an hour of development. Then:
  ```bash
  curl -s -i https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"arkiv_query\",\"params\":[\"project = str('groundtruth') AND kind = str('probe')\",{\"select\":{\"key\":true},\"limit\":\"0x1\"}]}"
  ```
- **Actual:** `HTTP/2 429`, `ratelimit: limit=10000, remaining=0, reset=1876`, `retry-after: 1876`, body `{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}`. `eth_blockNumber` still works from the same IP.
- **Then, in the SDK:** `client.select(...).fetch()` and even `Promise.all` with `getBlockNumber()` never resolved within 40 seconds. viem's default transport retries a 429 after the `Retry-After` delay (`node_modules/viem/_esm/utils/buildRequest.js`, line 132), so the call silently waits about 31 minutes. Our dashboard just sat on "connecting…".
- **Expected:** A documented anonymous budget (size, window, cost per query), and a typed `QueryError` such as `RateLimitedError { retryAfter }` thrown immediately.
- **Why it matters for this project:** Groundtruth's Censorship Resistance claim is "anyone can read the data without our backend". That holds, but every reader's browser shares its IP's anonymous budget, so a public dashboard has to be frugal by design.
- **What we changed:**
  - `http(undefined, { retryCount: 0, timeout: 20_000 })` in the dashboard and probe, so errors surface instead of stalling.
  - The dashboard shows a banner with the reset time on `ANON_COST_LIMITED`.
  - The dashboard used to call `getEntity` for *every* `EntityCreated` event on the chain, including other apps' entities. It now ignores events whose `owner` is not a known probe wallet, and on our events runs one debounced incremental query (`ts >= newest ts we hold`).
  - Full reloads went from every 60 seconds to every 5 minutes.
- **Suggested fix:** Document the budget and per-query costs (the `Arkiv-Cost` and `Arkiv-Quota-Used-Percent` response headers exist but are not in the docs); have the SDK's default transport not wait on long `Retry-After` values and throw a typed error instead; consider a cheaper or exempt path for small, filtered queries so public read-only dashboards stay usable.

## 12. Uppercase letters in attribute names are rejected, but the error says they are allowed (reproduced)

- **Surface:** `executeBatch` / `createEntity` attribute names (SDK 0.8.1, Tiramisu)
- **Steps:** create an entity with an attribute named `latencyMs` (or `startedAt`).
- **Expected:** either it works (camelCase is the JavaScript default), or a clear "names must be lowercase" error before sending.
- **Actual:** the transaction is sent and fails with `Transaction failed: an attribute name holds "M" (0x4d) at byte 7, which is outside the name charset ("A"-"Z", "a"-"z", "0"-"9", ".", "-" and "_", with a letter first)`. The message lists `"A"-"Z"` as allowed while rejecting `M`.
- **Workaround:** renamed to `latency_ms` and `started_at`. The first real round then landed in tx `0x0af5a973aa40dc161c295148929f5c183611fcd2be5ca970079c8371cd3074af`.
- **Suggested fix:** validate names client-side in the SDK (it already validates creation flags), and make the error's charset match the rule the chain enforces.

## 13. The WebSocket feed can fail in the browser with no way to tell why (reproduced, high impact)

- **Surface:** `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`, `watchEntityEvents` over viem's `webSocket()` transport, headless Chrome
- **Steps:** during a recorded lab run, the dashboard's `watchEntityEvents` called `onError` right after load, while HTTP queries from the same page still succeeded. No further events arrived, although the probes kept writing on-chain. Afterwards, with the IP's query budget exhausted (entry 11), we sent three WebSocket upgrades from the same IP: two got `101 Switching Protocols`, one got `HTTP/1.1 429 Too Many Requests`.
- **Expected:** event subscriptions that stay up, or a documented limit and a typed close reason. They cost the node no `arkiv_query`, and for a read-only dashboard they are the cheap path.
- **Actual:** an untyped error and silence. We could not tell whether it was the anonymous budget, a connection-rate limit or something else.
- **Impact:** the dashboard kept counting down lease clocks on stale data and declared every region "silent: possible shutdown" while all probes were reporting: a false shutdown, the worst possible error for this app.
- **What we changed:** on `onError` the dashboard falls back to polling one incremental query every 30 seconds, and a lease is only treated as lapsed after a query made after its expiry confirms it (entry 2).
- **Suggested fix:** document WebSocket limits and whether they share the query budget; send a close frame with a reason (for example `RATE_LIMITED`, retry-after) instead of a bare 429 on upgrade; have the SDK resubscribe after reconnecting.

---

## Paths that worked first time

- Query builder: `and`, `or`, `eq`, `gte`, `createdBy`, `.limit(200)` and cursor pagination with `hasNextPage()` / `next()` compile and render as expected.
- Creation flags `{ readonly: true, permissionlessExtension: true }` are a single object on `createEntity`, and `encodeCreationFlags` rejects non-boolean values (read in `src/entity/flags.ts`).
- `ExpirationTime.fromSeconds(180)` for a short lease and `fromSeconds(48 * 3600)` for measurements: no unit confusion.
