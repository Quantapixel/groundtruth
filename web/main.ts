// Groundtruth dashboard. Reads Arkiv directly: there is no Groundtruth backend.

import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte, or, render } from "@arkiv-network/sdk/query"
import { type Hex, http, webSocket } from "viem"
import {
  type AggregateVerdict,
  aggregate,
  MEASUREMENT_SECONDS,
  PROJECT,
  type Verdict,
} from "../shared/schema.ts"

const EXPLORER = "https://tiramisu.explorer.arkiv.network"
const RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const BLOCK_TIME = 2
const WINDOW_SECONDS = 30 * 60

const client = createPublicClient({ chain: tiramisu, transport: http() })
// WebSocket transport, no fromBlock: a real subscription instead of HTTP polling.
const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket() })

type Measurement = {
  key: Hex
  creator: Hex
  expiresAt: bigint
  target: string
  asn: number
  isp: string
  region: string
  verdict: Verdict
  latencyMs: number
  ts: number
  lab: number
}
type Probe = { key: Hex; creator: Hex; expiresAt: bigint; asn: number; isp: string; region: string; lab: number }
type ProbeInfo = Omit<Probe, "key" | "expiresAt"> & { lease?: Probe }

const state = {
  measurements: new Map<Hex, Measurement>(),
  evidence: new Map<Hex, Measurement>(),
  leases: new Map<string, Probe>(), // by creator (lowercase)
  head: { block: 0n, at: 0 },
  showLab: true,
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// ---------- reading Arkiv ----------

const SELECT = { key: true, creator: true, expiresAt: true, attributes: true } as const

function flat(attrs: Record<string, { value: unknown }> | undefined): Record<string, any> {
  return Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, v.value]))
}

function toMeasurement(e: { key?: Hex; creator?: Hex; expiresAt?: bigint; attributes?: any }): Measurement {
  const a = flat(e.attributes)
  return { key: e.key!, creator: e.creator!, expiresAt: e.expiresAt ?? 0n, ...a } as Measurement
}

function toProbe(e: { key?: Hex; creator?: Hex; expiresAt?: bigint; attributes?: any }): Probe {
  const a = flat(e.attributes)
  return { key: e.key!, creator: e.creator!, expiresAt: e.expiresAt ?? 0n, ...a } as Probe
}

const currentQuery = (since: number) =>
  and(eq("project", PROJECT), eq("kind", "measurement"), gte("ts", since))
const evidenceQuery = () =>
  and(eq("project", PROJECT), eq("kind", "measurement"), or(eq("verdict", "dns_tampered"), eq("verdict", "block_page")))
const probeQuery = () => and(eq("project", PROJECT), eq("kind", "probe"))

async function fetchAll(where: ReturnType<typeof and>) {
  const out = []
  let page = await client.select(SELECT).where(where).limit(200).fetch()
  out.push(...page.entities)
  while (page.hasNextPage()) {
    page = await page.next()
    out.push(...page.entities)
  }
  return out
}

async function loadAll() {
  const since = Math.floor(Date.now() / 1000) - WINDOW_SECONDS
  const [current, evidence, probes, head] = await Promise.all([
    fetchAll(currentQuery(since)),
    fetchAll(evidenceQuery()),
    fetchAll(probeQuery()),
    client.getBlockNumber(),
  ])
  state.head = { block: head, at: Date.now() }
  state.measurements = new Map(current.map((e) => [e.key!, toMeasurement(e)]))
  state.evidence = new Map(evidence.map((e) => [e.key!, toMeasurement(e)]))
  state.leases = new Map(probes.map((e) => [e.creator!.toLowerCase(), toProbe(e)]))
  renderAll()
}

function headNow(): bigint {
  return state.head.block + BigInt(Math.floor((Date.now() - state.head.at) / 1000 / BLOCK_TIME))
}

function secondsLeft(expiresAt: bigint): number {
  return Number(expiresAt - headNow()) * BLOCK_TIME
}

// ---------- live updates ----------

