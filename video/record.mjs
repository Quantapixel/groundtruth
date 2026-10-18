// Records the Groundtruth demo video from a real lab run.
//
//   node video/record.mjs          # full run: starts the lab, writes to Arkiv, films the dashboard (~9 min)
//   node video/record.mjs --dry    # pipeline test: no lab, no chain writes
//
// Output: video/out/groundtruth-demo.mp4 (1920x1080, H.264, captions burned in, no audio).
// Every result on screen comes from the live run; time-lapsed parts are labelled as sped up.

import { execSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const OUT = path.join(ROOT, "video/out")
const FRAMES = path.join(OUT, "frames")
const DRY = process.argv.includes("--dry")
const VIEW = { width: 1120, height: 630, deviceScaleFactor: 1920 / 1120 }
const DASH = "http://localhost:4173/"
const EXPLORER = "https://tiramisu.explorer.arkiv.network"
const RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const STAGE = `file://${path.join(ROOT, "video/stage.html")}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
const log = (m) => console.log(`[video ${new Date().toISOString().slice(11, 19)}] ${m}`)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })

// ---------- processes ----------

const children = []
function bg(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], ...opts })
  children.push(p)
  return p
}
function cleanup() {
  for (const p of children) {
    try {
      p.kill()
    } catch {}
  }
}
process.on("exit", cleanup)
process.on("SIGINT", () => process.exit(1))

log("building dashboard")
execSync("npm run build", { cwd: ROOT, stdio: "ignore" })
bg("npx", ["vite", "preview", "web", "--port", "4173", "--strictPort"])
const chrome = bg("google-chrome", [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--hide-scrollbars",
  "--remote-debugging-port=9334",
  `--user-data-dir=${path.join(OUT, "chrome-profile")}`,
  "about:blank",
])

// Lab output, kept with timestamps so the terminal scene replays what really happened.
const labLines = []
let lab
if (!DRY) {
  log("starting lab")
  lab = bg(process.execPath, ["lab/run.ts"])
  const onData = (d) =>
    d
      .toString()
      .split("\n")
      .filter((l) => l.trim() && !l.includes("ExperimentalWarning") && !l.includes("--trace-warnings"))
      .forEach((l) => {
        labLines.push(l)
        console.log(`  lab | ${l}`)
      })
  lab.stdout.on("data", onData)
  lab.stderr.on("data", onData)
}

async function waitFor(pred, timeoutMs, what) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await sleep(500)
  }
  log(`timed out waiting for ${what}`)
  return false
}
const countLines = (re) => labLines.filter((l) => re.test(l)).length

// ---------- browser ----------

async function until(url) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error(`not reachable: ${url}`)
}
await until("http://127.0.0.1:9334/json/version")
await until(DASH)

const tab = await (await fetch("http://127.0.0.1:9334/json/new?about:blank", { method: "PUT" })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
}
await new Promise((r) => (ws.onopen = r))
async function send(method, params = {}) {
  const d = await new Promise((r) => {
    const i = ++msgId
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  if (d.error) throw new Error(`${method}: ${d.error.message}`)
  return d.result
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  return r.result?.value
}
await send("Page.enable")
await send("Emulation.setDeviceMetricsOverride", { ...VIEW, mobile: false })

async function go(url, settleMs = 1500) {
  await send("Page.navigate", { url })
  await sleep(settleMs)
}

// Caption bar burned into every frame, in the dashboard's own colours.
async function caption(html, step) {
  await evaluate(`(() => {
    let el = document.getElementById("__cap")
    if (!el) {
      el = document.createElement("div")
      el.id = "__cap"
      Object.assign(el.style, {
        position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483647",
        padding: "12px 26px 14px", background: "rgba(16,40,74,0.95)", borderTop: "4px solid #f39c12",
        color: "#fff", font: "21px/1.45 Verdana, Geneva, sans-serif",
      })
      document.body.appendChild(el)
    }
    el.innerHTML = ${JSON.stringify(step ? `<b style="color:#ffd166">${step}</b>&nbsp;&nbsp;${html}` : html)}
    el.style.display = ${JSON.stringify(html ? "block" : "none")}
  })()`)
}

async function scrollTo(selector, offset = 10) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -${offset}) } })()`)
  await sleep(300)
}

// ---------- filming ----------

