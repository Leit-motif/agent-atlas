// Builds a small fake home and project in a temp folder, then checks what discover.mjs finds
// and what build.mjs writes. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const SECRETS = ["sk-live-FIXTURESECRET", "tok-FIXTURESECRET"];

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-atlas-")));
  const home = path.join(root, "home"), proj = path.join(root, "proj"), cwd = path.join(proj, "app");
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  put(`${home}/.claude/CLAUDE.md`, "# Me\nUse @~/notes/style.md for tone.\nNot an import: `@inline.md`, nor mail me at a@b.com.\nAlso @gone.md\n```\n@fenced.md\n```\n");
  put(`${home}/notes/style.md`, "# Style\nSee @./deeper.md\n");
  put(`${home}/notes/deeper.md`, "# Deeper\n");
  put(`${home}/hooks/guard.sh`, "#!/bin/sh\n");
  put(`${home}/.claude/skills/tidy/SKILL.md`, "---\nname: tidy\ndescription: Tidies things up.\n---\n");
  put(`${home}/.claude/skills/crlf/SKILL.md`, "---\r\nname: crlf\r\ndescription: Saved with Windows line endings.\r\n---\r\n");
  put(`${home}/.claude/settings.json`, JSON.stringify({ env: { OPENAI_API_KEY: SECRETS[0] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'sh "$HOME/hooks/guard.sh"' }] }] } }));
  fs.mkdirSync(`${home}/.codex`, { recursive: true });
  // Windows needs Developer Mode or admin to make a symlink; without it the symlink check is skipped.
  let symlinks = true;
  try { fs.symlinkSync("../notes/style.md", `${home}/.codex/AGENTS.md`); } catch (e) { if (e.code !== "EPERM") throw e; symlinks = false; }
  put(`${proj}/CLAUDE.md`, "@AGENTS.md\n");
  put(`${proj}/AGENTS.md`, "# Project rules\n");
  fs.mkdirSync(`${proj}/.git`);
  put(`${cwd}/AGENTS.override.md`, "# App override\n");
  put(`${cwd}/.mcp.json`, JSON.stringify({ mcpServers: { tracker: { command: "npx", args: ["tracker-mcp"], env: { TRACKER_TOKEN: SECRETS[1] } } } }));
  return { root, home, proj, cwd, symlinks };
}

const discover = (fx) => execFileSync(process.execPath, [SRC + "discover.mjs", "--home", fx.home, "--cwd", fx.cwd, "--no-system", "--json"], { encoding: "utf8" });
const build = (fx, ...args) => execFileSync(process.execPath, [SRC + "build.mjs", path.join(fx.root, "graph.json"), path.join(fx.root, "atlas.html"), ...args], { encoding: "utf8" });

test("discover finds what Claude Code loads, and only that", () => {
  const fx = fixture();
  const g = JSON.parse(discover(fx));
  const edge = (from, to, type) => g.edges.some((e) => e.from === from && e.to === to && e.type === type);
  const proj = fx.proj.split(path.sep).join("/"); // ids use "/" on every OS

  assert.ok(edge("session:claude-code", "~/.claude/CLAUDE.md", "loads"));
  assert.ok(edge("~/.claude/CLAUDE.md", "~/notes/style.md", "imports"));
  assert.ok(edge("~/notes/style.md", "~/notes/deeper.md", "imports"), "imports are followed recursively");
  assert.ok(g.nodes.find((n) => n.id === "~/.claude/gone.md")?.missing, "a missing import is flagged");
  for (const ref of ["inline.md", "fenced.md", "b.com"]) assert.ok(!g.nodes.some((n) => n.id.endsWith(ref)), `${ref} is not an import`);
  assert.ok(edge(`${proj}/CLAUDE.md`, `${proj}/AGENTS.md`, "imports"));
  assert.ok(edge("~/.claude/settings.json", "~/hooks/guard.sh", "wires"), "a hook command is traced to its script");
  assert.ok(g.nodes.some((n) => n.id === "mcp:tracker"));
  if (fx.symlinks) assert.ok(edge("~/.codex/AGENTS.md", "~/notes/style.md", "links-to"), "a symlink is traced to its target");
  assert.ok(g.nodes.every((n) => !n.id.includes("\\")) && !g.home.includes("\\"), "ids use / even on Windows");
  assert.ok(g.edges.filter((e) => e.type === "imports").every((e) => e.tool === "claude-code"), "@imports belong to Claude Code only");
  for (const s of SECRETS) assert.ok(!JSON.stringify(g).includes(s), "config values never reach the graph");
});

test("build writes the page, keeps secrets out, and drops stale summaries", () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "graph.json"), discover(fx));
  const req = path.join(fx.root, "request.json"), sum = path.join(fx.root, "summaries.json");

  build(fx, "--request", req);
  const html = fs.readFileSync(path.join(fx.root, "atlas.html"), "utf8");
  assert.ok(html.includes("<title>Claude Code Atlas</title>") && !html.includes("/*@ATLAS_DATA@*/"));
  for (const s of SECRETS) assert.ok(!html.includes(s), "config values never reach the page");
  assert.ok(!/const LINKS = .*"home"/.test(html), "no link targets the root, which the renderer cannot route");
  assert.ok(html.includes("Saved with Windows line endings."), "CRLF frontmatter is read");

  // Answer every request, then change one file: only that summary is asked for again.
  const asked = JSON.parse(fs.readFileSync(req, "utf8"));
  assert.ok(asked.some((q) => q.id === "~/notes/style.md"));
  fs.writeFileSync(sum, JSON.stringify(Object.fromEntries(asked.map((q) => [q.id, { hash: q.hash, text: `About ${q.title}.` }]))));
  assert.match(build(fx, "--summaries", sum, "--request", req), new RegExp(`${asked.length} applied, 0 still needed`));
  fs.appendFileSync(path.join(fx.home, "notes/style.md"), "# changed\n");
  assert.match(build(fx, "--summaries", sum, "--request", req), /1 still needed \(1 stale\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(req, "utf8")).map((q) => q.id), ["~/notes/style.md"]);
  assert.ok(fs.readFileSync(path.join(fx.root, "atlas.html"), "utf8").includes("About CLAUDE.md."), "fresh summaries still show");
});
