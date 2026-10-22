#!/usr/bin/env node
// Builds a made-up but typical Claude Code setup in a temp folder and renders its Atlas to
// out/demo.html, so the page can be shown without anyone's real configuration.
//   node scripts/demo.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = new URL("..", import.meta.url).pathname;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-atlas-demo-")));
const home = path.join(root, "home"), proj = path.join(home, "code", "storefront");
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const skill = (dir, name, description) => put(`${dir}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);

// Instructions: a user file with two imports, a project file shared with Codex, a local file.
put(`${home}/.claude/CLAUDE.md`, "# How I work\n\n@~/.claude/style.md\n@~/.claude/tools.md\n");
put(`${home}/.claude/style.md`, "# Style\n\nLead with the answer. Short sentences.\n");
put(`${home}/.claude/tools.md`, "# Tools\n\nUse pnpm, not npm. Run tests before committing.\n");
fs.mkdirSync(`${proj}/.git`, { recursive: true });
put(`${proj}/CLAUDE.md`, "# Storefront\n\n@AGENTS.md\n@docs/architecture.md\n");
put(`${proj}/AGENTS.md`, "# Storefront rules\n\nNext.js app, Postgres, Stripe in test mode only.\n");
put(`${proj}/docs/architecture.md`, "# Architecture\n\nApp router, server actions, one Postgres database.\n");
put(`${proj}/CLAUDE.local.md`, "# My local notes\n\nThe staging database is read-only for me.\n");

// Settings with three hooks, and their scripts.
for (const h of ["format.sh", "block-force-push.sh", "notify.sh"]) put(`${home}/.claude/hooks/${h}`, "#!/bin/sh\n");
put(`${home}/.claude/settings.json`, JSON.stringify({
  env: { EXAMPLE_TOKEN: "not-a-real-value" },
  enabledPlugins: { "release-kit@example-marketplace": true },
  hooks: {
    PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "$HOME/.claude/hooks/format.sh" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "$HOME/.claude/hooks/block-force-push.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/notify.sh" }] }],
  },
}, null, 2));

// Skills, a subagent, a plugin, and MCP servers.
skill(`${home}/.claude/skills`, "code-review", "Review a diff for bugs, missing tests and unclear names before it ships.");
skill(`${home}/.claude/skills`, "write-tests", "Write behavior tests for a change, starting from what the user sees.");
skill(`${home}/.claude/skills`, "debug", "Reproduce a bug, find its root cause, then fix it there.");
skill(`${home}/.claude/skills`, "research", "Answer a question from primary sources and cite them.");
skill(`${proj}/.claude/skills`, "db-migration", "Write and check a Postgres migration for the storefront.");
put(`${home}/.claude/agents/reviewer.md`, "---\nname: reviewer\ndescription: A second reader for diffs it did not write.\n---\n");
const plugin = `${home}/.claude/plugins/cache/example-marketplace/release-kit/1.0.0`;
skill(`${plugin}/skills`, "changelog", "Draft a changelog entry from merged pull requests.");
skill(`${plugin}/skills`, "release-notes", "Turn a changelog into release notes for users.");
put(`${home}/.claude/plugins/installed_plugins.json`, JSON.stringify({ version: 2, plugins: { "release-kit@example-marketplace": [{ installPath: plugin }] } }));
put(`${home}/.claude.json`, JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.invalid/mcp" } } }));
put(`${proj}/.mcp.json`, JSON.stringify({ mcpServers: { postgres: { command: "npx", args: ["postgres-mcp"] } } }));

// Discover, then fill a few inferred summaries so the page shows how they look.
const out = path.join(repo, "out"), graph = path.join(out, "demo-graph.json"), req = path.join(out, "demo-request.json"), sum = path.join(out, "demo-summaries.json");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(graph, execFileSync("node", [`${repo}src/discover.mjs`, "--home", home, "--cwd", proj, "--no-system", "--json"]));
const build = (...args) => execFileSync("node", [`${repo}src/build.mjs`, graph, path.join(out, "demo.html"), ...args], { encoding: "utf8" });
build("--request", req);
const TEXT = { // keyed by path suffix, since two files are both called CLAUDE.md
  ".claude/CLAUDE.md": "Sets how you like answers written and which tools to prefer, through two imported files.",
  "storefront/AGENTS.md": "The storefront's rules, shared by Claude Code and Codex: the stack, and that Stripe stays in test mode.",
  ".claude/settings.json": "Your user settings: one plugin, one environment variable, and three hooks that format edits, block force-pushes and notify you when Claude stops.",
  "hooks/block-force-push.sh": "Stops any git push --force before it runs.",
};
const asked = JSON.parse(fs.readFileSync(req, "utf8"));
fs.writeFileSync(sum, JSON.stringify(Object.fromEntries(asked.flatMap((q) => { const k = Object.keys(TEXT).find((s) => q.id.endsWith(s)); return k ? [[q.id, { hash: q.hash, text: TEXT[k] }]] : []; }))));
process.stdout.write(build("--summaries", sum));
fs.rmSync(root, { recursive: true, force: true });
