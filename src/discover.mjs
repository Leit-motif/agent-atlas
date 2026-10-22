#!/usr/bin/env node
// Map what Claude Code and Codex load for one user in one folder.
// Emits a graph of files (nodes) and proven links (edges). Reads paths and
// structure only; config values (env, headers, args) are never emitted.
//
//   node src/discover.mjs [--home DIR] [--cwd DIR] [--no-system] [--json]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
// Real paths, so a home or project reached through a symlink (macOS /var → /private/var) still matches.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const HOME = real(opt("--home", os.homedir()));
const CWD = real(opt("--cwd", process.cwd()));
const SYSTEM = !argv.includes("--no-system");
const CODEX_HOME = process.env.CODEX_HOME && !argv.includes("--home") ? process.env.CODEX_HOME : path.join(HOME, ".codex");

const nodes = new Map();
const edges = [];
const notes = [];

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p);
const show = (id) => (GIT && id.startsWith(GIT + path.sep) ? "<repo>" + id.slice(GIT.length) : id);
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const lstatLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

function node(id, kind, extra = {}) {
  if (!nodes.has(id)) nodes.set(id, { id, kind, ...extra });
  else Object.assign(nodes.get(id), extra);
  return id;
}
const edgeKeys = new Set();
const edge = (from, to, type, extra = {}) => {
  const key = `${from}|${to}|${type}`;
  if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ from, to, type, ...extra }); }
};

// A file node; a symlink becomes link -> real target, so the graph shows where it points.
function fileNode(p, kind) {
  const id = tilde(p);
  if (!exists(p) && !lstatLink(p)) return node(id, kind, { missing: true });
  node(id, kind);
  if (lstatLink(p)) {
    let real;
    try { real = fs.realpathSync(p); } catch { return node(id, kind, { brokenLink: true }); }
    node(id, kind, { link: true });
    edge(id, node(tilde(real), kind), "links-to");
    return id;
  }
  return id;
}
const realId = (p) => { try { return tilde(fs.realpathSync(p)); } catch { return tilde(p); } };