function watch() {
  const status = $("ws-status")
  wsClient.watchEntityEvents({
    onEntityCreated: async (ev) => {
      status.textContent = "● live"
      status.className = "pill live"
      const e = await client.getEntity(ev.entityKey).catch(() => undefined)
      if (!e) return
      const a = flat(e.attributes as any)
      if (a.project !== PROJECT) return
      if (a.kind === "measurement") {
        const m = toMeasurement(e as any)
        state.measurements.set(m.key, m)
        if (m.verdict === "dns_tampered" || m.verdict === "block_page") state.evidence.set(m.key, m)
        feed(`${label(m)} measured <b>${esc(m.target)}</b>: <span class="pill ${verdictClass(m.verdict)}">${m.verdict}</span>`, m.key)
      } else if (a.kind === "probe") {
        const p = toProbe(e as any)
        state.leases.set(p.creator.toLowerCase(), p)
        feed(`${label(p)} came online (lease created)`, p.key)
      }
      scheduleRender()
    },
    onExpiryExtended: (ev) => {
      for (const p of state.leases.values()) {
        if (p.key === ev.entityKey) {
          p.expiresAt = ev.expiresAt
          feed(`${label(p)} renewed its lease`, p.key)
        }
      }
      for (const map of [state.measurements, state.evidence]) {
        const m = map.get(ev.entityKey)
        if (m && ev.expiresAt > m.expiresAt) {
          m.expiresAt = ev.expiresAt
          if (map === state.evidence) feed(`Evidence for <b>${esc(m.target)}</b> on ${label(m)} was corroborated by another network`, m.key)
        }
      }
      scheduleRender()
    },
    onError: (err) => {
      status.textContent = "live feed error"
      status.className = "pill err"
      console.error(err)
    },
  })
  status.textContent = "● live"
  status.className = "pill live"
}

// Arkiv emits no event when an entity expires, so lease lapses are detected on a timer.
function checkLeases() {
  for (const [creator, p] of state.leases) {
    if (secondsLeft(p.expiresAt) <= 0) {
      state.leases.delete(creator)
      feed(`${label(p)} lease expired: <b>network dark</b>`, p.key)
    }
  }
}

// ---------- rendering ----------

