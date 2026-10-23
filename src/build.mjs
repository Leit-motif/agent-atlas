#!/usr/bin/env node
// Turn discover.mjs's graph (Claude Code only) into the Atlas page.
//   node src/build.mjs <graph.json> <out.html> [--summaries summaries.json] [--request request.json]
// Summaries are the model pass: whoever runs the skill reads each requested file and writes one
// plain-language line per node into summaries.json. Each is keyed to the file's hash, so a summary of
// a file that has since changed is dropped and requested again rather than shown stale.
// renderer/atlas.html is the page; this fills its /*@ATLAS_DATA@*/ marker.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [graphPath, outPath] = process.argv.slice(2);
const flag = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const G = JSON.parse(fs.readFileSync(graphPath, "utf8"));
const HOME = G.home;
const abs = (id) => (id.startsWith("~") ? HOME + id.slice(1) : id);
const MAX_BYTES = 50 * 2 ** 20;
const read = (p) => { try { return fs.statSync(p).size > MAX_BYTES ? null : fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); } catch { return null; } }; // CRLF files from Windows checkouts

// ---- Claude Code's slice of the graph ----
const ROOT = "session:claude-code";
const N = new Map(G.nodes.map((n) => [n.id, n]));
const ccEdges = G.edges.filter((e) => !e.tool || e.tool === "claude-code");
const reach = new Set([ROOT]);
for (let grew = true; grew; ) { grew = false; for (const e of ccEdges) if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; } }
const E = ccEdges.filter((e) => reach.has(e.from) && reach.has(e.to));
const out = (id, type) => E.filter((e) => e.from === id && (!type || e.type === type));