// ---- memory files and @imports (Claude Code) ----
// Imports outside code spans/fences, preceded by start or whitespace (so emails don't match).
function importsOf(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const bare = line.replace(/`[^`]*`/g, "");
    for (const m of bare.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-~/]+)/g)) out.push(m[1].replace(/[.,;:)]+$/, ""));
  }
  return out;
}
function walkImports(p, depth = 0, seen = new Set()) {
  const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })();
  if (seen.has(real) || depth > 5) return;
  seen.add(real);
  const text = read(real);
  if (text == null) return;
  for (const ref of importsOf(text)) {
    const target = ref.startsWith("~/") ? path.join(HOME, ref.slice(2)) : path.resolve(path.dirname(real), ref);
    const looksLikeFile = /\.\w{1,6}$/.test(ref) || ref.includes("/");
    if (!isFile(target) && !looksLikeFile) continue; // prose like @mention, not an import
    const to = fileNode(target, "memory");
    edge(realId(p), to, "imports", { as: "@" + ref, tool: "claude-code" }); // Codex reads files verbatim
    if (isFile(target)) walkImports(target, depth + 1, seen);
  }
}
function memory(session, p, scope) {
  if (!exists(p) && !lstatLink(p)) return;
  if (edges.some((e) => e.from === session && e.type === "loads" && e.to === tilde(p))) return; // e.g. ~/.claude/CLAUDE.md met again walking up through home
  const id = fileNode(p, "memory");
  edge(session, id, "loads", { scope });
  walkImports(p);
}

// Directories from CWD up to the filesystem root, outermost first.
const ancestors = (() => { const a = []; let d = CWD; for (;;) { a.unshift(d); const up = path.dirname(d); if (up === d) break; d = up; } return a; })();
const gitRoot = [...ancestors].reverse().find((d) => exists(path.join(d, ".git"))) ?? CWD;
const GIT = tilde(gitRoot);

function settingsFile(session, p, scope) {
  if (!exists(p)) return null;
  const id = fileNode(p, "settings");
  edge(session, id, "loads", { scope });
  let json;
  try { json = JSON.parse(read(p)); } catch { node(id, "settings", { unparsed: true }); return null; }
  hooksOf(id, json.hooks);
  if (json.env) node(id, "settings", { envKeys: Object.keys(json.env).length }); // count only
  return json;
}

// A hook command: link to every existing file path it names.
function hooksOf(fromId, hooks, pluginRoot) {
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) {
      if (h.type !== "command" || !h.command) continue;
      const cmd = h.command.replace(/\$HOME|\$\{HOME\}/g, HOME).replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, pluginRoot ?? "$CLAUDE_PLUGIN_ROOT");
      const paths = [...cmd.matchAll(/["']?((?:~|\/)[^"'\s]+)["']?/g)].map((m) => m[1].replace(/^~/, HOME).replace(/[\\"']+$/, "")).filter(isFile);
      if (!paths.length) { const id = node(`hook:${event}:${cmd.split(/\s/)[0]}`, "hook", { event }); edge(fromId, id, "wires", { event, matcher: g.matcher }); continue; }
      for (const p of paths) edge(fromId, fileNode(p, "hook"), "wires", { event, matcher: g.matcher });
    }
  }
}

function skillsIn(owner, dir, tool) {
  let n = 0;
  for (const e of ls(dir)) {
    const p = path.join(dir, e.name, "SKILL.md");
    if (!isFile(p)) continue;
    const id = fileNode(path.join(dir, e.name), "skill");
    node(id, "skill", { name: e.name, tool });
    edge(owner, id, "provides");
    n++;
  }
  return n;
}

// ================= Claude Code =================
const CC = node("session:claude-code", "session", { tool: "claude-code", cwd: tilde(CWD) });

if (SYSTEM) {
  for (const p of ["/Library/Application Support/ClaudeCode/CLAUDE.md", "/etc/claude-code/CLAUDE.md"]) memory(CC, p, "managed");
  for (const p of ["/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"]) settingsFile(CC, p, "managed");
}
memory(CC, path.join(HOME, ".claude/CLAUDE.md"), "user");
for (const e of ls(path.join(HOME, ".claude/rules"))) if (e.name.endsWith(".md")) memory(CC, path.join(HOME, ".claude/rules", e.name), "user-rules");
for (const d of ancestors) {
  memory(CC, path.join(d, "CLAUDE.md"), d === CWD ? "project" : "ancestor");
  memory(CC, path.join(d, ".claude/CLAUDE.md"), d === CWD ? "project" : "ancestor");
  memory(CC, path.join(d, "CLAUDE.local.md"), "local");
}
for (const e of ls(path.join(CWD, ".claude/rules"))) if (e.name.endsWith(".md")) memory(CC, path.join(CWD, ".claude/rules", e.name), "project-rules");
// Auto memory: one folder per project, keyed by the project path with separators turned into dashes.
memory(CC, path.join(HOME, ".claude/projects", gitRoot.replace(/[^A-Za-z0-9]/g, "-"), "memory/MEMORY.md"), "auto-memory");

const userSettings = settingsFile(CC, path.join(HOME, ".claude/settings.json"), "user");
const projSettings = [settingsFile(CC, path.join(CWD, ".claude/settings.json"), "project"), settingsFile(CC, path.join(CWD, ".claude/settings.local.json"), "local")];

// Skills and agents, user and project.
const ccUserSkills = skillsIn(CC, path.join(HOME, ".claude/skills"), "claude-code");
skillsIn(CC, path.join(CWD, ".claude/skills"), "claude-code");
for (const dir of [path.join(HOME, ".claude/agents"), path.join(CWD, ".claude/agents")]) {
  for (const e of ls(dir)) if (e.name.endsWith(".md")) edge(CC, fileNode(path.join(dir, e.name), "agent"), "provides");
}

// Plugins: enabled in settings, resolved through the install registry; each one's skills fold under it.
const enabled = Object.assign({}, userSettings?.enabledPlugins, ...projSettings.map((s) => s?.enabledPlugins));
const registry = (() => { try { return JSON.parse(read(path.join(HOME, ".claude/plugins/installed_plugins.json"))).plugins ?? {}; } catch { return {}; } })();
for (const [name, on] of Object.entries(enabled)) {
  if (!on) continue;
  const install = registry[name]?.[0]?.installPath;
  const id = node(`plugin:${name}`, "plugin", { tool: "claude-code", installed: Boolean(install) });
  edge(CC, id, "enables");
  if (!install) continue;
  const skills = skillsIn(id, path.join(install, "skills"), "claude-code");
  let agents = 0;
  for (const e of ls(path.join(install, "agents"))) if (e.name.endsWith(".md")) { agents++; edge(id, fileNode(path.join(install, "agents", e.name), "agent"), "provides"); }
  const hooks = read(path.join(install, "hooks/hooks.json"));
  if (hooks) {
    try {
      const h = JSON.parse(hooks);
      hooksOf(id, h.hooks, install);
      // Function hooks: TypeScript modules loaded in-process (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).
      for (const m of h.modules ?? []) edge(id, fileNode(path.resolve(install, "hooks", m), "hook"), "wires", { event: "module" });
    } catch {}
  }
  node(id, "plugin", { skills, agents, folded: true });
}

// MCP servers: names and transport only.
function mcp(owner, servers, scope) {
  for (const [name, s] of Object.entries(servers ?? {})) {
    const id = node(`mcp:${name}`, "mcp", { transport: s.type ?? (s.url ? "http" : "stdio") });
    edge(owner, id, "connects", { scope });
  }
}
const claudeJson = (() => { try { return JSON.parse(read(path.join(HOME, ".claude.json"))); } catch { return null; } })();
mcp(CC, claudeJson?.mcpServers, "user");
mcp(CC, claudeJson?.projects?.[CWD]?.mcpServers, "local");
const dotMcp = read(path.join(CWD, ".mcp.json"));
if (dotMcp) { const id = fileNode(path.join(CWD, ".mcp.json"), "settings"); edge(CC, id, "loads", { scope: "project" }); try { mcp(id, JSON.parse(dotMcp).mcpServers, "project"); } catch {} }

// ================= Codex =================
const CX = node("session:codex", "session", { tool: "codex", cwd: tilde(CWD) });
const toml = read(path.join(CODEX_HOME, "config.toml")) ?? "";
if (toml) edge(CX, fileNode(path.join(CODEX_HOME, "config.toml"), "settings"), "loads", { scope: "user" });
// Light TOML read: section headers and the fallback-filename list, nothing else.
const fallback = (toml.match(/^project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
const pick = (d) => ["AGENTS.override.md", "AGENTS.md", ...fallback].map((f) => path.join(d, f)).find((p) => exists(p));

const globalDoc = [path.join(CODEX_HOME, "AGENTS.override.md"), path.join(CODEX_HOME, "AGENTS.md")].find((p) => exists(p));
if (globalDoc) edge(CX, fileNode(globalDoc, "memory"), "loads", { scope: "user" });
for (const d of ancestors.slice(ancestors.indexOf(gitRoot))) {
  const p = pick(d);
  if (p) edge(CX, fileNode(p, "memory"), "loads", { scope: d === CWD ? "project" : "ancestor" });
}
const cxHooks = read(path.join(CODEX_HOME, "hooks.json"));
if (cxHooks) { const id = fileNode(path.join(CODEX_HOME, "hooks.json"), "settings"); edge(CX, id, "loads", { scope: "user" }); try { hooksOf(id, JSON.parse(cxHooks).hooks); } catch {} }
for (const e of ls(path.join(CODEX_HOME, "rules"))) if (e.name.endsWith(".rules")) edge(CX, fileNode(path.join(CODEX_HOME, "rules", e.name), "policy"), "loads", { scope: "user" });
for (const m of toml.matchAll(/^\[mcp_servers\.("?)([^\]."]+)\1\]\s*$/gm)) edge(CX, node(`mcp:${m[2]}`, "mcp"), "connects", { scope: "user" });
for (const m of toml.matchAll(/^\[plugins\."([^"]+)"\]/gm)) edge(CX, node(`plugin:${m[1]}`, "plugin", { tool: "codex", folded: true }), "enables");
skillsIn(CX, path.join(CODEX_HOME, "skills"), "codex");
skillsIn(CX, path.join(HOME, ".agents/skills"), "codex");
skillsIn(CX, path.join(gitRoot, ".agents/skills"), "codex");
// Codex search order (AGENTS.override.md, fallbacks, ~/.agents/skills) is unconfirmed; the page does not draw Codex yet.

// ================= output =================
// A memory file both tools load is one node with two incoming loads; that overlap is the interesting part.
const graph = { home: HOME, cwd: CWD, gitRoot, generated: new Date().toISOString(), nodes: [...nodes.values()], edges, notes };
if (argv.includes("--json")) { process.stdout.write(JSON.stringify(graph, null, 1) + "\n"); process.exit(0); }

const by = (t) => edges.filter((e) => e.type === t);
const kinds = {}; for (const n of nodes.values()) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
console.log(`repo ${GIT}  ·  cwd ${show(tilde(CWD))}  ·  ${nodes.size} nodes, ${edges.length} edges  ·  ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ")}`);
const children = (id, types, tool) => edges.filter((e) => e.from === id && (!types || types.includes(e.type)) && (!tool || !e.tool || e.tool === tool));
function tree(id, indent, seen, tool) {
  for (const e of children(id, ["imports", "links-to", "wires", "connects"], tool)) {
    const n = nodes.get(e.to);
    const flag = n.missing ? "  [MISSING]" : n.brokenLink ? "  [BROKEN LINK]" : "";
    console.log(`${indent}${{ "links-to": "→", wires: "⚑", connects: "⇄", imports: "@" }[e.type]} ${show(e.to)}${e.event ? `  (${e.event})` : ""}${flag}`);
    if (!seen.has(e.to)) { seen.add(e.to); tree(e.to, indent + "   ", seen, tool); }
  }
}
for (const s of [CC, CX]) {
  console.log(`\n${s}`);
  for (const e of children(s, ["loads"])) {
    const n = nodes.get(e.to);
    console.log(`  [${e.scope}] ${show(e.to)}${n.envKeys ? `  (${n.envKeys} env keys, values withheld)` : ""}`);
    tree(e.to, "     ", new Set([e.to]), nodes.get(s).tool);
  }
  const count = (k) => edges.filter((e) => nodes.get(e.to).kind === k && (e.from === s || children(s, ["loads"]).some((l) => l.to === e.from))).length;
  const plugins = children(s, ["enables"]).map((e) => nodes.get(e.to));
  console.log(`  skills ${count("skill")} · agents ${count("agent")} · mcp ${count("mcp")} · plugins ${plugins.length}` +
    (plugins.some((p) => p.skills != null) ? ` (${plugins.reduce((a, p) => a + (p.skills ?? 0), 0)} plugin skills folded)` : ""));
}
const both = [...nodes.keys()].filter((id) => {
  const reach = (root) => { const s = new Set([root]); let grew = true; while (grew) { grew = false; for (const e of edges) if (s.has(e.from) && !s.has(e.to) && ["loads", "imports", "links-to"].includes(e.type) && (!e.tool || e.tool === nodes.get(root).tool)) { s.add(e.to); grew = true; } } return s; };
  return reach(CC).has(id) && reach(CX).has(id) && nodes.get(id).kind === "memory";
});
console.log(`\nreached by both tools: ${both.length ? both.map(show).join(", ") : "none"}`);
const missing = [...nodes.values()].filter((n) => n.missing || n.brokenLink);
if (missing.length) console.log(`missing or broken: ${missing.map((n) => n.id).join(", ")}`);
for (const n of notes) console.log(`note: ${n}`);
