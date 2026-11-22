// Builds the native binaries from native/*.swift with the user's swiftc, after consent. See docs/specs/setup-and-doctor.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, log } from "./config.js";
import { run, tail, which } from "./proc.js";

const NATIVE = {
  "call-bubble": "the call bubble",
  "audio-worker": "the audio worker",
} as const;
export type NativeName = keyof typeof NATIVE;

const source = (name: NativeName) => fileURLToPath(new URL(`../native/${name}.swift`, import.meta.url));
export const nativeBin = (name: NativeName) => path.join(CONFIG.cacheDir, "bin", name);
const hashFile = (name: NativeName) => `${nativeBin(name)}.hash`;
const sourceHash = (name: NativeName) => createHash("sha256").update(readFileSync(source(name))).digest("hex");

export function nativeState(name: NativeName): "built" | "stale" | "absent" {
  let hash: string;
  try {
    hash = readFileSync(hashFile(name), "utf8").trim();
  } catch {
    return "absent";
  }
  return hash === sourceHash(name) && existsSync(nativeBin(name)) ? "built" : "stale";
}

// /usr/bin/swiftc is a shim that pops up an install dialog when the Command Line Tools are missing.
export function findSwiftc(): string | null {
  const swiftc = which("swiftc");
  if (swiftc === "/usr/bin/swiftc" && spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status !== 0) return null;
  return swiftc;
}

const building = new Map<NativeName, Promise<string>>();
export const nativeBuilding = (name: NativeName) => building.has(name);

/** Concurrent calls share one build. Resolves with a sentence for the user. */
export function buildNative(name: NativeName): Promise<string> {
  let build = building.get(name);
  if (build) return build;
  build = (async () => {
    const swiftc = findSwiftc();
    if (!swiftc) throw new Error("swiftc isn't installed: it comes with Xcode's Command Line Tools (`xcode-select --install`)");
    const bin = nativeBin(name);
    mkdirSync(path.dirname(bin), { recursive: true });
    const tmp = `${bin}.${process.pid}.tmp`;
    const t = Date.now();
    log(`Building ${NATIVE[name]}: ${swiftc} -O ${source(name)}`);
    const r = await run(swiftc, ["-O", source(name), "-o", tmp], { timeoutMs: 5 * 60_000 });
    if (r.code !== 0) {
      rmSync(tmp, { force: true });
      throw new Error(`swiftc exit ${r.code}: ${tail(r.stderr, 4)}`);
    }
    renameSync(tmp, bin); // atomic, so a process starting meanwhile never runs half a file
    writeFileSync(hashFile(name), sourceHash(name));
    return `Built ${NATIVE[name]} on this Mac in ${Math.round((Date.now() - t) / 1000)} s.`;
  })().finally(() => building.delete(name));
  building.set(name, build);
  return build;
}