// Frontmatter description of a skill or agent, or a file's first heading: real text, no model.
function describe(p) {
  const t = read(p);
  if (!t) return null;
  const fm = t.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const d = fm?.match(/^description:\s*(?:[>|]-?\s*\n)?\s*(.+(?:\n\s+.+)*)/m)?.[1];
  if (d) return d.replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  const h = t.match(/^#\s+(.+)/m)?.[1];
  return h ? `Starts with “${h.trim()}”. ${t.split("\n").length} lines.` : `${t.split("\n").length} lines.`;
}
// A file a project or plugin points to outside itself (discover.mjs marks it): shown by path, never opened.
const sealed = (gid) => Boolean(N.get(gid)?.outside || out(gid, "links-to").some((e) => N.get(e.to)?.outside));
const OUTSIDE = "Outside the project or plugin that points here, so Atlas doesn't open it. Check why it is referenced.";
const about = (gid, p) => (sealed(gid) ? OUTSIDE : describe(p));
const base = (id) => path.basename(id.replace(/\/$/, ""));
const short = (s, n = 150) => (s && s.length > n ? s.slice(0, n - 1).replace(/\s\S*$/, "") + "…" : s);
const inPluginCache = (id) => id.includes("/.claude/plugins/cache/");

// ---- tree building ----
let seq = 0;
const idOf = new Map(); // graph id -> tree id (first placement wins)
const LINKS = [];
function tnode(gid, fields) {
  const id = "n" + seq++;
  if (gid && !idOf.has(gid)) idOf.set(gid, id);
  return { id, ...fields };
}
const link = (a, b, type, why) => LINKS.push([a, b, type, why]);

// Instructions: each loaded file, its symlink target, and what it imports, nested where first met.
const SCOPE = { managed: "managed policy", user: "your user file", "user-rules": "a user rule", ancestor: "a parent folder", project: "this project", local: "local, not committed", "project-rules": "a project rule", "auto-memory": "Claude's own notes" };
function memoryNode(gid, why, seen = new Set()) {
  if (idOf.has(gid) || seen.has(gid)) return null;
  seen.add(gid);
  const n = N.get(gid);
  const linkTo = out(gid, "links-to")[0]?.to;
  const desc = n.missing ? "Imported but not found. Claude Code skips it silently." : linkTo ? `A symlink. Claude Code reads ${linkTo}.` : about(gid, abs(gid));
  const node = tnode(gid, {
    t: base(gid), k: why, s: desc,
    f: [[gid, n.missing ? "Missing." : n.outside ? "Named from outside: a project or plugin points here." : linkTo ? "A link: edit the file it points to." : "Read at session start. Edit it and the next session sees it.", n.outside ? "outside" : linkTo || n.missing ? "gen" : inPluginCache(gid) ? "gen" : "live", linkTo]],
    st: n.missing ? "missing" : undefined,
  });
  const kids = [];
  if (linkTo) { const c = memoryNode(linkTo, "the real file", seen); if (c) kids.push(c); link(idOf.get(gid), idOf.get(linkTo), "flow", "is a symlink to"); }
  for (const e of out(gid, "imports")) {
    const c = memoryNode(e.to, `imported as ${e.as}`, seen);
    if (c) kids.push(c);
    link(idOf.get(e.to), idOf.get(gid), "flow", `imported as ${e.as}`);
  }
  if (kids.length) node.c = kids;
  return node;
}
const loads = out(ROOT, "loads");
const memLoads = loads.filter((e) => N.get(e.to).kind === "memory");
const instructions = {
  id: "instructions", br: "rules", t: "Instructions", k: `${memLoads.length} entry files, ${[...reach].filter((g) => N.get(g)?.kind === "memory").length} in all`,
  s: "Every instruction file Claude Code reads when a session starts in this folder, with what each one imports. Imports nest under the file that pulls them in.",
  b: ["Claude Code reads these once, at session start, so an edit reaches the next session, not the one running.", "Order matters only loosely: more specific files (the project's) are read after broader ones (yours), and the model sees all of them."],
  c: memLoads.map((e) => memoryNode(e.to, SCOPE[e.scope] ?? e.scope)).filter(Boolean),
};
// Every loaded instruction file flows into the session.
for (const e of memLoads) link(idOf.get(e.to), "home", "flow", `loaded (${SCOPE[e.scope] ?? e.scope})`);

// Settings files and the hooks they wire.
const settingsLoads = loads.filter((e) => N.get(e.to).kind === "settings");
const hookKids = [];
const settings = {
  id: "settings", br: "claude", t: "Settings", k: `${settingsLoads.length} file${settingsLoads.length === 1 ? "" : "s"}`,
  s: "The JSON files that set permissions, environment variables, hooks and plugins. User settings apply everywhere; project and local settings apply in this folder and win.",
  c: settingsLoads.map((e) => {
    const n = N.get(e.to);
    const node = tnode(e.to, {
      t: base(e.to), k: SCOPE[e.scope] ?? e.scope,
      s: `${SCOPE[e.scope] ?? e.scope} settings.${n.envKeys ? ` Sets ${n.envKeys} environment variable${n.envKeys === 1 ? "" : "s"}; their values are left off this page.` : ""}`,
      f: [[e.to, "Edit it; most keys apply to the next session.", sealed(e.to) ? "outside" : "live"]],
    });
    link(node.id, "home", "flow", "read at session start");
    return node;
  }),
};

// Hooks, grouped by event.
const wires = E.filter((e) => e.type === "wires");
const byEvent = {};
for (const e of wires) (byEvent[e.event] ??= []).push(e);
const EVENT = { SessionStart: "when a session starts", Stop: "when Claude tries to stop", PreToolUse: "before a tool runs", PostToolUse: "after a tool runs", UserPromptSubmit: "when you send a message", Notification: "on a notification", SubagentStop: "when a subagent stops", PreCompact: "before compaction", module: "inside Claude Code, as a function-hook module" };
const hooks = {
  id: "hooks", br: "trust", t: "Hooks", k: `${new Set(wires.map((e) => e.to)).size} scripts`,
  s: "Scripts Claude Code runs at fixed moments. A hook can block an action, add context, or just record what happened.",
  c: Object.entries(byEvent).map(([ev, list]) => tnode(null, {
    t: ev, k: EVENT[ev] ?? "", s: `Runs ${EVENT[ev] ?? ev}.`,
    c: list.filter((e) => !idOf.has(e.to)).map((e) => {
      const fromPlugin = N.get(e.from)?.kind === "plugin";
      const node = tnode(e.to, {
        t: base(e.to), k: e.matcher && e.matcher !== "*" ? `on ${e.matcher}` : EVENT[ev] ?? "",
        s: `Runs ${EVENT[ev] ?? ev}${e.matcher && e.matcher !== "*" ? ` for ${e.matcher}` : ""}. Wired by ${fromPlugin ? "the " + e.from.replace(/^plugin:/, "") + " plugin" : e.from}.`,
        f: [[e.to, sealed(e.to) ? "Named in a hook command, outside the project or plugin that wires it." : fromPlugin ? "Ships with a plugin; updates replace it." : "The script. Edits apply the next time the hook fires.", sealed(e.to) ? "outside" : fromPlugin ? "gen" : "live"]],
      });
      return node;
    }),
  })).filter((g) => g.c.length),
};
for (const e of wires) if (idOf.has(e.from) && idOf.has(e.to)) link(idOf.get(e.from), idOf.get(e.to), "use", `runs it ${EVENT[e.event] ?? e.event}`);

// Skills and subagents of your own (user and project scope).
const skillNode = (gid, owner) => tnode(gid, {
  t: base(gid), k: owner,
  s: short(about(gid, path.join(abs(gid), "SKILL.md"))) ?? "A skill.",
  f: [[gid + "/SKILL.md", inPluginCache(gid) ? "Ships with its plugin; updates replace it." : "Edit it; the next session lists the new description.", sealed(gid) ? "outside" : inPluginCache(gid) ? "gen" : "skills"]],
});
const groupSkills = (list, label) => {
  // Fold big lists into alphabetical groups so a ring never holds more than ~14 nodes.
  if (list.length <= 14) return list;
  const size = Math.ceil(list.length / Math.ceil(list.length / 12));
  const groups = [];
  for (let i = 0; i < list.length; i += size) { const part = list.slice(i, i + size); const x = part[0].t, y = part.at(-1).t; let k = 0; while (k < x.length && x[k] === y[k]) k++;
    groups.push(tnode(null, { t: x === y ? x : `${x.slice(0, k + 1)} – ${y.slice(0, k + 1)}`, k: `${part.length} ${label}`, s: part.map((p) => p.t).join(", "), c: part })); }
  return groups;
};
const mySkills = out(ROOT, "provides").filter((e) => N.get(e.to).kind === "skill").map((e) => skillNode(e.to, e.to.startsWith(G.cwd.replace(HOME, "~")) ? "this project" : "yours")).sort((a, b) => a.t.localeCompare(b.t));
const skills = {
  id: "skills", br: "skills", t: "Your skills", k: `${mySkills.length} installed`,
  s: "Skills in ~/.claude/skills and this project's .claude/skills. Each one's name and description sit in every session's context; the body loads only when a task calls for it.",
  c: groupSkills(mySkills, "skills"),
};
const myAgents = out(ROOT, "provides").filter((e) => N.get(e.to).kind === "agent");
const agents = {
  id: "agents", br: "machines", t: "Subagents", k: `${myAgents.length} defined`,
  s: "Agent definitions Claude Code can hand work to. Each has its own prompt, tools and model.",
  c: myAgents.map((e) => tnode(e.to, { t: base(e.to).replace(/\.md$/, ""), k: "yours", s: short(about(e.to, abs(e.to))) ?? "A subagent.", f: [[e.to, "The definition.", sealed(e.to) ? "outside" : "live"]] })),
};

// Plugins, each with what it provides.
const plugins = out(ROOT, "enables").map((e) => {
  const n = N.get(e.to), name = e.to.replace(/^plugin:/, "");
  const kids = out(e.to, "provides").map((p) => N.get(p.to).kind === "skill" ? skillNode(p.to, "skill") : tnode(p.to, { t: base(p.to).replace(/\.md$/, ""), k: "subagent", s: short(about(p.to, abs(p.to))) ?? "A subagent.", f: [[p.to, "Ships with the plugin.", sealed(p.to) ? "outside" : "gen"]] })).sort((a, b) => a.t.localeCompare(b.t));
  const pluginHooks = out(e.to, "wires").length;
  return tnode(e.to, {
    t: name.split("@")[0], k: `${n.skills ?? 0} skills · ${n.agents ?? 0} agents${pluginHooks ? ` · ${pluginHooks} hooks` : ""}`,
    s: `${name}, enabled in your settings.${n.installed ? "" : " Not found in the install registry."}`,
    st: n.installed ? undefined : "missing",
    c: kids.length ? groupSkills(kids, "items") : undefined,
  });
});
const pluginsArea = { id: "plugins", br: "workflow", t: "Plugins", k: `${plugins.length} enabled`, s: "Packages of skills, subagents and hooks, turned on by enabledPlugins in settings. Their files live in the plugin cache; an update replaces them.", c: plugins };
for (const e of out(ROOT, "enables")) {
  const pid = idOf.get(e.to), name = e.to.replace(/^plugin:/, "");
  for (const s of settingsLoads) if ((read(abs(s.to)) ?? "").includes(`"${name}"`)) link(idOf.get(s.to), pid, "flow", "enables it");
}

// MCP servers.
const conns = E.filter((e) => e.type === "connects");
const mcp = {
  id: "mcp", br: "records", t: "MCP servers", k: `${conns.length} connected`,
  s: "Tool servers Claude Code starts or connects to. Only names and transport are shown; commands, arguments and credentials stay off this page.",
  c: conns.filter((e) => !idOf.has(e.to)).map((e) => tnode(e.to, { t: e.to.replace(/^mcp:/, ""), k: `${N.get(e.to).transport ?? "stdio"} · ${e.scope}`, s: `Configured at ${e.scope} scope${e.from === ROOT ? " in ~/.claude.json" : ` in ${e.from}`}.` })),
};
for (const e of conns) link(idOf.get(e.to), "home", "use", "tools offered to the session");

const areas = [instructions, settings, hooks, skills, agents, pluginsArea, mcp].filter((a) => a.c && a.c.length);
const sweep = (n) => { for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k]; (n.c || []).forEach(sweep); return n; };
const TREE = sweep({
  id: "home", br: "root", t: "Claude Code", k: G.cwd.replace(HOME, "~"),
  s: `What a Claude Code session loads when it starts in ${G.cwd.replace(HOME, "~")} on this machine: instructions, settings, hooks, skills, subagents, plugins and MCP servers.`,
  b: ["Found by reading the files Claude Code reads, following every @import and symlink. Links on this map are proven: each one is an import, a symlink, a hook wiring or a settings entry the discovery script found.", "Descriptions come from each file's own heading or frontmatter. Nothing here is a model's summary yet."],
  c: areas,
});
// ---- model pass: inferred summaries ----
// Skills and subagents already carry their author's description, so only the rest is summarized.
const SUMMARIZE = new Set(["memory", "settings", "hook", "plugin", "mcp"]);
const SUMMARIES = (() => { try { return JSON.parse(read(flag("--summaries"))) ?? {}; } catch { return {}; } })();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const treeNode = new Map(); (function w(n) { treeNode.set(n.id, n); (n.c || []).forEach(w); })(TREE);
const requests = [];
let applied = 0;
for (const [gid, tid] of idOf) {
  const g = N.get(gid);
  if (!g || !SUMMARIZE.has(g.kind) || g.missing || sealed(gid) || out(gid, "links-to").length) continue;
  const text = g.kind === "plugin" || g.kind === "mcp" ? null : read(abs(gid));
  const hash = sha(text ?? gid);
  const have = SUMMARIES[gid];
  if (have && have.hash === hash) { treeNode.get(tid).si = have.text; applied++; continue; }
  requests.push({ id: gid, kind: g.kind, title: treeNode.get(tid).t, path: text == null ? null : abs(gid), hash, stale: Boolean(have) });
}
// Outputs name your paths and setup: readable by you only (on Windows this only keeps them writable).
const writePrivate = (p, text) => { fs.writeFileSync(p, text, { mode: 0o600 }); try { fs.chmodSync(p, 0o600); } catch {} };
if (flag("--request")) writePrivate(flag("--request"), JSON.stringify(requests, null, 1) + "\n");
if (applied) TREE.b[1] = `Descriptions come from each file's own heading or frontmatter. ${applied} lines marked Inferred were written by Claude from the file itself; check the file before relying on one.`;
console.log(`summaries: ${applied} applied, ${requests.length} still needed${requests.some((q) => q.stale) ? ` (${requests.filter((q) => q.stale).length} stale)` : ""}`);

