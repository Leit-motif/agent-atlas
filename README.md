# agent-atlas

**See everything Claude Code loads before it reads your first message.**

Every session quietly loads a stack of things: your `CLAUDE.md`, the files it `@`-imports, project
rules from every parent folder, settings at three levels, hooks, skills, subagents, plugins and MCP
servers. agent-atlas finds all of them on your machine and draws them as one map you can fold,
search and click through.

![The Atlas for a sample project: opening Instructions shows the files they import, opening Hooks leads to a hook that blocks force-pushes and the settings file that wires it, then the Files view lists every file you can edit](docs/atlas-demo.gif)

*A made-up project. [Full-quality video (MP4)](docs/atlas-demo.mp4). Your own map stays on your machine.*

## Install

In Claude Code (2.1.275 or later):

```text
/plugin install agent-atlas --marketplace Leit-motif/agent-atlas
```

### Update

Ask Claude: *"Update the agent-atlas plugin."* Or run it yourself:

```bash
claude plugin marketplace update agent-atlas
claude plugin update agent-atlas@agent-atlas
```

Then restart Claude Code. The new version loads in the next session.

> **For agents updating this plugin:** run the two commands above in a shell, in that order. The
> first pulls the latest plugin list from GitHub; without it the second finds nothing new. Success
> prints `updated from <old> to <new>`, or `already at the latest version`. You cannot restart
> Claude Code yourself: tell the user to restart it. If `claude` is not on the PATH, tell the user
> to update from the `/plugin` menu instead.

## Use

Open Claude Code in any project and run:

```text
/agent-atlas:atlas
```

Or just ask: *"Map what Claude Code loads here."* Claude finds every file, writes a one-line
summary of each, and opens the map in your browser. The page and its data are saved under
`~/.claude/agent-atlas/`, never inside your project. Run it again after changing your setup; only
files that changed get new summaries.

Every file you can change has **Open in editor** (VS Code, Cursor or VSCodium; the page remembers
your pick) and **Copy path** for anything else.

Needs Node 20 or later. Nothing else to install.

### Without Claude

The scripts also run on their own, without summaries:

```bash
git clone https://github.com/Leit-motif/agent-atlas && cd agent-atlas
```

```bash
node src/discover.mjs --cwd /path/to/your/project --json > graph.json
```

```bash
node src/build.mjs graph.json atlas.html
```

## What it finds

| Area | Where it looks |
|---|---|
| Instructions | `~/.claude/CLAUDE.md`, `~/.claude/rules/`, every `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` from your project up to `/`, project `.claude/rules/`, Claude's auto memory, managed policy files |
| Imports | Every `@path` in those files, followed recursively, skipping code blocks and inline code. Missing imports are flagged. |
| Settings | User, project and local `settings.json`, plus `.mcp.json` |
| Hooks | Each hook command traced to the script it runs, including plugin hooks and function-hook modules |
| Skills and subagents | `~/.claude/skills`, `.claude/skills`, `~/.claude/agents`, `.claude/agents`, with each one's own description |
| Plugins | Enabled plugins, resolved through the install registry, with their skills, agents and hooks |
| MCP servers | Names and transport from `~/.claude.json` and `.mcp.json` |

Symlinks are followed to the real file, so a shared rules file shows up once, wherever it lives.

## What it never shows

Discovery reads structure, not secrets. Environment variable values, MCP commands, arguments,
headers and tokens never reach the graph or the page; only names and counts do. The tests plant
fake secrets and fail if one leaks.

The page makes no network requests. Its scripts and fonts are bundled into the file, and a
Content-Security-Policy lets only its own two scripts run and blocks every connection out, so
nothing in a file it maps can run code or send your setup anywhere.

## Every line is proven, every summary is labelled

The lines on the map are things the script found: an import, a symlink, a hook wiring, a plugin
enabled in settings. Nothing is guessed.

Card text starts as each file's own heading or frontmatter. When you run the skill, Claude reads
each file and adds one plain sentence about what it does. Those lines show with an **Inferred**
label beside what the script found, so you can always tell Claude's words from the file's. Each summary is tied to
its file's contents, so when a file changes, its summary drops off and is requested again instead of
going stale.

## Status

Early. Claude Code only for now; `discover.mjs` also reads Codex's files, but the page doesn't
draw them yet. Works on macOS, Linux and Windows 10 or later.

MIT licensed.
