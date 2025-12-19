import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

// Run your existing script relative to the repo root
const scriptPath = path.resolve("lighthouse/run.mjs");

// If you *really* need env-file behavior, you have two options:
// A) implement dotenv loading in code (recommended), or
// B) rely on GitHub Action env/secrets (recommended for CI)
// For POC, we’ll just run the script.

const res = spawnSync(process.execPath, [scriptPath], {
  stdio: "inherit",
  env: process.env
});

process.exit(res.status ?? 1);