let renderQueued = false
function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    renderAll()
  })
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`
const labTag = (lab: number) => (lab ? `<span class="lab">LAB</span>` : "")
const label = (p: { isp: string; asn: number; lab: number }) => `${esc(p.isp)} (AS${p.asn})${labTag(p.lab)}`
const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}
const verdictClass = (v: Verdict | AggregateVerdict | "dark") =>
  ({
    ok: "v-ok",
    dns_tampered: "v-blocked",
    block_page: "v-blocked",
    blocked: "v-blocked",
    unreachable: "v-down",
    http_error: "v-down",
    down: "v-down",
    partial: "v-partial",
    slow: "v-slow",
    dark: "v-dark",
    unknown: "v-unknown",
  })[v]
const AGG_LABEL: Record<AggregateVerdict, string> = {
  ok: "Reachable",
  blocked: "Blocked",
  down: "Down everywhere",
  partial: "Unreachable on some networks",
  slow: "Slow on one network",
  unknown: "No live probes",
}

function visible<T extends { lab: number }>(xs: Iterable<T>): T[] {
  return [...xs].filter((x) => state.showLab || !x.lab)
}

// Every probe seen recently, live or not. A probe with measurements but no lease is dark.
function probes(): ProbeInfo[] {
  const byCreator = new Map<string, ProbeInfo>()
  for (const m of visible(state.measurements.values())) {
    const c = m.creator.toLowerCase()
    if (!byCreator.has(c)) byCreator.set(c, { creator: m.creator, asn: m.asn, isp: m.isp, region: m.region, lab: m.lab })
  }
  for (const [c, p] of state.leases) {
    if (!state.showLab && p.lab) continue
    byCreator.set(c, { creator: p.creator, asn: p.asn, isp: p.isp, region: p.region, lab: p.lab, lease: p })
  }
  return [...byCreator.values()].sort((a, b) => a.region.localeCompare(b.region) || a.isp.localeCompare(b.isp))
}

function renderAll() {
  const ps = probes()
  renderRegions(ps)
  renderGrid(ps)
  renderEvidence()
  $("head").textContent = state.head.block ? `block ${headNow()}` : ""
}

function renderRegions(ps: ProbeInfo[]) {
  const regions = new Map<string, ProbeInfo[]>()
  for (const p of ps) regions.set(p.region, [...(regions.get(p.region) ?? []), p])
  const live = ps.filter((p) => p.lease).length
  $("probe-count").textContent = `${live} live / ${ps.length} seen`
  $("regions").innerHTML =
    [...regions]
      .map(([region, list]) => {
        const dark = list.every((p) => !p.lease)
        const rows = list
          .map((p) => {
            const st = p.lease
              ? `<span class="muted">lease ${Math.max(0, secondsLeft(p.lease.expiresAt))}s</span>`
              : `<span class="pill v-dark">dark</span>`
            return `<div class="probe"><span>${label(p)} <a class="mono" href="${EXPLORER}/address/${p.creator}" target="_blank" rel="noopener">${short(p.creator)}</a></span>${st}</div>`
          })
          .join("")
        const badge = dark ? `<span class="pill v-dark">DARK: suspected shutdown</span>` : `<span class="pill v-ok">online</span>`
        return `<div class="region ${dark ? "dark" : ""}"><h3><span>${esc(region)}</span>${badge}</h3>${rows}</div>`
      })
      .join("") || `<p class="muted">No probes have reported in the last 30 minutes.</p>`
}

function latestByTargetAndProbe(): Map<string, Map<string, Measurement>> {
  const out = new Map<string, Map<string, Measurement>>()
  for (const m of visible(state.measurements.values())) {
    const row = out.get(m.target) ?? new Map<string, Measurement>()
    const c = m.creator.toLowerCase()
    const prev = row.get(c)
    if (!prev || m.ts > prev.ts) row.set(c, m)
    out.set(m.target, row)
  }
  return out
}

function renderGrid(ps: ProbeInfo[]) {
  const latest = latestByTargetAndProbe()
  const grid = $("grid")
  $("empty").textContent = latest.size ? "" : "No measurements in the last 30 minutes."
  if (!latest.size) {
    grid.innerHTML = ""
    return
  }
  const head = `<tr><th>Target</th><th>Verdict</th>${ps
    .map((p) => `<th>${label(p)}<br><span class="muted small">${esc(p.region)}${p.lease ? "" : " · dark"}</span></th>`)
    .join("")}</tr>`
  const rows = [...latest.keys()].sort().map((target) => {
    const row = latest.get(target)!
    // Only live probes vote: a dark network's last result is stale.
    const liveObs = ps
      .filter((p) => p.lease && row.has(p.creator.toLowerCase()))
      .map((p) => row.get(p.creator.toLowerCase())!)
      .map((m) => ({ probe: m.creator, verdict: m.verdict, latencyMs: m.latencyMs, ts: m.ts }))
    const agg = aggregate(liveObs)
    const where =
      agg === "blocked"
        ? ` <span class="small">on ${ps
            .filter((p) => p.lease && ["dns_tampered", "block_page"].includes(row.get(p.creator.toLowerCase())?.verdict ?? ""))
            .map((p) => esc(p.isp))
            .join(", ")}</span>`
        : ""
    const cells = ps
      .map((p) => {
        const m = row.get(p.creator.toLowerCase())
        if (!m) return `<td class="muted">–</td>`
        return `<td class="cell ${p.lease ? "" : "stale"}" data-key="${m.key}"><span class="pill ${verdictClass(m.verdict)}">${m.verdict}</span><br><span class="muted small">${m.latencyMs} ms · ${ago(m.ts)}</span></td>`
      })
      .join("")
    return `<tr><td class="target">${esc(target)}</td><td><span class="pill ${verdictClass(agg)}">${AGG_LABEL[agg]}</span>${where}</td>${cells}</tr>`
  })
  grid.innerHTML = head + rows.join("")
}

function renderEvidence() {
  const list = visible(state.evidence.values()).sort((a, b) => b.ts - a.ts)
  $("evidence").innerHTML = list.length
    ? `<tr><th>When</th><th>Target</th><th>Network</th><th>Region</th><th>Result</th><th>Kept until</th><th>Entity</th></tr>` +
      list
        .map((m) => {
          const left = secondsLeft(m.expiresAt)
          const naturalLeft = MEASUREMENT_SECONDS - (Date.now() / 1000 - m.ts)
          const corroborated = left > naturalLeft + 3600
          const keep = left > 0 ? `${Math.round(left / 3600)}h${corroborated ? ` <span class="pill v-ok">corroborated</span>` : ""}` : "expired"
          return `<tr><td>${new Date(m.ts * 1000).toLocaleString()}</td><td class="target">${esc(m.target)}</td><td>${label(m)}</td><td>${esc(m.region)}</td><td><span class="pill ${verdictClass(m.verdict)}">${m.verdict}</span></td><td>${keep}</td><td class="cell" data-key="${m.key}"><span class="mono">${short(m.key)}</span></td></tr>`
        })
        .join("")
    : `<tr><td class="muted">No interference recorded.</td></tr>`
}

function feed(html: string, key?: Hex) {
  const li = document.createElement("li")
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time>${html}${key ? ` <a class="mono small" href="${EXPLORER}/entity/${key}" target="_blank" rel="noopener">${short(key)}</a>` : ""}`
  const ol = $("feed")
  ol.prepend(li)
  while (ol.children.length > 100) ol.lastChild?.remove()
}

