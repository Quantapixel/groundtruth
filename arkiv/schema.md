# Groundtruth data contract on Arkiv

Groundtruth writes two entity types to the Tiramisu testnet (chain ID `7738577`). Everything is public and queryable by anyone, without Groundtruth's code or servers. This file is the contract other teams can build on: the attribute names, types and meanings below are stable for `v = 1`.

All Groundtruth entities carry `project = "groundtruth"`, so every query starts with that filter.

## Entity types

### `measurement`: one probe's result for one target at one time

| Attribute | Type | Meaning |
|---|---|---|
| `project` | str | Always `groundtruth` |
| `kind` | str | Always `measurement` |
| `v` | i32 | Schema version, `1` |
| `target` | str | Target id, e.g. `wikipedia.org` (see `probe/targets.json`) |
| `asn` | i32 | Autonomous System Number of the probe's network (the ISP). Lab probes use documentation ASNs 64496–64511 |
| `isp` | str | Network name from the ASN registry, e.g. `Reliance Jio Infocomm Limited` |
| `region` | str | Coarse region, e.g. `IN-Punjab`. Never an address, city block or IP |
| `verdict` | str | `ok`, `dns_tampered`, `block_page`, `unreachable` or `http_error` (definitions below) |
| `ok` | i32 | `1` if `verdict = ok`, else `0`. Lets a query count failures with a numeric filter |
| `latency_ms` | i32 | Time to the HTTP response, in milliseconds (`0` when the request was skipped) |
| `ts` | i32 | Unix seconds when the round ran. Numeric so it supports range queries |
| `lab` | i32 | `1` for a lab probe (simulated ISP), `0` for a real network |

**Payload** (`application/json`, never queried): the evidence behind the verdict.

```json
{
  "url": "https://www.torproject.org/",
  "systemDns": ["0.0.0.0"],
  "controlDns": ["116.202.120.165", "..."],
  "http": { "error": "skipped: dns tampered" },
  "probeVersion": "0.1.0"
}
```

**Verdicts**

| Verdict | Rule |
|---|---|
| `dns_tampered` | The control resolver (Cloudflare DoH) returns public IPs, but the network's resolver returns nothing, an error, or only bogon addresses such as `0.0.0.0` |
| `block_page` | The HTTP response contains a known block-page phrase (government-order wording used by Indian ISPs) |
| `unreachable` | DNS looks fine but the connection fails, resets or times out |
| `http_error` | The server answered with a 5xx status |
| `ok` | The site answered and no interference was detected |

**Lifetime:** Entity Expiration 48 hours. **Creation flags:** `readonly` (nobody, including the probe that wrote it, can edit evidence) and `permissionlessExtension` (anyone can keep it alive).

**Lifetime Extension:** when a probe on a *different* network records the same `dns_tampered` or `block_page` verdict for the same target within an hour, it extends the other network's measurement to 7 days. Interference that two networks independently confirmed survives longer than a single report.

### `probe`: a probe's heartbeat lease

| Attribute | Type | Meaning |
|---|---|---|
| `project` | str | `groundtruth` |
| `kind` | str | `probe` |
| `v` | i32 | `1` |
| `asn` | i32 | Network ASN |
| `isp` | str | Network name |
| `region` | str | Coarse region |
| `lab` | i32 | `1` lab, `0` real |
| `started_at` | i32 | Unix seconds when the lease was created |

**Payload:** `{ "probeVersion": "0.1.0", "targets": [ ...target ids ] }`.

**Lifetime:** Entity Expiration 180 seconds. Each round, the probe renews it with `extendEntity` **in the same atomic batch** as that round's measurements, so a lease is only ever renewed by a probe that actually reported. When every probe in a region stops reporting, their leases expire and the dashboard shows the region as **dark**: a suspected shutdown. The absence of data is the signal.

## Why these lifetimes

| Type | Lifetime | Product reason |
|---|---|---|
| `probe` | 3 min, renewed each round | Shutdown detection. Too long and a shutdown shows late; too short and a slow round looks like an outage |
| `measurement` | 48 h | The live map shows current conditions. Stale "blocked" reports should disappear on their own, not need a cleanup job |
| corroborated `measurement` | 7 days | Interference independently seen on two networks is worth keeping as evidence |

## Trust

The dashboard groups and attributes every result by the entity's **`$creator`**, the wallet that created it, which is immutable. Network fields such as `isp` are self-reported, so the creator address is what identifies a probe. A probe cannot write results under another probe's identity.

## Queries the app runs

```ts
import { and, eq, gte, or } from "@arkiv-network/sdk/query"

// 1. Dashboard, "right now": every measurement in the last 30 minutes (cursor-paginated, 200 per page)
client.select({ key: true, creator: true, expiresAt: true, attributes: true })
  .where(and(eq("project", "groundtruth"), eq("kind", "measurement"), gte("ts", now - 1800)))
  .limit(200).fetch()   // then page.next() while page.hasNextPage()

// 2. Dashboard, interference evidence: compound OR on the verdict, no time bound (expiry bounds it)
  .where(and(eq("project", "groundtruth"), eq("kind", "measurement"),
             or(eq("verdict", "dns_tampered"), eq("verdict", "block_page"))))

// 3. Dashboard, live probes: whatever leases have not expired
  .where(and(eq("project", "groundtruth"), eq("kind", "probe")))

// 4. Probe start-up: resume its own lease if it restarted within the lease window
  .where(and(eq("project", "groundtruth"), eq("kind", "probe"))).createdBy(probeAddress)

// 5. Probe corroboration: the same interference seen recently on other networks
  .where(and(eq("project", "groundtruth"), eq("kind", "measurement"),
             eq("target", t), eq("verdict", v), gte("ts", now - 3600)))
```

The same query over raw JSON-RPC, with no SDK:

```bash
SINCE=$(($(date +%s) - 1800))
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d "{
  \"jsonrpc\": \"2.0\", \"id\": 1, \"method\": \"arkiv_query\",
  \"params\": [\"project = str('groundtruth') AND kind = str('measurement') AND ts >= i32($SINCE)\",
    {\"select\": {\"key\": true, \"creator\": true, \"attributes\": true}, \"limit\": \"0xc8\"}]
}"
```

The dashboard also subscribes to `watchEntityEvents` over a WebSocket transport (no `fromBlock`), so new measurements, lease renewals and corroborations appear without a refresh.

## What stays off Arkiv, on purpose

- The probe operator's IP address. The probe looks up its ASN and coarse region, then publishes only those.
- Anything about who visited what. Probes test a fixed public list of sites, not users' browsing.
- Raw packet captures and full page bodies. Only the verdict, timings and short DNS/HTTP evidence go on-chain.
- Private keys. They live in a local `.env` file that is never committed.
