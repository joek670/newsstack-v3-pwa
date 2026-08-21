#!/usr/bin/env node
// Parity check: worker.js's extractArticle against app.py's extract_article.
//
//   node tools/parity/run.mjs [path/to/app.py]
//
// The PWA's extraction is a port, and its output feeds ranking and clustering
// that were tuned against v3's. So the rule for this file is: any change to
// visibleText / extractArticle / readableLines gets a case here first, and this
// must print 0 differ before the worker is deployed.
//
// Needs python on PATH and a checkout of the v3 server. Default location is
// ~/newsstack-v3/app.py; pass a path to override, or set NEWSSTACK_APP_PY.
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const appPy =
  process.argv[2] ||
  process.env.NEWSSTACK_APP_PY ||
  path.join(homedir(), "newsstack-v3", "app.py");

if (!existsSync(appPy)) {
  console.error(`app.py not found at ${appPy}`);
  console.error("Pass the path as an argument or set NEWSSTACK_APP_PY.");
  process.exit(2);
}

const cases = JSON.parse(readFileSync(path.join(HERE, "cases.json"), "utf8"));
const work = mkdtempSync(path.join(tmpdir(), "ns-parity-"));

// --- JS side. worker.js exports only its fetch handler, so run a copy with
// named exports appended rather than editing the file that gets deployed.
const shim = path.join(work, "shim.mjs");
writeFileSync(
  shim,
  readFileSync(path.join(REPO, "worker.js"), "utf8") +
    "\nexport { extractArticle, visibleText, readableLines };\n",
  "utf8"
);
const { extractArticle } = await import(pathToFileURL(shim).href);
const js = Object.fromEntries(cases.map((c) => [c.name, extractArticle(c.html)]));

// --- Python side, driven through app.py's real entry point.
const driver = path.join(work, "py_side.py");
writeFileSync(
  driver,
  [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("nsapp", r"${appPy}")`,
    "mod = importlib.util.module_from_spec(spec)",
    'sys.modules["nsapp"] = mod',
    "spec.loader.exec_module(mod)",
    "cases = json.load(open(sys.argv[1], encoding='utf-8'))",
    "out = {c['name']: mod.extract_article(c['html'].encode('utf-8'),",
    "                                      'text/html; charset=utf-8')",
    "       for c in cases}",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n"),
  "utf8"
);

const py = JSON.parse(
  execFileSync("python", [driver, path.join(HERE, "cases.json")], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 32 * 1024 * 1024,
  })
);

let differ = 0;
for (const name of Object.keys(py)) {
  if (py[name] === js[name]) {
    console.log(`MATCH    ${name}`);
  } else {
    differ++;
    console.log(`DIFFER   ${name}`);
    console.log(`    py: ${JSON.stringify(py[name])}`);
    console.log(`    js: ${JSON.stringify(js[name])}`);
  }
}

const total = Object.keys(py).length;
console.log(`\n${total - differ}/${total} match, ${differ} differ`);
process.exit(differ ? 1 : 0);
