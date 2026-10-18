"""Narration, sound bed and timeline for the Groundtruth demo video.

Speaks every sentence separately with Kokoro TTS, so subtitles and on-screen actions can be
timed to the exact moment each sentence starts. Writes, into the output directory:

  audio.wav       narration + low drone + static hiss on scene cuts (24 kHz mono)
  timeline.json   scenes and transitions with start/duration, plus each sentence's timing

Usage: python narrate.py <kokoro_dir> <out_dir> [voice]
  kokoro_dir holds kokoro-v1.0.onnx and voices-v1.0.bin
  (https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import EspeakConfig, Kokoro

SR = 24_000
PAD_IN, GAP, PAD_OUT, CUT = 0.35, 0.22, 0.5, 0.4

# (scene id, cut before it, sentences)
SCRIPT = [
    ("title", False, ["When a website won't load in India, nobody tells you why."]),
    ("problem", True, [
        "Is the site down? Blocked by your provider, on a secret government order?",
        "Or has the internet been switched off?",
        "Groundtruth tells them apart. And nobody can take it down.",
    ]),
    ("lab", True, [
        "Probes on different networks test the same sites, every minute.",
        "Here, two of the providers use a censoring resolver.",
        "Every round goes to Arkiv, the Web3 database, in one atomic batch.",
    ]),
    ("dash", True, [
        "No backend. This page reads Arkiv directly.",
        "Tor project dot org is blocked on A and B, but works on C. That's censorship, not an outage.",
    ]),
    ("detail", False, [
        "Every result is locked on chain, even from the probe that wrote it.",
        "The provider answered zero dot zero dot zero dot zero. The control resolver didn't.",
    ]),
    ("outage", True, ["Switch the test site off, and every network fails. Down everywhere, not blocked."]),
    ("shutdown_a", True, ["Then probe C goes silent. Its heartbeat on Arkiv expires."]),
    ("shutdown_b", False, ["The region turns silent. A possible shutdown. No server can fake that silence."]),
    ("evidence", True, [
        "When a second provider sees the same block, the evidence is kept for seven days instead of two.",
        "Anyone can keep it alive. Nobody can change it.",
    ]),
    ("verify", True, ["Don't trust our page. One command pulls the same data straight from Arkiv."]),
    ("explorer", False, ["Or check any record on the public explorer."]),
    ("end", True, ["Groundtruth. Down, blocked, or switched off. Open source, and on your network in one command."]),
]


def drone(n: int) -> np.ndarray:
    t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    brown = np.cumsum(rng.normal(0, 1, n))
    brown -= np.convolve(brown, np.ones(SR) / SR, mode="same")  # remove drift
    brown /= np.max(np.abs(brown)) + 1e-9
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * 0.05 * t)
    bed = (
        0.050 * np.sin(2 * np.pi * 55.0 * t) * swell
        + 0.030 * np.sin(2 * np.pi * 82.4 * t + 1.3) * (1 - 0.5 * swell)
        + 0.018 * np.sin(2 * np.pi * 110.0 * t) * swell
        + 0.030 * brown
    )
    fade = np.minimum(1, np.minimum(t / 2.0, (t[-1] - t) / 2.5))
    return bed * fade


def static_burst(n: int) -> np.ndarray:
    rng = np.random.default_rng(n)
    env = np.sin(np.linspace(0, np.pi, n)) ** 0.5
    return rng.uniform(-1, 1, n) * env * 0.10


def main() -> None:
    kokoro_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    voice = sys.argv[3] if len(sys.argv) > 3 else "am_michael"
    out_dir.mkdir(parents=True, exist_ok=True)
    # The espeak-ng bundled with espeakng-loader 0.2.4 looks for its data at a CI build path;
    # a system espeak-ng (e.g. Fedora's espeak-ng package) works.
    lib = os.environ.get("ESPEAK_LIB", "/usr/lib64/libespeak-ng.so.1")
    data = os.environ.get("ESPEAK_DATA", "/usr/share/espeak-ng-data")
    espeak = EspeakConfig(lib_path=lib, data_path=data) if Path(lib).exists() else None
    tts = Kokoro(str(kokoro_dir / "kokoro-v1.0.onnx"), str(kokoro_dir / "voices-v1.0.bin"), espeak_config=espeak)

    items, voice_parts, cursor = [], [], 0.0
    for scene_id, cut_before, sentences in SCRIPT:
        if cut_before and items:
            items.append({"type": "cut", "start": round(cursor, 3), "dur": CUT})
            cursor += CUT
        start, t, sents = cursor, PAD_IN, []
        for text in sentences:
            samples, sr = tts.create(text, voice=voice, speed=1.08, lang="en-us")
            assert sr == SR
            d = len(samples) / SR
            sents.append({"text": text, "start": round(t, 3), "end": round(t + d, 3)})
            voice_parts.append((start + t, samples))
            t += d + GAP
        dur = t - GAP + PAD_OUT
        items.append({"type": "scene", "id": scene_id, "start": round(start, 3), "dur": round(dur, 3), "sents": sents})
        cursor += dur

    total = cursor
    n = int(total * SR) + SR
    mix = drone(n)
    narration = np.zeros(n)
    for at, samples in voice_parts:
        i = int(at * SR)
        narration[i : i + len(samples)] += samples
    narration *= 0.92 / (np.max(np.abs(narration)) + 1e-9)
    mix += narration
    for it in items:
        if it["type"] == "cut":
            i, m = int(it["start"] * SR), int(it["dur"] * SR)
            mix[i : i + m] += static_burst(m)
    mix = np.clip(mix, -0.99, 0.99)[: int(total * SR)]

    sf.write(out_dir / "audio.wav", mix.astype(np.float32), SR)
    (out_dir / "timeline.json").write_text(json.dumps({"total": round(total, 3), "voice": voice, "items": items}, indent=1))
    print(f"{total:.1f} s, {sum(1 for i in items if i['type'] == 'scene')} scenes, voice {voice}")


if __name__ == "__main__":
    main()