const valid = new Set(); (function w(n) { valid.add(n.id); (n.c || []).forEach(w); })(TREE);
// The renderer cannot route a link to the root (its rep() walks past the top), so the tree alone shows what loads.
const goodLinks = LINKS.filter((l) => valid.has(l[0]) && valid.has(l[1]) && l[0] !== l[1] && l[0] !== "home" && l[1] !== "home");

const KNOBS = [
  { t: "Instructions", br: "rules", s: "The files whose text the model reads every session.", f: [...idOf].filter(([g]) => N.get(g)?.kind === "memory" && !N.get(g).missing && !out(g, "links-to").length && !inPluginCache(g) && !sealed(g)).map(([g]) => [g, "Read at session start.", "live"]) },
  { t: "Settings", br: "claude", s: "Permissions, environment, hooks and plugins.", f: settingsLoads.filter((e) => !sealed(e.to)).map((e) => [e.to, SCOPE[e.scope] ?? e.scope, "live"]) },
  { t: "Hooks", br: "trust", s: "Scripts that run at fixed moments.", f: [...new Set(wires.map((e) => e.to))].filter((g) => !inPluginCache(g) && !sealed(g) && !g.startsWith("hook:")).map((g) => [g, "A hook script.", "live"]) },
  { t: "Your skills", br: "skills", s: "Skills you can edit directly.", f: mySkills.map((s) => s.f[0]).filter((f) => f[2] !== "outside") },
].filter((g) => g.f.length);

