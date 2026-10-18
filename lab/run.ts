// Runs the whole lab: a censoring DNS resolver, a local site and three probes on simulated ISPs.
//
//   npm run lab
//
// Keys while running:
//   s  stop / start the lab site      -> "Down everywhere"
//   c  stop / start probe C (south)   -> region IN-LAB-SOUTH goes dark when its lease expires
//   q  quit
//
// Lab probes use RFC 5398 documentation ASNs and are written with lab = 1, so the dashboard can
// always tell them apart from real networks.

import { type ChildProcess, spawn } from "node:child_process"

const root = new URL("..", import.meta.url).pathname
const procs = new Map<string, ChildProcess>()

const PROBES: Record<string, string[]> = {
  a: ["--key-env", "PROBE_KEY_A", "--asn", "64500", "--isp", "Lab ISP A (censoring)", "--region", "IN-LAB-NORTH", "--resolver", "127.0.0.1:5533"],
  b: ["--key-env", "PROBE_KEY_B", "--asn", "64501", "--isp", "Lab ISP B", "--region", "IN-LAB-NORTH"],
  c: ["--key-env", "PROBE_KEY_C", "--asn", "64502", "--isp", "Lab ISP C", "--region", "IN-LAB-SOUTH"],
}

function start(name: string, args: string[]) {
  const p = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
  const prefix = `[${name}]`.padEnd(10)
  const out = (d: Buffer) => d.toString().split("\n").filter(Boolean).forEach((l) => console.log(prefix, l))
  p.stdout.on("data", out)
  p.stderr.on("data", (d: Buffer) => {
    if (!d.toString().includes("ExperimentalWarning")) out(d)
  })
  p.on("exit", () => procs.delete(name))
  procs.set(name, p)
}

function toggle(name: string, args: string[]) {
  const p = procs.get(name)
  if (p) {
    p.kill()
    console.log(`>>> stopped ${name}`)
  } else {
    start(name, args)
    console.log(`>>> started ${name}`)
  }
}

const siteArgs = ["lab/site.ts"]
const probeArgs = (k: string) => ["probe/probe.ts", "--lab", "--targets", "probe/lab-targets.json", "--interval", "60", ...PROBES[k]]

start("sinkhole", ["lab/sinkhole.ts", "--block", "torproject.org"])
start("site", siteArgs)
for (const k of Object.keys(PROBES)) start(`probe-${k}`, probeArgs(k))

console.log("keys: s = toggle lab site, c = toggle probe C, q = quit")
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on("data", (d) => {
  const key = d.toString()
  if (key === "s") toggle("site", siteArgs)
  else if (key === "c") toggle("probe-c", probeArgs("c"))
  else if (key === "q" || key === "\u0003") {
    for (const p of procs.values()) p.kill()
    process.exit(0)
  }
})