async function showDetail(key: Hex) {
  const dlg = $<HTMLDialogElement>("detail")
  const body = $("detail-body")
  body.innerHTML = `<p class="muted">Loading ${short(key)} from Arkiv…</p>`
  dlg.showModal()
  const e = await client.getEntity(key)
  const a = flat(e.attributes as any)
  let payload = ""
  try {
    payload = JSON.stringify(e.toJson(), null, 2)
  } catch {
    payload = "(no payload)"
  }
  const flags = e.creationFlags
  body.innerHTML = `
    <h2>${esc(a.target ?? a.kind)} · <span class="pill ${verdictClass(a.verdict)}">${esc(a.verdict ?? "")}</span></h2>
    <dl>
      <dt>Entity</dt><dd><a class="mono" href="${EXPLORER}/entity/${key}" target="_blank" rel="noopener">${key}</a></dd>
      <dt>Creator</dt><dd><a class="mono" href="${EXPLORER}/address/${e.creator}" target="_blank" rel="noopener">${e.creator}</a> <span class="muted">(immutable: the probe that measured it)</span></dd>
      <dt>Network</dt><dd>${label(a as any)} · ${esc(a.region)}</dd>
      <dt>Measured</dt><dd>${new Date(a.ts * 1000).toLocaleString()} · ${a.latencyMs} ms</dd>
      <dt>Expires</dt><dd>block ${e.expiresAt} (~${Math.round(secondsLeft(e.expiresAt ?? 0n) / 3600)}h from now)</dd>
      <dt>Flags</dt><dd>${flags?.readonly ? "read-only (cannot be edited, even by its creator)" : "editable"} · ${flags?.permissionlessExtension ? "anyone can extend its life" : "owner-only extension"}</dd>
    </dl>
    <h3>Evidence (payload)</h3>
    <pre><code>${esc(payload)}</code></pre>`
}

function renderVerify() {
  // The exact query string the SDK sends, with the time bound filled in by the shell.
  const q = render(currentQuery(0)).replace("i32(0)", "i32($SINCE)")
  $("curl").textContent = `SINCE=$(($(date +%s) - 1800))
curl -s ${RPC} -H 'content-type: application/json' -d "{
  \\"jsonrpc\\": \\"2.0\\", \\"id\\": 1, \\"method\\": \\"arkiv_query\\",
  \\"params\\": [\\"${q}\\",
    {\\"select\\": {\\"key\\": true, \\"creator\\": true, \\"attributes\\": true}, \\"limit\\": \\"0xc8\\"}]
}"`
  $("sdk").textContent = `import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { and, eq, gte } from "@arkiv-network/sdk/query"
import { http } from "viem"

const client = createPublicClient({ chain: tiramisu, transport: http() })
const since = Math.floor(Date.now() / 1000) - 1800
const page = await client
  .select({ key: true, creator: true, attributes: true })
  .where(and(eq("project", "${PROJECT}"), eq("kind", "measurement"), gte("ts", since)))
  .limit(200)
  .fetch()
console.log(page.entities)`
}

// ---------- wiring ----------

$("grid").addEventListener("click", onCellClick)
$("evidence").addEventListener("click", onCellClick)
function onCellClick(ev: Event) {
  const key = (ev.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key
  if (key) showDetail(key as Hex)
}
$<HTMLInputElement>("show-lab").addEventListener("change", (ev) => {
  state.showLab = (ev.target as HTMLInputElement).checked
  renderAll()
})

renderVerify()
await loadAll().catch((e) => {
  $("empty").textContent = `Could not reach Arkiv: ${e.message}`
})
watch()
setInterval(() => {
  checkLeases()
  renderAll()
}, 5000)
// Periodic full reload drops measurements that left the 30-minute window and re-syncs the head.
setInterval(() => loadAll().catch(console.error), 60_000)
