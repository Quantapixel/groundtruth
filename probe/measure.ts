// Network measurement for one target: system DNS vs a control resolver, then an HTTP fetch.
// No dependencies beyond Node's standard library.

import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import type { Evidence, Verdict } from "../shared/schema.ts"

export const PROBE_VERSION = "0.1.0"
const TIMEOUT_MS = 10_000
const MAX_BODY = 64 * 1024

// Phrases seen on government-ordered block pages served by Indian ISPs (and a few generic ones).
const BLOCK_PAGE_FINGERPRINTS = [
  "has been blocked as per",
  "blocked as per the instructions",
  "blocked under instructions of a competent government authority",
  "department of telecommunications",
  "ministry of electronics and information technology",
  "under the it act",
  "this website has been blocked",
  "access to this site has been blocked",
  "groundtruth-lab-block-page", // marker served by the lab block page
]

export type Target = { id: string; url: string; category: string }

export type Result = { target: Target; verdict: Verdict; latencyMs: number; evidence: Evidence }

type LookupFn = net.LookupFunction

function isBogon(ip: string): boolean {
  return (
    ip === "0.0.0.0" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
  )
}

// A resolver for the probe's "local network" DNS. Defaults to the OS resolver; --resolver points
// it at another server (the lab sinkhole uses this to behave like a censoring ISP).
export function makeResolver(server?: string) {
  if (!server) {
    const resolve = async (host: string) =>
      (await dns.promises.lookup(host, { all: true, family: 4 })).map((a) => a.address)
    return { resolve, lookup: undefined as LookupFn | undefined }
  }
  const r = new dns.promises.Resolver()
  r.setServers([server])
  const resolve = (host: string) => r.resolve4(host)
  const lookup: LookupFn = (host, opts, cb) => {
    resolve(host).then(
      (ips) => {
        if ((opts as dns.LookupOptions).all) cb(null, ips.map((address) => ({ address, family: 4 })))
        else cb(null, ips[0], 4)
      },
      (err) => cb(err, "", 4),
    )
  }
  return { resolve, lookup }
}

async function controlResolve(host: string): Promise<string[]> {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = (await res.json()) as { Answer?: { type: number; data: string }[] }
  return (json.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data)
}

type HttpOutcome = { status?: number; finalUrl?: string; error?: string; body?: string; ms: number }

function httpGet(url: string, lookup: LookupFn | undefined, redirects = 3): Promise<HttpOutcome> {
  const start = performance.now()
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === "https:" ? https : http
    const req = mod.get(
      u,
      { lookup, timeout: TIMEOUT_MS, headers: { "user-agent": `groundtruth-probe/${PROBE_VERSION}` } },
      (res) => {
        const loc = res.headers.location
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
          res.resume()
          httpGet(new URL(loc, u).toString(), lookup, redirects - 1).then((r) =>
            resolve({ ...r, ms: performance.now() - start }),
          )
          return
        }
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          if (body.length < MAX_BODY) body += chunk
          else res.destroy()
        })
        const done = () =>
          resolve({ status: res.statusCode, finalUrl: url, body, ms: performance.now() - start })
        res.on("end", done)
        res.on("close", done)
      },
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ error: e.code ?? e.message, ms: performance.now() - start }),
    )
  })
}

export async function measure(target: Target, resolver: ReturnType<typeof makeResolver>): Promise<Result> {
  const host = new URL(target.url).hostname
  const isIpLiteral = net.isIP(host) !== 0

  let systemDns: Evidence["systemDns"] = []
  let controlDns: Evidence["controlDns"] = []
  if (!isIpLiteral) {
    const [sys, ctl] = await Promise.allSettled([resolver.resolve(host), controlResolve(host)])
    systemDns = sys.status === "fulfilled" ? sys.value : { error: (sys.reason as NodeJS.ErrnoException).code ?? String(sys.reason) }
    controlDns = ctl.status === "fulfilled" ? ctl.value : { error: String(ctl.reason) }
  }

  const controlOk = Array.isArray(controlDns) && controlDns.length > 0
  const controlPublic = controlOk && (controlDns as string[]).some((ip) => !isBogon(ip))
  const systemFailed = !Array.isArray(systemDns) || systemDns.length === 0
  const systemBogon = Array.isArray(systemDns) && systemDns.length > 0 && systemDns.every(isBogon)
  const dnsTampered = !isIpLiteral && controlPublic && (systemFailed || systemBogon)

  const h = dnsTampered ? { ms: 0, error: "skipped: dns tampered" } as HttpOutcome : await httpGet(target.url, resolver.lookup)
  const lowerBody = (h.body ?? "").toLowerCase()
  const fingerprint = BLOCK_PAGE_FINGERPRINTS.find((f) => lowerBody.includes(f))

  let verdict: Verdict
  if (dnsTampered) verdict = "dns_tampered"
  else if (fingerprint) verdict = "block_page"
  else if (h.error) verdict = "unreachable"
  else if ((h.status ?? 0) >= 500) verdict = "http_error"
  else verdict = "ok"

  return {
    target,
    verdict,
    latencyMs: Math.round(h.ms),
    evidence: {
      url: target.url,
      systemDns,
      controlDns,
      http: { status: h.status, finalUrl: h.finalUrl, error: h.error, fingerprint },
      probeVersion: PROBE_VERSION,
    },
  }
}
