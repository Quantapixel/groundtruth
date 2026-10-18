// Records the Groundtruth demo video from a real lab run, timed to the narration.
//
//   python video/narrate.py <kokoro_dir> video/out/narration      # voice, sound bed, timeline
//   node video/record.mjs                                          # full run (~10 min, writes to Arkiv)
//   node video/record.mjs --dry                                    # pipeline test, no lab, no writes
//
// Output: video/out/groundtruth-demo.mp4 (1920x1080 H.264 + AAC, subtitles burned in).
// Everything on screen comes from the live run. The one time-lapse is labelled on screen.

import { execSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const OUT = path.join(ROOT, "video/out")
const NARR = path.join(OUT, "narration")
const FRAMES = path.join(OUT, "frames")
const DRY = process.argv.includes("--dry")
const VIEW = { width: 1120, height: 630, deviceScaleFactor: 1920 / 1120 }
const DASH = "http://localhost:4173/"
const TERM_LINES = 14 // must match narrate.py, which places a typing click under each line
const EXPLORER = "https://tiramisu.explorer.arkiv.network"
const RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const STAGE = `file://${path.join(ROOT, "video/stage.html")}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
const log = (m) => console.log(`[video ${new Date().toISOString().slice(11, 19)}] ${m}`)

const TL = JSON.parse(fs.readFileSync(path.join(NARR, "timeline.json"), "utf8"))
fs.rmSync(FRAMES, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })

// ---------- processes ----------

const children = []
function bg(cmd, args) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] })
  children.push(p)
  return p
}
process.on("exit", () => children.forEach((p) => p.kill()))
process.on("SIGINT", () => process.exit(1))

log("building dashboard")
execSync("npm run build", { cwd: ROOT, stdio: "ignore" })
bg("npx", ["vite", "preview", "web", "--port", "4173", "--strictPort"])
bg("google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--remote-debugging-port=9334", `--user-data-dir=${path.join(OUT, "chrome-profile")}`, "about:blank",
])

const labLines = []
let lab
if (!DRY) {
  log("starting lab")
  lab = bg(process.execPath, ["lab/run.ts"])
  const onData = (d) =>
    d.toString().split("\n")
      .filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l))
      .forEach((l) => {
        labLines.push(l)
        console.log(`  lab | ${l}`)
      })
  lab.stdout.on("data", onData)
  lab.stderr.on("data", onData)
  // A real probe on this machine's own network, next to the simulated lab ISPs.
  log("starting real-network probe")
  const real = bg(process.execPath, ["probe/probe.ts", "--key-env", "PROBE_KEY"])
  const onReal = (d) => onData(Buffer.from(d.toString().split("\n").filter((l) => l.trim()).map((l) => `[real]     ${l}`).join("\n")))
  real.stdout.on("data", onReal)
  real.stderr.on("data", onReal)
}
const countLines = (re) => labLines.filter((l) => re.test(l)).length
async function waitFor(pred, timeoutMs, what) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true
    await sleep(500)
  }
  log(`timed out waiting for ${what}`)
  return false
}

// ---------- browser ----------

async function reachable(url) {
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
await reachable("http://127.0.0.1:9334/json/version")
await reachable(DASH)

const tab = await (await fetch("http://127.0.0.1:9334/json/new?about:blank", { method: "PUT" })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
let castFrames = null
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  } else if (d.method === "Page.screencastFrame") {
    castFrames?.push({ data: d.params.data, at: Date.now() / 1000 })
    ws.send(JSON.stringify({ id: ++msgId, method: "Page.screencastFrameAck", params: { sessionId: d.params.sessionId } }))
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

// CRT look on every page: scanlines, vignette, flicker; a dark monitor bezel around web pages.
async function crt(bezel) {
  await evaluate(`(() => {
    document.getElementById("__crt")?.remove()
    const s = document.createElement("style")
    s.textContent = \`
      #__crt { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
      #__crt .scan { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, rgb(0 0 0 / 0.16) 0 1px, transparent 1px 3px); animation: __flick 4s infinite; }
      #__crt .vig { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 58%, rgb(0 0 0 / 0.7) 100%); }
      #__crt .bez { position: absolute; inset: 16px; border-radius: 26px; box-shadow: 0 0 0 40px #030403, inset 0 0 70px rgb(0 0 0 / 0.75), inset 0 0 0 2px rgb(120 255 120 / 0.10); }
      #__crt .chap { position: absolute; top: 30px; left: 46px; padding: 3px 10px; background: rgb(3 4 3 / 0.85); font: bold 20px "Liberation Mono", monospace; color: #ffc35a; letter-spacing: 0.1em; text-shadow: 0 0 6px rgb(255 180 60 / 0.6); }
      .__hl { outline: 3px solid #ffc35a !important; outline-offset: 2px; animation: __hlp 1.1s ease-in-out infinite; }
      @keyframes __hlp { 50% { outline-color: rgb(255 195 90 / 0.2); } }
      #__crt .tag { position: absolute; top: 30px; right: 44px; padding: 4px 12px; font: bold 22px "Liberation Mono", monospace; color: #050806; background: #ffc35a; letter-spacing: 0.08em; }
      @keyframes __flick { 0%, 100% { opacity: 1 } 47% { opacity: 0.92 } 48% { opacity: 1 } 73% { opacity: 0.95 } }
    \`
    const d = document.createElement("div")
    d.id = "__crt"
    d.innerHTML = '<div class="scan"></div><div class="vig"></div>' + (${bezel} ? '<div class="bez"></div>' : '')
    d.appendChild(s)
    document.documentElement.appendChild(d)
    // Dim bright web pages a little so they sit in the dark CRT frame.
    if (${bezel}) document.body.style.filter = "brightness(0.86) contrast(1.06) saturate(0.95)"
  })()`)
}
async function badge(text) {
  await evaluate(`(() => { const c = document.getElementById("__crt"); c?.querySelector(".tag")?.remove(); if (${JSON.stringify(text)}) c?.insertAdjacentHTML("beforeend", '<div class="tag">' + ${JSON.stringify(text)} + '</div>') })()`)
}
let chapterText = ""
async function chapter(text) {
  if (text !== undefined) chapterText = text
  await evaluate(`(() => { const c = document.getElementById("__crt"); c?.querySelector(".chap")?.remove(); if (${JSON.stringify(chapterText)}) c?.insertAdjacentHTML("beforeend", '<div class="chap">' + ${JSON.stringify(chapterText)} + '</div>') })()`)
}

// Camera push-in on one element, with a pulsing outline.
async function focus(selector, match, scale = 1.4) {
  await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => !${JSON.stringify(match ?? "")} || e.textContent.includes(${JSON.stringify(match ?? "")}))
    if (!el) return
    document.querySelectorAll(".__hl").forEach((e) => e.classList.remove("__hl"))
    el.classList.add("__hl")
    el.scrollIntoView({ block: "center" })
    const r = el.getBoundingClientRect()
    const b = document.body
    b.style.transition = "transform 1.3s cubic-bezier(.2,.7,.2,1)"
    b.style.transformOrigin = (r.left + r.width / 2 + scrollX) + "px " + (r.top + r.height / 2 + scrollY) + "px"
    b.style.transform = "scale(${scale})"
  })()`)
}
async function unfocus() {
  await evaluate(`(() => { document.body.style.transition = "none"; document.body.style.transform = "none"; document.querySelectorAll(".__hl").forEach((e) => e.classList.remove("__hl")) })()`)
}

async function staticNoise(on) {
  await evaluate(on
    ? `(() => {
        const c = document.createElement("canvas"); c.id = "__static"; c.width = 320; c.height = 180
        Object.assign(c.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: "2147483647", imageRendering: "pixelated" })
        document.documentElement.appendChild(c)
        const g = c.getContext("2d"), img = g.createImageData(320, 180)
        const draw = () => { if (!c.isConnected) return; for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255 | 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255 } g.putImageData(img, 0, 0); requestAnimationFrame(draw) }
        draw()
      })()`
    : `document.getElementById("__static")?.remove()`)
}
async function go(url, settleMs, bezel) {
  await send("Page.navigate", { url })
  await sleep(settleMs)
  await crt(bezel)
  await chapter()
}
async function scrollTo(selector, offset = 24) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -${offset}) } })()`)
}