// ---- fill the renderer ----
const AFTER = {
  live: { cmd: null, say: "Edit it in place. The next session that starts here picks it up." },
  skills: { cmd: null, say: "Edit SKILL.md in place. The next session lists the change." },
  gen: { cmd: null, say: "Don't edit this copy: it is a link or ships with a plugin. Change what it points to." },
  outside: { cmd: null, say: "A project or plugin points here, outside itself. Atlas leaves it unopened." },
  doc: { cmd: null, say: "" },
};
// The page loads nothing from the network: d3 and the fonts are inlined, and a Content-Security-Policy
// allows only this page's own scripts (by hash), so injected markup can neither run nor send data out.
const vendor = (f) => new URL(`../renderer/vendor/${f}`, import.meta.url);
const fonts = fs.readFileSync(vendor("fonts.css"), "utf8").replace(/url\(([\w.-]+\.woff2)\)/g, (_, f) => `url(data:font/woff2;base64,${fs.readFileSync(vendor(f)).toString("base64")})`);
const d3 = fs.readFileSync(vendor("d3.min.js"), "utf8");
// Data sits inside an inline script: escape "<" so no file name, heading or summary can close the tag.
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const template = fs.readFileSync(new URL("../renderer/atlas.html", import.meta.url), "utf8");
for (const marker of ["/*@ATLAS_DATA@*/", "/*@FONTS@*/", "/*@D3@*/"]) if (!template.includes(marker)) throw new Error(`renderer/atlas.html has no ${marker} marker`);
const data =
  `const REPO = null;\nconst LOCAL = ${js(G.home + "/")};\nconst GENERATED = ${js(G.generated)};\n` +
  `const AFTER = ${js(AFTER)};\n` +
  `const TREE = ${js(TREE)};\nconst KNOBS = ${js(KNOBS)};\nconst LINKS = ${js(goodLinks)};\n`;
let page = template.replace("/*@ATLAS_DATA@*/", () => data).replace("/*@FONTS@*/", () => fonts).replace("/*@D3@*/", () => d3);
const hashes = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
const csp = `default-src 'none'; script-src ${hashes.join(" ")}; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`;
page = page.replace('<meta charset="utf-8">', () => `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writePrivate(outPath, page);
try { fs.chmodSync(graphPath, 0o600); } catch {}
console.log(`${valid.size} nodes, ${goodLinks.length} links, ${areas.length} areas → ${outPath}`);
