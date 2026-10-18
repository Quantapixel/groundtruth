// Groundtruth data contract. Shared by the probe (writes) and the dashboard (reads).
// Anyone can build on this: every entity is public on Arkiv Tiramisu.

export const PROJECT = "groundtruth"
export const SCHEMA_VERSION = 1

// Entity lifetimes (seconds). See arkiv/schema.md for the reasoning.
export const PROBE_LEASE_SECONDS = 180 // probe heartbeat: lapses 3 min after the last round
export const MEASUREMENT_SECONDS = 48 * 3600 // live map shows current conditions only
export const CORROBORATED_SECONDS = 7 * 24 * 3600 // evidence confirmed by another network lives longer

export type Verdict = "ok" | "dns_tampered" | "block_page" | "unreachable" | "http_error"

export const BLOCKING_VERDICTS: Verdict[] = ["dns_tampered", "block_page"]

// Attributes on a `probe` entity (the heartbeat lease).
export type ProbeAttrs = {
  project: string
  kind: "probe"
  v: number
  asn: number
  isp: string
  region: string
  lab: number // 1 = lab probe with a documentation-range ASN, 0 = real network
  startedAt: number
}

// Attributes on a `measurement` entity.
export type MeasurementAttrs = {
  project: string
  kind: "measurement"
  v: number
  target: string
  asn: number
  isp: string
  region: string
  verdict: Verdict
  ok: number // 1 if reachable with no interference, else 0
  latencyMs: number
  ts: number // unix seconds
  lab: number
}

// Evidence stored in the measurement payload. Never queried; read for detail views.
export type Evidence = {
  url: string
  systemDns: string[] | { error: string }
  controlDns: string[] | { error: string }
  http: { status?: number; finalUrl?: string; error?: string; fingerprint?: string }
  probeVersion: string
}

export type AggregateVerdict = "ok" | "blocked" | "down" | "partial" | "slow" | "unknown"

export type Observation = { probe: string; verdict: Verdict; latencyMs: number; ts: number }

// Combine the latest observation from each probe for one target into a single verdict.
// Blocked: an interference signature (tampered DNS or a block page) on some network.
// Down: unreachable from every network that reported.
// Partial: unreachable from some networks but fine from others, without a block signature.
// Slow: reachable everywhere, but one network is far slower than the rest.
export function aggregate(obs: Observation[]): AggregateVerdict {
  if (obs.length === 0) return "unknown"
  if (obs.some((o) => BLOCKING_VERDICTS.includes(o.verdict))) return "blocked"
  const failing = obs.filter((o) => o.verdict !== "ok")
  if (failing.length === obs.length) return "down"
  if (failing.length > 0) return "partial"
  if (obs.length >= 2) {
    const lat = obs.map((o) => o.latencyMs).sort((a, b) => a - b)
    const slowest = lat.pop() as number
    const median = lat[Math.floor(lat.length / 2)]
    if (slowest > Math.max(3 * median, median + 1500)) return "slow"
  }
  return "ok"
}
