/**
 * One-command setup for Perch (macOS).
 *
 *   pnpm run setup            # prereqs → install → package the .app → open it
 *   pnpm run setup --dev      # prereqs → install → build → dev-launch (no packaging)
 *   pnpm run setup --no-open  # do everything except the final `open`
 *
 * Runnable straight after `git clone`, before `pnpm install` — it uses only Node
 * builtins and drives `pnpm`/`gh` as child processes. The goal is to take a new
 * user from a fresh checkout to a running menu-bar app with no manual arch path,
 * Gatekeeper, or prerequisite hunting.
 *
 * Steps:
 *   1. Verify Node >= 22.
 *   2. Verify `gh` is installed (warn — don't fail — if it isn't authenticated).
 *   3. Install the `github/gh-stack` extension if it's missing.
 *   4. `pnpm install`.
 *   5. Build: package the self-contained Perch.app (or, with --dev, just build).
 *   6. Locate the built Perch.app (globbing release/*, so arch doesn't matter),
 *      strip the com.apple.quarantine attribute, and `open` it. With --dev,
 *      dev-launch the GUI instead.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const devMode = argv.includes("--dev");
const noOpen = argv.includes("--no-open");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const out = (msg) => process.stdout.write(`${msg}\n`);
const err = (msg) => process.stderr.write(`${msg}\n`);

let step = 0;
const heading = (msg) => out(`\n${BOLD}[${++step}] ${msg}${RESET}`);
const ok = (msg) => out(`${GREEN}✓${RESET} ${msg}`);
const warn = (msg) => out(`${YELLOW}!${RESET} ${msg}`);
const note = (msg) => out(`${DIM}${msg}${RESET}`);

/** Print an actionable error and exit non-zero. */
function fail(msg, hint) {
  err(`\n${RED}✗ ${msg}${RESET}`);
  if (hint) err(`  ${hint}`);
  process.exit(1);
}

/** Run a command inheriting stdio so the user sees live progress. Returns the status. */
function run(cmd, args, opts = {}) {
  note(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
  if (res.error?.code === "ENOENT") {
    fail(
      `\`${cmd}\` isn't on your PATH.`,
      cmd === "pnpm" ? "Install pnpm: https://pnpm.io/installation" : undefined,
    );
  }
  return res.status ?? 1;
}

/** Run a command capturing output (for checks); never throws. */
function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
  return {
    ok: !res.error && res.status === 0,
    missing: res.error?.code === "ENOENT",
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ── 1. Node version ─────────────────────────────────────────────────────────
heading("Checking Node.js");
const major = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(major) || major < 22) {
  fail(
    `Perch needs Node >= 22 (you have ${process.versions.node}).`,
    "Install/switch with nvm (`nvm install 22`) or see https://nodejs.org.",
  );
}
ok(`Node ${process.versions.node}`);

// ── 2. GitHub CLI ─────────────────────────────────────────────────────────────
heading("Checking GitHub CLI (gh)");
const ghVersion = capture("gh", ["--version"]);
if (ghVersion.missing) {
  fail(
    "The GitHub CLI (`gh`) isn't installed.",
    "Install it (`brew install gh`), then run `gh auth login`. See https://cli.github.com.",
  );
}
ok(ghVersion.stdout.split("\n")[0] || "gh installed");

const ghAuth = capture("gh", ["auth", "status"]);
if (!ghAuth.ok) {
  warn("`gh` isn't authenticated yet — Perch reuses your `gh auth token` for PR data.");
  note("  Run `gh auth login` before opening the app (you can do it after setup).");
} else {
  ok("gh is authenticated");
}

// ── 3. gh-stack extension ─────────────────────────────────────────────────────
heading("Checking the gh-stack extension");
const extList = capture("gh", ["extension", "list"]);
const hasStack = /gh-stack/.test(extList.stdout);
if (hasStack) {
  ok("github/gh-stack is installed");
} else {
  note("Installing github/gh-stack…");
  const status = run("gh", ["extension", "install", "github/gh-stack"]);
  if (status === 0) {
    ok("Installed github/gh-stack");
  } else {
    warn("Couldn't install github/gh-stack automatically — the Stack/PR plugin needs it.");
    note("  Install it later with `gh extension install github/gh-stack`.");
  }
}

// ── 4. Dependencies ───────────────────────────────────────────────────────────
heading("Installing dependencies (pnpm install)");
if (run("pnpm", ["install"]) !== 0) {
  fail("`pnpm install` failed.", "Scroll up for the error; fix it and re-run `pnpm run setup`.");
}
ok("Dependencies installed");

// ── 5. Build ──────────────────────────────────────────────────────────────────
if (devMode) {
  heading("Building the GUI (dev — no packaging)");
  if (run("pnpm", ["--filter", "@perch/gui", "build"]) !== 0) {
    fail("GUI build failed.", "Scroll up for the error.");
  }
  ok("Built");
} else {
  heading("Building & packaging Perch.app (this takes a couple of minutes)");
  if (run("pnpm", ["--filter", "@perch/gui", "dist"]) !== 0) {
    fail("Packaging failed.", "Scroll up for the error.");
  }
  ok("Packaged");
}

// ── 6. Launch ─────────────────────────────────────────────────────────────────
if (devMode) {
  heading("Launching Perch (dev)");
  if (noOpen) {
    note("--no-open: skipping launch. Start it later with `pnpm --filter @perch/gui start`.");
  } else {
    // Dev-launch detached so it outlives this script; it self-starts the daemon.
    const electron = spawnSync("pnpm", ["--filter", "@perch/gui", "start"], {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
    });
    if (electron.error) {
      warn("Couldn't dev-launch automatically — run `pnpm --filter @perch/gui start`.");
    } else {
      ok("Launched (dev) — look for the 🐦 in your menu bar.");
    }
  }
} else {
  heading("Opening Perch.app");
  // Glob release/* for Perch.app so the arch dir (mac-arm64 / mac / mac-x64 /
  // mac-universal) doesn't matter.
  const releaseDir = join(repoRoot, "packages", "gui", "release");
  let appPath;
  if (existsSync(releaseDir)) {
    for (const entry of readdirSync(releaseDir)) {
      const candidate = join(releaseDir, entry, "Perch.app");
      if (existsSync(candidate)) {
        appPath = candidate;
        break;
      }
    }
  }
  if (!appPath) {
    fail(
      "Packaging finished but no Perch.app was found under packages/gui/release/.",
      "Re-run `pnpm --filter @perch/gui dist` and check its output.",
    );
  }
  ok(`Built ${appPath.replace(repoRoot + "/", "")}`);

  // The app is unsigned. Stripping the quarantine attribute lets it open on a
  // double-click instead of being blocked by Gatekeeper (no right-click → Open).
  run("xattr", ["-dr", "com.apple.quarantine", appPath]);

  if (noOpen) {
    note(`--no-open: skipping launch. Open it later with \`open "${appPath}"\`.`);
  } else {
    if (run("open", [appPath]) === 0) {
      ok("Opened Perch — look for the 🐦 in your menu bar.");
    } else {
      warn(`Couldn't open it automatically — run \`open "${appPath}"\`.`);
    }
  }
}

out(
  `\n${GREEN}${BOLD}Done.${RESET} Next: click the 🐦 menu-bar icon → ${BOLD}Settings…${RESET} and add the local repos to watch.`,
);
if (!ghAuth.ok) {
  out(`${YELLOW}Reminder:${RESET} run \`gh auth login\` so Perch can fetch your PRs.`);
}
