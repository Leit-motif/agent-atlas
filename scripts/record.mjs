#!/usr/bin/env node
// Records the demo map in headless Chrome: the overview, opening Instructions and Hooks, opening
// one hook, then the Files view. Writes docs/atlas-demo.mp4 (for posting) and
// docs/atlas-demo.gif (for the README). Needs Chrome and ffmpeg; no npm packages.
//   node scripts/demo.mjs && node scripts/record.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1440, H = 860, SCALE = 4 / 3; // 1920 x 1147 frames
const PORT = 9333;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-atlas-rec-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(chrome, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${work}/profile`,
  "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
if (!target) throw new Error("Chrome did not start");

// Minimal Chrome DevTools Protocol client.
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const waiting = new Map(), listeners = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const { ok, fail } = waiting.get(m.id); waiting.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
  else listeners.forEach((f) => f(m));
});
const send = (method, params = {}) => new Promise((ok, fail) => { const id = ++seq; waiting.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
await send("Page.enable");
const loaded = new Promise((r) => listeners.push((m) => m.method === "Page.loadEventFired" && r()));
await send("Page.navigate", { url: `file://${path.join(repo, "out/demo.html")}` });
await loaded;
await sleep(1500); // fonts, then the first layout settles
await js(`document.querySelector("#legend").open = false; document.querySelector("#hint")?.remove(); fit();`);
await sleep(900);

// A drawn cursor that follows real mouse events, so viewers can see what is clicked.
await js(`(() => {
  const c = document.createElement("div");
  c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7.5 16 L11 24 L14.5 22.5 L11 14.8 L18.5 14.8 Z" fill="#ECE7DE" stroke="#151515" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 99, pointerEvents: "none", transform: "translate(-200px,-200px)", transition: "scale .12s" });
  document.body.append(c);
  addEventListener("mousemove", (e) => { c.style.transform = "translate(" + (e.clientX - 2) + "px," + (e.clientY - 2) + "px)"; }, true);
  addEventListener("mousedown", () => { c.style.scale = ".85"; }, true);
  addEventListener("mouseup", () => { c.style.scale = "1"; }, true);
})()`);

let mouse = { x: W * 0.62, y: H * 0.78 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
async function moveTo(x, y, ms = 700) {
  const from = { ...mouse }, steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    mouse = { x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mouse.x, y: mouse.y });
    await sleep(16);
  }
}
async function click(x, y, ms) {
  await moveTo(x, y, ms);
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(90);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
// Centre of a graph node by its title, or of a page element by selector, read at the moment of use.
const nodeAt = (title) => js(`(() => { const g = [...document.querySelectorAll("g.n")].find((e) => d3.select(e).datum().n.t === ${JSON.stringify(title)});
  if (!g) return null; const r = g.querySelector(".body").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const elAt = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const clickNode = async (title, ms) => { const p = await nodeAt(title); if (!p) throw new Error(`no node ${title}`); await click(p.x, p.y, ms); };

// Record frames with their timestamps, so the video keeps real-time pacing.
const frames = [];
listeners.push((m) => {
  if (m.method !== "Page.screencastFrame") return;
  frames.push({ t: m.params.metadata.timestamp, data: m.params.data });
  send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
});
await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(W * SCALE), maxHeight: Math.round(H * SCALE), everyNthFrame: 1 });
await moveTo(W * 0.5, H * 0.55, 400);

// The story: overview, open Instructions, open Hooks down to one hook, then the Files view.
// After each click the cursor steps off the node, so the hover highlight doesn't dim the map.
// Rest in the emptiest spot near (x, y): the point that keeps farthest from every node and label.
const rest = async (x, y) => {
  const p = await js(`(() => {
    if (!document.querySelector("#stage")) return { x: ${x}, y: ${y} }; // the Files view has no map
    const boxes = [...document.querySelectorAll("#graph g.n")].map((g) => g.getBoundingClientRect());
    const area = document.querySelector("#stage").getBoundingClientRect(), panel = document.querySelector("#insp").getBoundingClientRect();
    let best = { x: ${x}, y: ${y}, score: -1 };
    for (let gx = area.x + 40; gx < area.right - 40; gx += 24) for (let gy = area.y + 40; gy < area.bottom - 40; gy += 24) {
      const inPanel = gx >= panel.x && gx <= panel.right && gy >= panel.y && gy <= panel.bottom;
      const clear = inPanel ? 400 : Math.min(400, ...boxes.map((b) => Math.hypot(Math.max(b.x - gx, 0, gx - b.right), Math.max(b.y - gy, 0, gy - b.bottom))));
      const score = Math.min(clear, 90) - Math.hypot(gx - ${x}, gy - ${y}) / 12;
      if (score > best.score) best = { x: gx, y: gy, score };
    }
    return best;
  })()`);
  await moveTo(p.x, p.y, 550);
};
await sleep(1400);
await clickNode("Instructions", 900);
await rest(W * 0.33, H * 0.42);
await sleep(1900);
await clickNode("Hooks", 900);
await rest(W * 0.48, H * 0.62);
await sleep(1300);
await clickNode("PreToolUse", 800);
await rest(W * 0.5, H * 0.66);
await sleep(1300);
await clickNode("block-force-push.sh", 900);
await moveTo(W * 0.83, H * 0.36, 650); // beside the hook's summary in the side panel
await sleep(2800);
const files = await elAt("#knobsBtn");
await click(files.x, files.y, 1000);
await rest(W * 0.55, H * 0.45);
await sleep(2600);

await send("Page.stopScreencast");
await sleep(300);
ws.close(); browser.kill();

// Frames to video: each frame lasts until the next one arrives.
if (frames.length < 20) throw new Error(`only ${frames.length} frames captured`);
const list = [];
frames.forEach((f, i) => {
  const file = path.join(work, `f${String(i).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, "base64"));
  const dur = i + 1 < frames.length ? frames[i + 1].t - f.t : 1;
  list.push(`file '${file}'`, `duration ${Math.max(dur, 0.001).toFixed(4)}`);
});
list.push(`file '${path.join(work, `f${String(frames.length - 1).padStart(5, "0")}.jpg`)}'`);
fs.writeFileSync(path.join(work, "frames.txt"), list.join("\n"));
const docs = path.join(repo, "docs");
const ff = (...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { stdio: "inherit" });
ff("-f", "concat", "-safe", "0", "-i", `${work}/frames.txt`, "-vf", "fps=30,scale=1920:-2:flags=lanczos,format=yuv420p",
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", `${docs}/atlas-demo.mp4`);
ff("-i", `${docs}/atlas-demo.mp4`, "-vf", "fps=15,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  `${docs}/atlas-demo.gif`);
fs.rmSync(work, { recursive: true, force: true });
const mb = (f) => (fs.statSync(`${docs}/${f}`).size / 1e6).toFixed(1) + " MB";
console.log(`${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)}s → docs/atlas-demo.mp4 (${mb("atlas-demo.mp4")}), docs/atlas-demo.gif (${mb("atlas-demo.gif")})`);
