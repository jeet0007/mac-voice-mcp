#!/usr/bin/env node
// Runs from `npm install` (prepare): points git at .githooks, so the pre-push hook runs the tests.
// Does nothing in CI, outside a git checkout, or when installed as a package.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!process.env.CI && existsSync(".git") && existsSync(".githooks")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    /* no git: nothing to do */
  }
}
