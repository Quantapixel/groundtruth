// Groundtruth probe: measures a list of targets from this network and writes the results to
// Arkiv, together with a heartbeat lease that lapses if the probe goes silent.
//
//   node probe/probe.ts --key-env PROBE_KEY_A            # real network, ASN auto-detected
//   node probe/probe.ts --key-env PROBE_KEY_B --lab --asn 64501 --isp "Lab ISP B" --region IN-LAB-B
//
// Private keys are read from an environment variable (or .env); they are never written anywhere.

import fs from "node:fs"
import { parseArgs } from "node:util"
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte } from "@arkiv-network/sdk/query"
import { type Hex, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  BLOCKING_VERDICTS,
  CORROBORATED_SECONDS,
  MEASUREMENT_SECONDS,
  type MeasurementAttrs,
  PROBE_LEASE_SECONDS,
  type ProbeAttrs,
  PROJECT,
  SCHEMA_VERSION,
} from "../shared/schema.ts"
import { makeResolver, measure, type Target } from "./measure.ts"

const BLOCK_TIME = 2

const { values: args } = parseArgs({
  options: {
    "key-env": { type: "string", default: "PROBE_KEY" },
    region: { type: "string" },
    asn: { type: "string" },
    isp: { type: "string" },
    lab: { type: "boolean", default: false },
    resolver: { type: "string" },
    targets: { type: "string", default: new URL("./targets.json", import.meta.url).pathname },
    interval: { type: "string", default: "60" },
    rounds: { type: "string", default: "0" },
  },
})

loadDotEnv()
const key = process.env[args["key-env"]!]
if (!key) fail(`Set ${args["key-env"]} (a funded Tiramisu private key) in the environment or .env`)

const account = privateKeyToAccount(key as Hex)
// No retries for reads: on a 429 viem would honour Retry-After and stall the probe for up to an hour.
const publicClient = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount: 0, timeout: 20_000 }) })
const wallet = createWalletClient({ chain: tiramisu, transport: http(), account })
const resolver = makeResolver(args.resolver)
const targets: Target[] = JSON.parse(fs.readFileSync(args.targets!, "utf8"))

const network = await detectNetwork()
log(`probe ${account.address}  AS${network.asn} ${network.isp}  region=${network.region}  lab=${network.lab}`)

const balance = await publicClient.getBalance({ address: account.address })
if (balance === 0n) fail(`${account.address} has no testnet GLM. Fund it at https://hub.arkiv.network/faucet`)

let leaseKey = await findLease()
const intervalMs = Number(args.interval) * 1000
const maxRounds = Number(args.rounds)

for (let round = 1; maxRounds === 0 || round <= maxRounds; round++) {
  const started = Date.now()
  try {
    await runRound(round)
  } catch (e) {
    log(`round ${round} failed: ${(e as Error).message}`)
  }
  if (maxRounds !== 0 && round === maxRounds) break
  await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - (Date.now() - started))))
}

async function runRound(round: number) {
  const results = await Promise.all(targets.map((t) => measure(t, resolver)))
  const ts = Math.floor(Date.now() / 1000)

  const creates = results.map((r) => ({
    payload: jsonToPayload(r.evidence),
    contentType: "application/json" as const,
    attributes: {
      project: PROJECT,
      kind: "measurement",
      v: SCHEMA_VERSION,
      target: r.target.id,
      asn: network.asn,
      isp: network.isp,
      region: network.region,
      verdict: r.verdict,
      ok: r.verdict === "ok" ? 1 : 0,
      latency_ms: Math.min(r.latencyMs, 2_000_000_000),
      ts,
      lab: network.lab,
    } satisfies MeasurementAttrs,
    expires: ExpirationTime.fromSeconds(MEASUREMENT_SECONDS),
    // Evidence: nobody, not even the probe, can edit it; anyone can keep it alive.
    flags: { readonly: true, permissionlessExtension: true },
  }))

  // The round and the heartbeat land atomically: a lease is only renewed by a probe that reported.
  const lease = leaseKey
    ? { extensions: [{ entityKey: leaseKey, expires: ExpirationTime.fromSeconds(PROBE_LEASE_SECONDS) }] }
    : { creates: [...creates, leaseCreate(ts)] }
  const batch = leaseKey ? { creates, ...lease } : lease
  const res = await wallet.executeBatch(batch)
  if (!leaseKey) leaseKey = res.createdEntities[res.createdEntities.length - 1]

  const summary = results.map((r) => `${r.target.id}:${r.verdict}`).join(" ")
  log(`round ${round}  tx ${res.txHash}  ${summary}`)

  // The round is already on-chain; a failed corroboration query must not be reported as a failed round.
  await corroborate(results.filter((r) => BLOCKING_VERDICTS.includes(r.verdict)).map((r) => [r.target.id, r.verdict])).catch((e) =>
    log(`corroboration skipped: ${(e as Error).message.split("\n")[0]}`),
  )
}

