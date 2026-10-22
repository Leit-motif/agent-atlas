# agent-atlas

Maps what a Claude Code session loads and renders it as one HTML page.

- `src/discover.mjs` reads config files and emits a graph; `src/build.mjs` fills
  `renderer/atlas.html`'s `/*@ATLAS_DATA@*/` marker with it. Change the page in the renderer, the
  data in the builder.
- Discovery emits paths and structure only. Never put a config value (env, headers, args, tokens)
  into the graph or the page; the tests check this.
- A link on the map must be something the script found (an import, a symlink, a hook wiring, a
  settings entry). Anything a model wrote is a summary, shown with the Inferred label.
- Nothing from a real machine is committed: `out/` is ignored. Demos and screenshots come from
  `scripts/demo.mjs`'s made-up setup.
- Run `npm test` after any change, and `npm run screenshot` when the page's look changes.