// ---------- filming ----------

const frames = []
let frameNo = 0
function keep(data, dur) {
  const file = path.join(FRAMES, `${String(frameNo++).padStart(6, "0")}.jpg`)
  fs.writeFileSync(file, Buffer.from(data, "base64"))
  frames.push({ file, dur })
}

// Films exactly `dur` seconds in real time. `act(at)` runs scene actions; at(t) waits until t s into the scene.
async function film(dur, act = async () => {}) {
  castFrames = []
  const t0 = Date.now() / 1000
  await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
  const at = async (t) => {
    const w = t0 + t - Date.now() / 1000
    if (w > 0) await sleep(w * 1000)
  }
  await act(at)
  await at(dur)
  await send("Page.stopScreencast")
  const got = castFrames.filter((f) => f.at <= t0 + dur)
  castFrames = null
  if (!got.length) got.push({ data: (await send("Page.captureScreenshot", { format: "jpeg", quality: 85 })).data, at: t0 })
  got.forEach((f, i) => {
    const start = i === 0 ? t0 : f.at
    const end = i + 1 < got.length ? got[i + 1].at : t0 + dur
    keep(f.data, Math.max(0.001, end - start))
  })
}

// Squeezes a long real-time wait into `dur` seconds of video.
async function timelapse(dur, stopWhen, maxRealS = 300) {
  const shots = []
  const start = Date.now()
  while (Date.now() - start < maxRealS * 1000) {
    shots.push((await send("Page.captureScreenshot", { format: "jpeg", quality: 85 })).data)
    if (await stopWhen()) break
    await sleep(1000)
  }
  for (let i = 0; i < 4; i++) shots.push((await send("Page.captureScreenshot", { format: "jpeg", quality: 85 })).data)
  const speed = ((Date.now() - start) / 1000 / dur).toFixed(0)
  shots.forEach((d) => keep(d, dur / shots.length))
  log(`time-lapse: ${shots.length} frames, about ${speed}x`)
}

