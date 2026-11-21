// The audio port is the only way into src/audio/: its backends stay internal to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const AUDIO = path.join(SRC, "audio");
const INTERNAL = ["mic.ts", "native.ts", "process.ts"].map((f) => path.join(AUDIO, f));

/** Every file under src/audio/'s internal modules that `file` imports. */
function internalImports(file) {
  const specs = [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  return specs
    .filter((s) => s.startsWith("."))
    .map((s) => path.resolve(path.dirname(file), s).replace(/\.js$/, ".ts"))
    .filter((p) => INTERNAL.includes(p));
}

test("nothing outside src/audio/ imports its backends: only audio/device.ts", () => {
  const files = readdirSync(SRC, { recursive: true })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(SRC, f))
    .filter((f) => !f.startsWith(AUDIO + path.sep));
  assert.ok(files.length > 20, "found the sources");
  const offenders = files.flatMap((f) => internalImports(f).map((p) => `${path.relative(SRC, f)} imports ${path.relative(SRC, p)}`));
  assert.deepEqual(offenders, [], "go through src/audio/device.ts instead");
});