function leaseCreate(ts: number) {
  return {
    payload: jsonToPayload({ probeVersion: "0.1.0", targets: targets.map((t) => t.id) }),
    contentType: "application/json" as const,
    attributes: {
      project: PROJECT,
      kind: "probe",
      v: SCHEMA_VERSION,
      asn: network.asn,
      isp: network.isp,
      region: network.region,
      lab: network.lab,
      started_at: ts,
    } satisfies ProbeAttrs,
    expires: ExpirationTime.fromSeconds(PROBE_LEASE_SECONDS),
  }
}

// A live lease created by this wallet, if the probe restarted within its lease window.
async function findLease(): Promise<Hex | undefined> {
  const r = await publicClient
    .select({ key: true })
    .where(and(eq("project", PROJECT), eq("kind", "probe")))
    .createdBy(account.address)
    .limit(1)
    .fetch()
  return r.entities[0]?.key
}

// When another network saw the same interference in the last hour, extend that evidence to
// CORROBORATED_SECONDS. Uses the permissionlessExtension flag set at creation.
async function corroborate(found: [string, string][]) {
  if (found.length === 0) return
  const head = await publicClient.getBlockNumber()
  const keepUntil = head + BigInt(Math.floor((CORROBORATED_SECONDS * 0.9) / BLOCK_TIME))
  const since = Math.floor(Date.now() / 1000) - 3600
  const extensions = []
  for (const [target, verdict] of found) {
    const r = await publicClient
      .select({ key: true, creator: true, expiresAt: true, attributes: { asn: true } })
      .where(and(eq("project", PROJECT), eq("kind", "measurement"), eq("target", target), eq("verdict", verdict), gte("ts", since)))
      .limit(50)
      .fetch()
    for (const e of r.entities) {
      const otherNetwork = e.creator?.toLowerCase() !== account.address.toLowerCase() && e.attributes?.asn?.value !== network.asn
      if (otherNetwork && (e.expiresAt ?? 0n) < keepUntil) {
        extensions.push({ entityKey: e.key!, expires: ExpirationTime.fromSeconds(CORROBORATED_SECONDS) })
      }
    }
  }
  if (extensions.length === 0) return
  try {
    const res = await wallet.executeBatch({ extensions })
    log(`corroborated ${extensions.length} measurement(s) from other networks  tx ${res.txHash}`)
  } catch (e) {
    log(`corroboration skipped: ${(e as Error).message.split("\n")[0]}`)
  }
}

async function detectNetwork() {
  if (args.lab) {
    const asn = Number(args.asn)
    // RFC 5398 documentation ASNs: lab probes can never be mistaken for a real network.
    if (!(asn >= 64496 && asn <= 64511)) fail("--lab requires --asn in the documentation range 64496-64511")
    if (!args.isp || !args.region) fail("--lab requires --isp and --region")
    return { asn, isp: args.isp!, region: args.region!, lab: 1 }
  }
  let asn = Number(args.asn ?? 0)
  let isp = args.isp ?? ""
  let region = args.region ?? ""
  if (!asn || !isp || !region) {
    // Only the network (ASN) and a coarse region are published; the probe's IP is never stored.
    const info = (await (await fetch("https://ipinfo.io/json")).json()) as { org?: string; region?: string; country?: string }
    const m = /^AS(\d+)\s+(.*)$/.exec(info.org ?? "")
    asn ||= Number(m?.[1] ?? 0)
    isp ||= m?.[2] ?? "unknown"
    region ||= [info.country, info.region].filter(Boolean).join("-") || "unknown"
  }
  return { asn, isp, region, lab: 0 }
}

function loadDotEnv() {
  const path = new URL("../.env", import.meta.url)
  if (!fs.existsSync(path)) return
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}