function colour(line) {
  return esc(line)
    .replace(/(0x[0-9a-fA-F]{6})[0-9a-fA-F]{30,}/g, "$1…")
    .replace(/(dns_tampered|block_page|-&gt; 0\.0\.0\.0)/g, '<span class="bad">$1</span>')
    .replace(/(:ok)\b/g, '<span class="ok">$1</span>')
    .replace(/(unreachable|corroborated[^<]*)/g, '<span class="hl">$1</span>')
    .replace(/^(\[[a-z-]+\])/, '<span class="dim">$1</span>')
}

// ---------- scenes, in timeline order ----------

const items = TL.items
const sceneOf = (id) => items.find((i) => i.type === "scene" && i.id === id)
let blockedKey

const SCENES = {
  async title(s) {
    await go(STAGE, 1500, false)
    await chapter("")
    await evaluate(`show(${JSON.stringify(`<div class="title"><h1 class="glow" data-text="GROUNDTRUTH">GROUNDTRUTH</h1><p class="amber">down &middot; blocked &middot; switched off<span class="cursor">_</span></p><div class="rule"></div></div>`)})`)
    await film(s.dur, async () => {
      await evaluate(`document.body.classList.add("on")`)
    })
  },

  async problem(s) {
    chapterText = "00 // THE PROBLEM"
    await go(STAGE, 800, false)
    await evaluate(`show(${JSON.stringify(`<div class="story glow">
      <p class="line"><span class="prompt">&gt;</span>site <span class="amber">down</span>?</p>
      <p class="line"><span class="prompt">&gt;</span><span class="red">blocked</span> by your provider, on a secret order?</p>
      <p class="line"><span class="prompt">&gt;</span>internet <span class="grey">switched off</span>?</p>
      <p class="line"><span class="prompt">&gt;</span>groundtruth tells them apart.<span class="cursor">_</span></p></div>`)})`)
    await film(s.dur, async (at) => {
      await at(s.sents[0].start); await evaluate("reveal(0)")
      await at(s.sents[0].start + 1.6); await evaluate("reveal(1)")
      await at(s.sents[1].start); await evaluate("reveal(2)")
      await at(s.sents[2].start); await evaluate("reveal(3)")
    })
  },

  async lab(s) {
    if (!DRY) {
      log("waiting for round 1 from all four probes")
      await waitFor(() => ["probe-a", "probe-b", "probe-c", "real"].every((p) => labLines.some((l) => l.startsWith(`[${p}]`) && /round 1 /.test(l))), 240_000, "round 1")
    }
    const lines = labLines.filter((l) => !l.startsWith("[real]") && /sinkhole|lab site|probe 0x|round \d|corroborated/.test(l)).slice(0, TERM_LINES)
    chapterText = "01 // THE LAB"
    await go(STAGE, 800, false)
    await evaluate(`show(${JSON.stringify(`<div class="term glow"><div class="term-bar">&gt; npm run lab</div><pre id="t"></pre></div>`)})`)
    const shown = (lines.length ? lines : ["(dry run: no lab output)"]).concat(Array(TERM_LINES).fill("")).slice(0, TERM_LINES)
    await film(s.dur, async (at) => {
      const span = s.sents.at(-1).end - 0.5
      for (let i = 0; i < shown.length; i++) {
        await at(0.3 + (span * i) / TERM_LINES)
        await evaluate(`termLine(${JSON.stringify(colour(shown[i]))})`)
      }
    })
  },

  async dash(s) {
    chapterText = "02 // THE DASHBOARD"
    await go(DASH, 7000, true)
    await scrollTo(".page", 0)
    await film(s.dur, async (at) => {
      await at(s.sents[1].start - 0.3)
      await focus("#grid tr", "torproject.org", 1.35)
    })
  },

  async detail(s) {
    await unfocus()
    blockedKey = await evaluate(`(() => { const td = [...document.querySelectorAll("#grid td.cell")].find((t) => /blocked/.test(t.textContent)); if (td) { td.click(); return td.dataset.key } })()`)
    await sleep(2500)
    await film(s.dur)
    await evaluate(`document.getElementById("detail")?.close()`)
  },

  async real(s) {
    await unfocus()
    await chapter("03 // A REAL NETWORK")
    await scrollTo("#networks")
    await film(s.dur, async (at) => {
      await at(0.3)
      await focus(".region", "Jio", 1.5)
    })
  },

  async outage(s) {
    if (!DRY) {
      log("stopping the lab site")
      lab.stdin.write("s")
      const before = countLines(/lab-site:unreachable/)
      await waitFor(() => countLines(/lab-site:unreachable/) >= before + 3, 180_000, "lab-site unreachable everywhere")
      // Film the page only once it shows the outage itself, not just once the probes logged it.
      await waitFor(
        () => evaluate(`[...document.querySelectorAll("#grid tr")].some((r) => /lab-site/.test(r.cells[0]?.textContent) && /down everywhere/i.test(r.cells[1]?.textContent))`),
        90_000,
        "dashboard to show lab-site down everywhere",
      )
      await sleep(2000)
    }
    await unfocus()
    await chapter("04 // OUTAGE")
    await scrollTo("#now")
    await film(s.dur, async (at) => {
      await at(0.3)
      await focus("#grid tr", "lab-site", 1.35)
    })
  },

  async shutdown_a(s) {
    if (!DRY) {
      log("stopping probe C")
      lab.stdin.write("c")
    }
    await unfocus()
    await chapter("05 // SHUTDOWN")
    await scrollTo("#networks")
    await badge("&#9654;&#9654; TIME-LAPSE")
    if (DRY) await film(s.dur)
    else await timelapse(s.dur, () => evaluate(`[...document.querySelectorAll(".region.dark h3")].some((h) => /IN-LAB-SOUTH/.test(h.textContent))`))
    await badge("")
  },

  async shutdown_b(s) {
    await film(s.dur, async (at) => {
      await at(0.2)
      await focus(".region.dark", "", 1.5)
    })
  },

  async evidence(s) {
    await unfocus()
    await chapter("06 // EVIDENCE")
    await scrollTo("#evidence-win")
    await film(s.dur, async (at) => {
      await at(s.sents[0].start + 0.6)
      await focus("#evidence tr:nth-child(2)", "", 1.3)
    })
  },

  async verify(s) {
    const since = Math.floor(Date.now() / 1000) - 1800
    const query = `project = str('groundtruth') AND kind = str('measurement') AND ts >= i32(${since})`
    let out = ["(request failed)"]
    try {
      const res = await (await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [query, { select: { key: true, creator: true, attributes: true }, limit: "0xc8" }] }),
      })).json()
      const data = res.result?.data ?? []
      const first = data.find((e) => JSON.stringify(e).includes("dns_tampered")) ?? data[0]
      out = [`→ ${data.length} measurements in the last 30 minutes`, ...JSON.stringify(first ?? res, null, 1).split("\n").slice(0, 11)]
    } catch (e) {
      out = [String(e)]
    }
    chapterText = "07 // VERIFY"
    await go(STAGE, 800, false)
    await evaluate(`show(${JSON.stringify(`<div class="term glow"><div class="term-bar">&gt; anyone, anywhere. no groundtruth server.</div><pre id="t"></pre></div>`)})`)
    const lines = [`$ curl -s ${RPC} \\`, `   -d '{"method":"arkiv_query","params":["${query}"]}'`, ...out].slice(0, TERM_LINES)
    await film(s.dur, async (at) => {
      for (let i = 0; i < lines.length; i++) {
        await at(0.2 + i * 0.22)
        await evaluate(`termLine(${JSON.stringify(colour(lines[i]))})`)
      }
    })
  },

  async explorer(s) {
    if (blockedKey) await go(`${EXPLORER}/entity/${blockedKey}`, 6000, true)
    await film(s.dur)
  },

  async end(s) {
    chapterText = ""
    await go(STAGE, 800, false)
    await evaluate(`show(${JSON.stringify(`<div class="end glow"><h1 data-text="GROUNDTRUTH">GROUNDTRUTH</h1>
      <p class="amber">quantapixel.github.io/groundtruth</p>
      <p>github.com/Quantapixel/groundtruth &middot; MIT</p>
      <p class="dim">built on Arkiv &middot; npm run probe<span class="cursor">_</span></p></div>`)})`)
    await film(s.dur, async (at) => {
      await at(s.dur - 0.75)
      await evaluate(`document.body.classList.add("off")`)
    })
  },
}