let frameNo = 0
const frames = []
// Films `seconds` of video. speed > 1 is a time-lapse: real time = seconds * speed.
async function film(seconds, { every = 0.2, speed = 1, stopWhen } = {}) {
  const start = Date.now()
  const realMs = seconds * speed * 1000
  while (Date.now() - start < realMs) {
    const t0 = Date.now()
    const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 })
    const file = path.join(FRAMES, `${String(frameNo++).padStart(6, "0")}.jpg`)
    fs.writeFileSync(file, Buffer.from(r.data, "base64"))
    await sleep(Math.max(0, every * speed * 1000 - (Date.now() - t0)))
    frames.push({ file, dur: (Date.now() - t0) / 1000 / speed })
    if (stopWhen && (await stopWhen())) break
  }
}

async function card(html, seconds, cap, step) {
  await go(STAGE, 600)
  await evaluate(`document.getElementById("stage").innerHTML = ${JSON.stringify(html)}`)
  await caption(cap ?? "", step)
  await film(seconds)
}

function colour(line) {
  return esc(line)
    .replace(/(0x[0-9a-fA-F]{8})[0-9a-fA-F]{40,}/g, "$1…")
    .replace(/(dns_tampered|block_page|-&gt; 0\.0\.0\.0)/g, '<span class="bad">$1</span>')
    .replace(/(:ok)\b/g, '<span class="ok">$1</span>')
    .replace(/(unreachable)/g, '<span class="hl">$1</span>')
    .replace(/(corroborated[^<]*)/g, '<span class="hl">$1</span>')
    .replace(/^(\[[a-z-]+\])/, '<span class="dim">$1</span>')
}

async function terminal(title, lines, seconds, cap, step) {
  await go(STAGE, 600)
  await evaluate(`document.getElementById("stage").innerHTML = ${JSON.stringify(
    `<div class="term"><div class="term-bar">${esc(title)}</div><pre id="t"></pre></div>`,
  )}`)
  await caption(cap, step)
  const per = Math.max(0.15, (seconds * 0.6) / Math.max(1, lines.length))
  for (const l of lines) {
    await evaluate(`document.getElementById("t").insertAdjacentHTML("beforeend", ${JSON.stringify(colour(l) + "\n")})`)
    await film(per)
  }
  await film(seconds * 0.4)
}

// ---------- the video ----------

const tag = (cls, t) => `<span class="tag ${cls}">${t}</span>`

await card(
  `<div class="card"><div class="bar"><h1>groundtruth</h1><p class="sub">Is that website down, blocked, or has the internet been switched off?</p></div>
   <div class="body"><p>A censorship and outage map that nobody can take down.</p>
   <p>${tag("", "Built on Arkiv")}${tag("", "Censorship Resistance")}${tag("", "Open Source")}</p></div></div>`,
  6,
)

await card(
  `<div class="card"><div class="bar"><h1 style="font-size:44px">The problem</h1></div><div class="body">
   <p>India orders internet shutdowns more often than almost any other country, and website-blocking orders are confidential.</p>
   <p>When a site won't load, people can't tell whether it is ${tag("orange", "down")}, ${tag("red", "blocked")} by their provider, or ${tag("grey", "switched off")}.</p>
   <p>And the trackers that document this run on servers that can be blocked too.</p></div></div>`,
  9,
)

if (!DRY) {
  log("waiting for the first round from all three probes")
  await waitFor(() => ["probe-a", "probe-b", "probe-c"].every((p) => labLines.some((l) => l.startsWith(`[${p}]`) && /round 1 /.test(l))), 180_000, "round 1")
}
const interesting = labLines.filter((l) => /sinkhole|lab site|probe 0x|round \d|corroborated/.test(l)).slice(0, 14)
await terminal(
  "npm run lab",
  interesting.length ? interesting : ["(dry run: no lab output)"],
  12,
  "Three probes on simulated providers. Lab ISPs A and B use a censoring resolver that answers 0.0.0.0 for torproject.org. Every round is one atomic Arkiv batch: the results plus the probe's “still here” signal.",
  "1/6",
)

await go(DASH, 7000)
await caption("This page has no backend. It reads the results straight from Arkiv, the Web3 database.", "2/6")
await scrollTo(".page", 0)
await film(5)
await scrollTo("#now")
await caption("Each row is a website, each column a provider. torproject.org is blocked on A and B and works on C, so it's censorship, not an outage.", "2/6")
await film(7)

const blockedKey = await evaluate(`(() => { const td = [...document.querySelectorAll("#grid td.cell")].find((t) => /blocked/.test(t.textContent)); if (td) { td.click(); return td.dataset.key } })()`)
await sleep(2500)
await caption("Click any result: the raw record on Arkiv. It is locked, so nobody can edit it, not even the probe that wrote it. The probe's DNS answer was 0.0.0.0; the control resolver returned the real address.", "2/6")
await film(8)
await evaluate(`document.getElementById("detail")?.close()`)

