# Groundtruth

**Is it down, blocked, or switched off?** A censorship and outage map that nobody can take down, built on [Arkiv](https://arkiv.network), the Web3 database.

**Live dashboard:** https://quantapixel.github.io/groundtruth/ (a static page that reads Arkiv directly; no backend)

Built for the [Arkiv Global Tour Stop](https://arkiv.devfolio.co/overview), 9–18 October 2026. Tracks: Censorship Resistance, Open Source, Best Indian Use Case.

## The problem

India orders more internet shutdowns than almost any other country, and website blocking orders under Section 69A of the IT Act are confidential. When a site will not load, people cannot tell whether it is down, blocked by their ISP, or whether the network itself has been switched off. Governments and ISPs call blocks "technical glitches", and the trackers that document them run on servers and domains that can themselves be blocked or pressured into removing data.

## Why India

- **Who uses it:** journalists and digital-rights groups who track shutdowns and blocking in India, people in regions that face repeated shutdowns, and anyone on Jio, Airtel, BSNL or a local broadband provider asking "is this site down, or is my ISP blocking it?"
- **The problem today:** India has had some of the longest internet shutdowns anywhere, including Jammu and Kashmir from 2019 and Manipur in 2023, and website blocking orders under Section 69A are confidential. Evidence lives in news reports, screenshots and trackers run on servers that can themselves be blocked.
- **What changes for them:** a probe on an Indian network detects its own ISP's ASN automatically, so every result says *which* provider blocked *what*, *when*. A shutdown shows up as a region going silent. The record stays on Arkiv, where nobody can delete it, and the dashboard and a single curl command read it from anywhere.
- **It works today:** the probe runs on any laptop with Node.js (`npm run probe`), and the dashboard runs in any browser, including on a phone.

## What Groundtruth does

Volunteer probes on different networks test the same list of sites. Every result is written to Arkiv, and anyone can read it without Groundtruth's servers. Comparing networks separates censorship from outages:

| Verdict | What the probes see |
|---|---|
| 🔴 **Blocked** | DNS tampering or a government block page on some network, while the control resolver shows the site exists |
| 🟠 **Down everywhere** | Unreachable from every network that reported: a real outage |
| 🟡 **Unreachable on some networks** | Fails on some networks, works on others, with no block signature |
| 🟣 **Slow on one network** | Reachable everywhere, but one network is far slower than the rest |
| ⚫ **Dark** | Every probe in a region stopped reporting: a suspected shutdown |

**Dark is detected through Entity Expiration.** Each probe holds a heartbeat lease, an Arkiv entity that lives 3 minutes and is renewed in the same atomic batch as each round of measurements. When a region's probes go silent, their leases expire and the region goes dark on the map. The absence of data is the signal, and no server can fake it or hide it.

## How it uses Arkiv

| Feature | What it does in Groundtruth | Code |
|---|---|---|
| Typed attributes vs payload | Everything the dashboard filters on (`target`, `asn`, `region`, `verdict`, numeric `ts`, `latencyMs`) is an attribute; DNS/HTTP evidence is the JSON payload | [`shared/schema.ts`](shared/schema.ts), [`probe/probe.ts`](probe/probe.ts) |
| Range and compound queries | `ts >= now - 30 min` for the live view; `verdict = dns_tampered OR verdict = block_page` for the evidence list; cursor pagination | [`web/main.ts`](web/main.ts) |
| Entity Expiration per type | Lease 3 min (shutdown detection), measurement 48 h (the map shows only current conditions), corroborated evidence 7 days | [`arkiv/schema.md`](arkiv/schema.md) |
| Lifetime Extension | The lease is renewed only by a probe that reported; evidence is extended when another network confirms it | [`probe/probe.ts`](probe/probe.ts) |
| Creation flags | Measurements are `readonly` (not even the probe can edit evidence) and `permissionlessExtension` (other networks keep it alive) | [`probe/probe.ts`](probe/probe.ts) |
| Batch writes | One round = all measurements + the lease renewal, atomically | [`probe/probe.ts`](probe/probe.ts) |
| `$creator` | Every result is attributed to the probe wallet that created it; a probe can resume only its own lease (`createdBy`) | [`web/main.ts`](web/main.ts), [`probe/probe.ts`](probe/probe.ts) |
| WebSocket entity events | `watchEntityEvents` over a WebSocket transport, no `fromBlock`: results, lease renewals and corroborations appear live | [`web/main.ts`](web/main.ts) |

Full data contract: [`arkiv/schema.md`](arkiv/schema.md). Friction report: [`arkiv/friction.md`](arkiv/friction.md).

### What stays off Arkiv, on purpose

- The probe operator's IP address (only the ASN and a coarse region are published)
- Anything about who visits what: probes test a fixed public list, never users' browsing
- Full page bodies and packet captures
- Private keys (local `.env`, never committed)

### Why not OONI?

[OONI](https://ooni.org) is the reference for censorship measurement, and Groundtruth borrows its approach. But OONI's measurements flow through collectors and an explorer run by one organisation. Those can be blocked, or pressured to remove data. Groundtruth has no operator: probes write to Arkiv, and the dashboard and anyone else read it from the chain. Shutdown detection comes from expiring leases, which a central collector would have to fake.

## Run it

Requires Node.js 22.6 or later.

```bash
git clone https://github.com/Quantapixel/groundtruth && cd groundtruth
npm install
```

### Dashboard

```bash
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

### A real probe on your network

1. Create a key and fund it at https://hub.arkiv.network/faucet:
   ```bash
   node -e "console.log('PROBE_KEY=' + require('viem/accounts').generatePrivateKey())" >> .env
   ```
2. Run the probe. It detects your ISP's ASN and region (your IP is never published), tests [`probe/targets.json`](probe/targets.json) every 60 seconds and writes the results to Tiramisu:
   ```bash
   npm run probe
   ```

### The lab demo (simulated ISPs)

The lab runs a DNS sinkhole that behaves like a censoring ISP, a local test site and three probes. Lab probes use [RFC 5398](https://datatracker.ietf.org/doc/html/rfc5398) documentation ASNs (64500–64502) and are written with `lab = 1`, so they can never be mistaken for real networks. The dashboard labels them **LAB**.

```bash
# .env needs funded PROBE_KEY_A, PROBE_KEY_B, PROBE_KEY_C
npm run lab
```

| Probe | Network | Region | Resolver |
|---|---|---|---|
| A | Lab ISP A (censoring), AS64500 | IN-LAB-NORTH | sinkhole: `torproject.org` → `0.0.0.0` |
| B | Lab ISP B (censoring), AS64501 | IN-LAB-NORTH | sinkhole: `torproject.org` → `0.0.0.0` |
| C | Lab ISP C, AS64502 | IN-LAB-SOUTH | system |

While it runs:
- `torproject.org` shows **blocked** on Lab ISPs A and B and working on C. Because two networks saw the same block, each probe extends the other's evidence from 48 hours to 7 days.
- Press `s` to stop the lab site: it shows **Down everywhere**.
- Press `c` to stop probe C: after its 3-minute lease expires, **IN-LAB-SOUTH goes dark**.

## Verify it yourself, without our code

```bash
SINCE=$(($(date +%s) - 1800))
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d "{
  \"jsonrpc\": \"2.0\", \"id\": 1, \"method\": \"arkiv_query\",
  \"params\": [\"project = str('groundtruth') AND kind = str('measurement') AND ts >= i32($SINCE)\",
    {\"select\": {\"key\": true, \"creator\": true, \"attributes\": true}, \"limit\": \"0xc8\"}]
}"
```

Entities and their creation transactions are visible on the [Tiramisu explorer](https://tiramisu.explorer.arkiv.network) under the probe wallets below.

## Wallets that create Groundtruth entities (Tiramisu)

| Address | Role |
|---|---|
| [`0xC3c2cca0513ee2538Df4b1e2bd6529cE31abf920`](https://tiramisu.explorer.arkiv.network/address/0xC3c2cca0513ee2538Df4b1e2bd6529cE31abf920) | Probe A |
| [`0xa07B2FD6776C80D111065ed884dCEF378FFb6F9B`](https://tiramisu.explorer.arkiv.network/address/0xa07B2FD6776C80D111065ed884dCEF378FFb6F9B) | Probe B |
| [`0x6E4BDdE0b6e207A5D519f7f96FeBD02D2194Ffdc`](https://tiramisu.explorer.arkiv.network/address/0x6E4BDdE0b6e207A5D519f7f96FeBD02D2194Ffdc) | Probe C |

## Limitations

- **Self-reported networks.** A probe states its own ASN and region. Results are attributed to the immutable `$creator` wallet, and blocks confirmed by another network live longer, but a single dishonest probe can still report false results.
- **CDN false positives.** Sites behind CDNs resolve to different IPs on different networks. Groundtruth only calls DNS tampering when the local answer is empty or a bogon (such as `0.0.0.0`) while the control resolver returns public IPs, which avoids most of these but misses tampering that redirects to a real-looking IP.
- **Lab vs real.** The demo's blocking is simulated by the lab sinkhole and clearly labelled. Real probes measure real networks.

## Pre-existing work

None. Everything in this repository was written between 9 and 18 October 2026.

## License

[MIT](LICENSE)
