#!/usr/bin/env node
// Renders out/demo.html in headless Chrome, unfolded, with one node selected, and saves a 2x PNG.
//   node scripts/demo.mjs && node scripts/screenshot.mjs [out.png] [--select <file name>]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = new URL("..", import.meta.url).pathname;
const outPng = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(repo, "docs/atlas.png"));
const i = process.argv.indexOf("--select"), select = i < 0 ? "block-force-push.sh" : process.argv[i + 1];
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// A copy of the page that unfolds everything and selects one node once the graph settles.
const page = fs.readFileSync(path.join(repo, "out/demo.html"), "utf8").replace("</script>\n\n", `
setTimeout(() => {
  document.querySelector("#legend").open = false;
  document.querySelector("#hint")?.remove();
  document.querySelector("#expandAll").click();
  const n = [...byId.values()].find((x) => x.t === ${JSON.stringify(select)});
  setTimeout(() => { if (n) { selected = n.id; paint(); inspect(n.id); } fit(); }, 2500);
}, 300);
</script>

`);
const tmp = path.join(repo, "out/screenshot.html");
fs.writeFileSync(tmp, page);
fs.mkdirSync(path.dirname(outPng), { recursive: true });
execFileSync(chrome, ["--headless=new", "--hide-scrollbars", "--force-dark-mode", "--blink-settings=preferredColorScheme=0",
  "--window-size=1440,860", "--force-device-scale-factor=2", "--virtual-time-budget=9000", `--screenshot=${outPng}`, `file://${tmp}`], { stdio: "ignore" });
console.log(`→ ${outPng}`);