for (const it of items) {
  if (it.type === "cut") {
    await staticNoise(true)
    await film(it.dur)
    await staticNoise(false)
  } else {
    log(`scene ${it.id} (${it.dur}s)`)
    await SCENES[it.id](it)
  }
}

// ---------- render ----------

if (!DRY) lab.stdin.write("q")
ws.close()

const list = frames.map((f) => `file '${f.file}'\nduration ${f.dur.toFixed(4)}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`
fs.writeFileSync(path.join(OUT, "frames.txt"), list)
fs.writeFileSync(path.join(OUT, "lab.log"), labLines.join("\n"))

const ts = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60).toFixed(2).padStart(5, "0")
  return `${h}:${String(m).padStart(2, "0")}:${s}`
}
const subs = items.filter((i) => i.type === "scene").flatMap((sc) => sc.sents.map((x) => ({ a: sc.start + x.start, b: sc.start + x.end + 0.15, text: x.text })))
fs.writeFileSync(path.join(OUT, "subs.ass"), `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Mono,40,&H0066CCFF,&H0066CCFF,&H18000000,&H18000000,1,0,0,0,100,100,0,0,3,12,0,2,180,180,58,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${subs.map((x) => `Dialogue: 0,${ts(x.a)},${ts(x.b)},Default,,0,0,0,,${x.text.replace(/\n/g, " ")}`).join("\n")}
`)

const total = frames.reduce((a, f) => a + f.dur, 0)
log(`rendering ${frames.length} frames, ${total.toFixed(1)} s video for ${TL.total} s of audio`)
const mp4 = path.join(OUT, DRY ? "groundtruth-demo-DRY.mp4" : "groundtruth-demo.mp4")
execSync(
  `ffmpeg -y -loglevel error -f concat -safe 0 -i "${path.join(OUT, "frames.txt")}" -i "${path.join(NARR, "audio.wav")}" ` +
    `-vf "fps=30,scale=1920:1080:flags=lanczos,noise=alls=6:allf=t,ass='${path.join(OUT, "subs.ass")}',format=yuv420p" ` +
    `-af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v libopenh264 -b:v 9M -c:a aac -b:a 192k -ar 48000 -shortest "${mp4}"`,
  { stdio: "inherit" },
)
fs.rmSync(path.join(OUT, "chrome-profile"), { recursive: true, force: true })
log(`done: ${mp4}`)
process.exit(0)
