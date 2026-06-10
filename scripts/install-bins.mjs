/**
 * Install (or remove) `perch` and `perchd` wrapper scripts into a directory on
 * your PATH, so you can run them directly instead of `node packages/.../bin.js`.
 *
 *   node scripts/install-bins.mjs                 # install into ~/.local/bin
 *   node scripts/install-bins.mjs --dir /usr/local/bin
 *   PERCH_BIN_DIR=~/bin node scripts/install-bins.mjs
 *   node scripts/install-bins.mjs --uninstall
 *
 * The wrappers exec `node` (from your PATH) on the built dist entry points, so
 * they keep working across Node version switches. Run `pnpm build` first.
 *
 * This script writes only into the chosen bin dir — it does not edit your shell
 * profile or PATH; it prints the one line to add if the dir isn't already there.
 */
import process from "node:process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const out = (msg) => process.stdout.write(`${msg}\n`);
const err = (msg) => process.stderr.write(`${msg}\n`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const uninstall = argv.includes("--uninstall");

const dirFlag = argv.indexOf("--dir");
const targetDir =
  dirFlag !== -1 && argv[dirFlag + 1]
    ? resolve(argv[dirFlag + 1])
    : process.env.PERCH_BIN_DIR
      ? resolve(process.env.PERCH_BIN_DIR)
      : join(homedir(), ".local", "bin");

const bins = {
  perch: join(repoRoot, "packages", "cli", "dist", "bin.js"),
  perchd: join(repoRoot, "packages", "core", "dist", "bin.js"),
};

if (uninstall) {
  for (const name of Object.keys(bins)) {
    const dest = join(targetDir, name);
    if (existsSync(dest)) {
      rmSync(dest);
      out(`removed ${dest}`);
    }
  }
  process.exit(0);
}

for (const entry of Object.values(bins)) {
  if (!existsSync(entry)) {
    err(`! not built: ${entry}\n  run \`pnpm build\` first, then re-run this.`);
    process.exit(1);
  }
}

mkdirSync(targetDir, { recursive: true });
for (const [name, entry] of Object.entries(bins)) {
  const dest = join(targetDir, name);
  writeFileSync(dest, `#!/bin/sh\nexec node "${entry}" "$@"\n`);
  chmodSync(dest, 0o755);
  out(`installed ${dest} -> ${entry}`);
}

if (!(process.env.PATH ?? "").split(":").includes(targetDir)) {
  out(`\nAdd ${targetDir} to your PATH (e.g. in ~/.zshrc):\n  export PATH="${targetDir}:$PATH"`);
} else {
  out(`\n${targetDir} is already on your PATH — try: perch daemon status`);
}