if (!DRY) {
  log("stopping the lab site")
  lab.stdin.write("s")
  const before = countLines(/lab-site:unreachable/)
  await waitFor(() => countLines(/lab-site:unreachable/) >= before + 3, 150_000, "lab-site unreachable from all probes")
  await sleep(6000)
}
await scrollTo("#now")
await caption("Now the lab site is switched off. Every provider fails to reach it, so it shows as down everywhere, not blocked.", "3/6")
await film(7)

if (!DRY) {
  log("stopping probe C")
  lab.stdin.write("c")
}
await scrollTo("#networks")
await caption("Probe C, the only probe in IN-LAB-SOUTH, stops reporting. Its “still here” entity on Arkiv is no longer renewed… <b style='color:#ffd166'>(sped up 15×)</b>", "4/6")
await film(DRY ? 4 : 14, {
  every: 0.4,
  speed: DRY ? 1 : 15,
  stopWhen: DRY ? undefined : () => evaluate(`!!document.querySelector(".region.dark")`),
})
await caption("…so it expires, and the region is marked silent: a possible shutdown. Nobody can fake that silence, because the signal lives on Arkiv, not on a server.", "4/6")
await film(6)

await scrollTo("#evidence-win")
const confirmed = await evaluate(`/confirmed by another provider/.test(document.getElementById("evidence")?.textContent ?? "")`)
await caption(
  confirmed
    ? "Evidence of blocking. A probe on a different provider saw the same block and extended this record from 48 hours to 7 days. Anyone can do that; nobody can edit it."
    : "Evidence of blocking: every DNS tampering or block-page result, locked on Arkiv and kept for 48 hours, or 7 days once another provider confirms it.",
  "5/6",
)
await film(7)

// Same query anyone can run, with no Groundtruth code.
const since = Math.floor(Date.now() / 1000) - 1800
const query = `project = str('groundtruth') AND kind = str('measurement') AND ts >= i32(${since})`
let summary = "(request failed)"
try {
  const res = await (
    await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [query, { select: { key: true, creator: true, attributes: true }, limit: "0xc8" }] }),
    })
  ).json()
  const data = res.result?.data ?? []
  const first = data.find((e) => JSON.stringify(e).includes("dns_tampered")) ?? data[0]
  summary = [`→ ${data.length} measurements in the last 30 minutes`, ...JSON.stringify(first ?? res, null, 1).split("\n").slice(0, 16)].join("\n")
} catch (e) {
  summary = String(e)
}
await terminal(
  "anyone, anywhere: no Groundtruth server needed",
  [`$ curl -s ${RPC} \\`, `    -d '{"method":"arkiv_query","params":["${query}", …]}'`, ...summary.split("\n")],
  9,
  "Don't trust our page? The same data comes straight from the Arkiv RPC with one command, or from the public explorer.",
  "6/6",
)

if (blockedKey) {
  await go(`${EXPLORER}/entity/${blockedKey}`, 6000)
  await caption("The same blocked result on the Tiramisu explorer: who wrote it, when, and in which transaction.", "6/6")
  await film(6)
}

await card(
  `<div class="card"><div class="bar"><h1>groundtruth</h1><p class="sub">down, blocked, or switched off?</p></div>
   <div class="body"><p><b>Live:</b> <span class="mono">quantapixel.github.io/groundtruth</span></p>
   <p><b>Code (MIT):</b> <span class="mono">github.com/Quantapixel/groundtruth</span></p>
   <p>Run a probe on your own network: <span class="mono">npm run probe</span></p></div></div>`,
  6,
)

// ---------- render ----------

if (!DRY) lab.stdin.write("q")
ws.close()
const list = frames.map((f) => `file '${f.file}'\nduration ${f.dur.toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`
fs.writeFileSync(path.join(OUT, "frames.txt"), list)
fs.writeFileSync(path.join(OUT, "lab.log"), labLines.join("\n"))
const total = frames.reduce((a, f) => a + f.dur, 0)
log(`rendering ${frames.length} frames, ${total.toFixed(1)} s`)
const mp4 = path.join(OUT, DRY ? "groundtruth-demo-DRY.mp4" : "groundtruth-demo.mp4")
execSync(
  `ffmpeg -y -loglevel error -f concat -safe 0 -i "${path.join(OUT, "frames.txt")}" -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libopenh264 -b:v 8M "${mp4}"`,
  { stdio: "inherit" },
)
fs.rmSync(path.join(OUT, "chrome-profile"), { recursive: true, force: true })
log(`done: ${mp4}`)
process.exit(0)
