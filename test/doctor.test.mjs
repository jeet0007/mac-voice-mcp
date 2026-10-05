// `doctor`: the objective self-check, run as a real CLI against stub binaries.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOCTOR_SENTENCE } from "../dist/doctor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-doctor-"));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const b of ["rec", "whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", b), path.join(bin, b));
  const models = path.join(home, ".cache", "mac-voice-mcp", "models");
  mkdirSync(models, { recursive: true });
  const model = Buffer.alloc(1_100_000);
  model.writeUInt32LE(0x67676d6c, 0);
  writeFileSync(path.join(models, "ggml-tiny.en.bin"), model);
  const log = path.join(dir, "log.txt");
  writeFileSync(log, "");
  const run = (args, extra = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, "dist", "index.js"), "doctor", ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        HOME: home,
        PATH: [path.join(FIXTURES, "bin"), bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        STUB_LOG: log,
        VOICE_MCP_WHISPER_MODEL: "tiny.en",
        VOICE_MCP_RECORDER: "sox",
        VOICE_MCP_EXTRA_PATH: "",
        ...extra,
      },
    });
  return { home, log, run };
}

test("doctor passes when the transcript matches what was spoken, and saves a JSON report", () => {
  const sb = sandbox();
  const r = sb.run(["--no-loopback", "--json"], { STUB_TRANSCRIPT: DOCTOR_SENTENCE });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.checks.map((c) => [c.name, c.status]), [["Setup", "PASS"], ["Speech → text", "PASS"], ["Speaker → mic", "SKIP"]]);
  assert.equal(report.checks[1].metrics.wer, 0);
  assert.ok(report.reportFile.startsWith(path.join(sb.home, ".cache", "mac-voice-mcp", "doctor")));
  assert.ok(existsSync(report.reportFile));
  assert.match(readFileSync(sb.log, "utf8"), /^speak-to-file "The build passed/m);
  assert.match(r.stderr, /PASS  Speech → text: 100% of words right/);
});

test("doctor fails, with exit code 1, when the transcript is wrong", () => {
  const sb = sandbox();
  const r = sb.run(["--no-loopback", "--json"], { STUB_TRANSCRIPT: "Completely different words came back." });
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks[1].status, "FAIL");
});

test("doctor stops after Setup when something is missing", () => {
  const sb = sandbox();
  const r = sb.run(["--no-loopback", "--json"], { VOICE_MCP_WHISPER_MODEL: "small.en" }); // no such model on disk
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).checks.map((c) => [c.name, c.status]), [["Setup", "FAIL"]]);
});
