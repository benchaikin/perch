/**
 * End-to-end tests: drive `run(...)` against a real daemon over a temp socket.
 *
 * Uses `node:test` + tsx. We boot `perchd` via `startDaemon` with an in-process
 * fixture plugin (a read with input + an action), then exercise the CLI's
 * registry-driven dispatch, `--json` output, generic input flags, the
 * daemon-not-running path, and a `--watch` stream.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { definePlugin, read, action, z, type Capability } from "@perch/sdk";
import { startDaemon, type RunningDaemon } from "@perch/core";
import { run } from "./index.js";

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-cli-test-"));
  return join(dir, "perchd.sock");
}

// The M0 SDK skeleton needs a cast to widen a concrete capability to `Capability`.
const asCap = (c: unknown): Capability => c as Capability;

const fixturePlugin = definePlugin({
  id: "demo",
  capabilities: {
    greet: asCap(
      read({
        summary: "Greet someone by name",
        input: z.object({ name: z.string(), times: z.number().optional() }),
        output: z.object({ message: z.string() }),
        run: ({ input }) => ({
          message: `hello ${input.name}`.repeat(input.times ?? 1),
        }),
      }),
    ),
    counter: asCap(
      read({
        summary: "A counter that increments each read",
        refresh: { every: "20ms" },
        output: z.object({ n: z.number() }),
        run: (() => {
          let n = 0;
          return () => ({ n: n++ });
        })(),
      }),
    ),
    noop: asCap(
      action({
        summary: "Do nothing",
        run: () => {},
      }),
    ),
  },
});

const daemons: RunningDaemon[] = [];
async function daemonForTest(): Promise<RunningDaemon> {
  const d = await startDaemon({ pluginDefs: [fixturePlugin], socketPath: tempSocketPath() });
  daemons.push(d);
  return d;
}

after(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

/** Capture stdout/stderr (console + process.stdout.write) while running `fn`. */
async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const origLog = console.log;
  const origError = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  let err = "";
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    err += args.join(" ") + "\n";
  };
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return { out, err };
  } finally {
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origWrite;
    process.exitCode = prevExit;
  }
}

/** Build a fake argv: ["node", "perch", ...args]. */
const argv = (...args: string[]): string[] => ["node", "perch", ...args];

test("daemon not running gives an actionable message", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "perch-cli-none-")), "nope.sock");
  const { err } = await capture(() => run(argv("--socket", missing)));
  assert.match(err, /perchd is not running/);
  assert.match(err, /Start it with/);
});

test("no args lists commands from the registry, grouped by plugin", async () => {
  const d = await daemonForTest();
  const { out } = await capture(() => run(argv("--socket", d.socketPath)));
  assert.match(out, /Available commands/);
  assert.match(out, /demo:/);
  assert.match(out, /perch demo greet\s+Greet someone by name/);
  assert.match(out, /perch demo noop\s+Do nothing/);
});

test("invoke a read with --json and generic input flags", async () => {
  const d = await daemonForTest();
  const { out } = await capture(() =>
    run(argv("demo", "greet", "--name", "ben", "--json", "--socket", d.socketPath)),
  );
  assert.deepEqual(JSON.parse(out), { message: "hello ben" });
});

test("numeric input flags are coerced to numbers", async () => {
  const d = await daemonForTest();
  const { out } = await capture(() =>
    run(argv("demo", "greet", "--name", "x", "--times", "3", "--json", "--socket", d.socketPath)),
  );
  assert.deepEqual(JSON.parse(out), { message: "hello xhello xhello x" });
});

test("server-side validation errors are surfaced", async () => {
  const d = await daemonForTest();
  // Missing required `name`.
  const { err } = await capture(() =>
    run(argv("demo", "greet", "--json", "--socket", d.socketPath)),
  );
  assert.match(err, /perch: demo\.greet:/);
});

test("unknown command reports an error and lists commands", async () => {
  const d = await daemonForTest();
  const { err } = await capture(() => run(argv("demo", "nonexistent", "--socket", d.socketPath)));
  assert.match(err, /unknown command/);
});

test("action invocation prints ok", async () => {
  const d = await daemonForTest();
  const { out } = await capture(() => run(argv("demo", "noop", "--socket", d.socketPath)));
  assert.match(out, /ok/);
});

test("--watch streams the current value and at least one update", async () => {
  const d = await daemonForTest();
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const done = run(argv("demo", "counter", "--watch", "--json", "--socket", d.socketPath));

  // Wait until we have the current value plus at least one pushed update.
  await new Promise<void>((resolve) => {
    const check = (): void => {
      const count = lines.join("").trim().split("\n").filter(Boolean).length;
      if (count >= 2) resolve();
      else setTimeout(check, 10);
    };
    check();
  });

  process.emit("SIGINT");
  await done;
  process.stdout.write = origWrite;

  const values = lines
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { n: number });
  assert.ok(values.length >= 2, `expected >=2 updates, got ${values.length}`);
  assert.ok(values[1]!.n > values[0]!.n, "counter should increment across updates");
});
