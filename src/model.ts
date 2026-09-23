/**
 * The whisper.cpp speech model: find it without redoing work, download only with consent.
 *
 *   1. VOICE_MCP_WHISPER_MODEL_PATH
 *   2. our cache (a real file, or a symlink made by an earlier run)
 *   3. the same model elsewhere on this machine → symlinked into the cache
 *   4. a one-time download — only via voice_setup(install=true) / `setup`
 */
import { closeSync, createWriteStream, existsSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { mkdir, rename, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CONFIG, debug, IS_MAC, log } from "./config.js";
import { run, SetupError } from "./proc.js";

/** Approximate download sizes, for the setup report. */
export const MODEL_SIZES_MB: Record<string, number> = {
  "tiny.en": 75, tiny: 75, "base.en": 142, base: 142, "small.en": 466, small: 466,
  "medium.en": 1500, medium: 1500, "large-v3-turbo": 1620, "large-v3-turbo-q5_0": 547, "large-v3": 3100,
};

/** How the current model was obtained — shown in the setup report. */
export let modelSource = "";

export function modelFile(): string {
  if (CONFIG.modelPath) return CONFIG.modelPath;
  if (!/^[A-Za-z0-9._-]+$/.test(CONFIG.modelName)) {
    throw new SetupError(`Invalid VOICE_MCP_WHISPER_MODEL "${CONFIG.modelName}".`);
  }
  return path.join(CONFIG.modelsDir, `ggml-${CONFIG.modelName}.bin`);
}

/** whisper.cpp ggml model files start with the magic 0x67676d6c ("ggml"). */
export function isGgmlModel(file: string): boolean {
  let fd: number | undefined;
  try {
    if (statSync(file).size < 1_000_000) return false;
    fd = openSync(file, "r");
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32LE(0) === 0x67676d6c;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Look for the same model elsewhere before downloading: whisper.cpp checkouts,
 * Homebrew's share folder, other tools' caches, and (on macOS) Spotlight.
 */
async function findExistingModel(fileName: string): Promise<string | null> {
  const home = os.homedir();
  const dirs = [
    ...CONFIG.modelSearchPaths,
    "/opt/homebrew/share/whisper-cpp",
    "/opt/homebrew/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp",
    "/usr/local/share/whisper-cpp/models",
    path.join(home, ".cache", "claude-voice-mcp", "models"), // this project's cache before it was renamed
    path.join(home, ".cache", "whisper.cpp"),
    path.join(home, ".cache", "whisper"),
    path.join(home, ".local", "share", "whisper.cpp", "models"),
    path.join(home, "Library", "Application Support", "whisper.cpp"),
    ...["", "src", "code", "Code", "dev", "Developer", "projects", "Projects", "workspace", "git", "repos", "GitHub"].map(
      (d) => path.join(home, d, "whisper.cpp", "models"),
    ),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, fileName);
    if (existsSync(candidate) && isGgmlModel(candidate)) return candidate;
  }

  if (IS_MAC && existsSync("/usr/bin/mdfind")) {
    try {
      const r = await run("/usr/bin/mdfind", ["-name", fileName], { timeoutMs: 4000 });
      for (const line of r.stdout.split("\n").map((l) => l.trim())) {
        if (path.basename(line) === fileName && !line.startsWith(CONFIG.modelsDir) && isGgmlModel(line)) return line;
      }
    } catch {
      /* Spotlight unavailable — fine */
    }
  }
  return null;
}

/** Point our cache at an existing file (symlink), so later lookups are instant. */
async function linkIntoCache(target: string, linkPath: string): Promise<string> {
  try {
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(target, linkPath);
    return linkPath;
  } catch (e) {
    debug("symlink failed, using the file in place:", e);
    return target;
  }
}

let resolvedModel: string | null = null;
let modelDownload: Promise<string> | null = null;

/** Find the model on this machine (steps 1–3). Returns null if it isn't here at all. Never downloads. */
export async function locateModel(): Promise<string | null> {
  if (resolvedModel && existsSync(resolvedModel)) return resolvedModel;

  if (CONFIG.modelPath) {
    if (!existsSync(CONFIG.modelPath)) {
      throw new SetupError(`VOICE_MCP_WHISPER_MODEL_PATH does not exist: ${CONFIG.modelPath}`);
    }
    modelSource = "from VOICE_MCP_WHISPER_MODEL_PATH";
    return (resolvedModel = CONFIG.modelPath);
  }

  const file = modelFile();
  if (existsSync(file) && isGgmlModel(file)) {
    modelSource = lstatSync(file).isSymbolicLink() ? "reused (symlinked from an existing copy)" : "cached";
    return (resolvedModel = file);
  }
  // A dangling symlink (the original was deleted) or a corrupt file: clear it.
  try {
    if (lstatSync(file)) await unlink(file);
  } catch {
    /* nothing there */
  }

  const existing = await findExistingModel(path.basename(file));
  if (existing) {
    log(`Reusing existing model ${existing}`);
    modelSource = `reused ${existing}`;
    return (resolvedModel = await linkIntoCache(existing, file));
  }
  return null;
}

/** locateModel(), plus — only when allowed — a one-time download into the cache. */
export async function ensureModel(opts: { download: boolean }): Promise<string> {
  const found = await locateModel();
  if (found) return found;
  if (!opts.download) {
    throw new SetupError(
      `The speech model "${CONFIG.modelName}" isn't on this computer yet. ` +
        "Call the voice_setup tool (with install=true once the user agrees) to download it.",
    );
  }
  modelDownload ??= downloadModel(modelFile()).finally(() => {
    modelDownload = null;
  });
  const downloaded = await modelDownload;
  modelSource = "downloaded";
  return (resolvedModel = downloaded);
}

/** Is a download currently running (e.g. started by an earlier voice_setup call)? */
export const isModelDownloading = () => modelDownload !== null;

async function downloadModel(dest: string): Promise<string> {
  await mkdir(path.dirname(dest), { recursive: true });
  const url = `${CONFIG.modelBaseUrl}/ggml-${CONFIG.modelName}.bin`;
  log(`Downloading whisper model "${CONFIG.modelName}" → ${dest}`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new SetupError(
      `Could not download whisper model from ${url} (HTTP ${res.status}). ` +
        "Check the model name, or download it manually and set VOICE_MCP_WHISPER_MODEL_PATH.",
    );
  }

  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = `${dest}.${process.pid}.part`;
  let received = 0;
  let lastLogged = -1;

  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length;
          if (total) {
            const pct = Math.floor((received / total) * 10) * 10;
            if (pct > lastLogged) {
              lastLogged = pct;
              log(`  model download ${pct}% (${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
            }
          }
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    if (!isGgmlModel(tmp)) throw new Error("downloaded file is not a whisper.cpp ggml model");
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  log(`Model ready: ${dest}`);
  return dest;
}
