# Security

agent-atlas reads your Claude Code setup and draws it. It is built so that mapping a project you
don't trust is safe.

## What it does

- **Reads** the files Claude Code reads at session start, plus anything they import, link to or
  name in a hook command, to learn paths and structure.
- **Writes** only to `~/.claude/agent-atlas/<project>/`: `graph.json`, `request.json`,
  `summaries.json` and `atlas.html`, readable by you only.
- **Never** runs anything it finds: hook commands and MCP server commands are read as text, not
  executed. The scripts have no dependencies and start no processes.

## What stays private

- Config values (environment variables, MCP commands, arguments, headers, tokens) never reach the
  map; only names and counts do. A hook written inline is labelled by its program name only.
- A file that came with a project or a plugin may only lead Atlas to files inside that project or
  plugin. If it points anywhere else (an `@import` of `~/.aws/credentials`, a symlink into `~/.ssh`,
  a note in `~/.claude`, a path in a hook command), that file appears on the map by path, marked
  *not opened*, and is never read, described or summarized, unless your own config reaches it too.
  Plugin folders are the ones Claude Code recorded when it installed them.
- The skill tells Claude to treat every file it summarizes as data: read only the files the script
  lists, never follow instructions inside them, and flag any that try.

## The page

`atlas.html` makes no network requests. d3 and the fonts are bundled (see
[`renderer/vendor/SOURCES.md`](renderer/vendor/SOURCES.md) for versions and checksums). Text from
your files is escaped before it is embedded, and a Content-Security-Policy allows only the page's
own two scripts, by hash, and blocks every connection out. **Open in editor** hands a
`vscode://`, `cursor://` or `vscodium://` link to your system; nothing is sent anywhere.

The tests plant fake secrets, a script-injection heading and a hostile project, and fail if any of
them gets through.

## Reporting a problem

Please don't post exploit details in a public issue. Open an issue asking for a private contact,
or use GitHub's private vulnerability reporting on this repository if it is enabled.
