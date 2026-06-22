/**
 * Unit tests for the `dex.new` action's pure helpers + the `runNew`
 * orchestration. The terminal launcher (`spawn`/`writeScript`) is stubbed, so
 * nothing spawns a real process — we assert the repo resolution, the bootstrap
 * prompt, the window title, the safely-quoted `claude` launch command, and the
 * graceful failure paths. Mirrors `spawn.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { newTaskPrompt, newTaskTitle, resolveNewRepo, runNew, type NewDeps } from "./new.js";

test("resolveNewRepo: explicit repo wins as given", () => {
  assert.deepEqual(resolveNewRepo({ repo: "/explicit/path" }, ["/work/perch"]), {
    repo: "/explicit/path",
  });
});

test("resolveNewRepo: a project maps to its repo by basename", () => {
  assert.deepEqual(resolveNewRepo({ project: "perch" }, ["/work/perch", "/work/other"]), {
    repo: "/work/perch",
  });
});

test("resolveNewRepo: an unknown project is a clean error", () => {
  const r = resolveNewRepo({ project: "ghost" }, ["/work/perch"]);
  assert.ok("error" in r && /no configured repo/.test(r.error));
});

test("resolveNewRepo: a single configured repo needs no project (zero-click)", () => {
  assert.deepEqual(resolveNewRepo({}, ["/work/perch"]), { repo: "/work/perch" });
});

test("resolveNewRepo: no repos configured → undefined (caller uses its cwd store)", () => {
  assert.deepEqual(resolveNewRepo({}, []), { repo: undefined });
});

test("resolveNewRepo: multiple repos with no project/repo is a clean ambiguity error", () => {
  const r = resolveNewRepo({}, ["/work/perch", "/work/other"]);
  assert.ok("error" in r && /multiple dex repos/.test(r.error));
});

test("newTaskTitle: `dex new · <snippet>`, bare when blank, truncated when long", () => {
  assert.equal(newTaskTitle("Add a logout button"), "dex new · Add a logout button");
  assert.equal(newTaskTitle("   "), "dex new");
  // Whitespace is collapsed so a multi-line description still reads on one line.
  assert.equal(newTaskTitle("Add\n\n  a   button"), "dex new · Add a button");
  const long = "A really long task description that goes well past the readable title limit";
  const title = newTaskTitle(long);
  assert.ok(title.startsWith("dex new · "));
  assert.ok(title.endsWith("…"));
  assert.ok(title.length < `dex new · ${long}`.length);
});

test("newTaskPrompt: embeds the description and instructs `dex create` (no implementation)", () => {
  const prompt = newTaskPrompt("Add a logout button to the header");
  assert.ok(prompt.includes("Add a logout button to the header"));
  assert.ok(prompt.includes("dex create"));
  // It authors, not implements — the prompt says so explicitly.
  assert.match(prompt, /Do NOT implement/);
});

test("newTaskPrompt: default authors only (no worker spawned)", () => {
  const prompt = newTaskPrompt("Add a logout button", false);
  assert.match(prompt, /Do NOT implement the work — only author it\./);
  assert.doesNotMatch(prompt, /START WORKING/);
});

test("newTaskPrompt: reconciles the new work against existing tasks in both directions", () => {
  const prompt = newTaskPrompt("Add a logout button", false);
  // It reviews the existing open tasks and wires edges in BOTH directions.
  assert.match(prompt, /reconcile/i);
  assert.match(prompt, /NEW blocked by EXISTING/);
  assert.match(prompt, /EXISTING blocked by NEW/);
  // It names the real edge mechanisms (creation-time and after-the-fact).
  assert.match(prompt, /--blocked-by/);
  assert.match(prompt, /--add-blocker/);
  // The merge-conflict judgment is grounded in real file overlap, biased against over-wiring.
  assert.match(prompt, /file overlap/i);
  assert.match(prompt, /merge/i);
  assert.match(prompt, /Bias toward NOT wiring/i);
});

test("newTaskPrompt: start mode tells the agent to spawn a worker after authoring", () => {
  const prompt = newTaskPrompt("Add a logout button", true);
  // It overrides the author-only guidance and names the worktree/spawn mechanism.
  assert.doesNotMatch(prompt, /Do NOT implement the work — only author it\./);
  assert.match(prompt, /START WORKING/);
  assert.match(prompt, /dex\/<id>-<slug>/);
  assert.match(prompt, /spawn-dex|dex-worktree/);
  // The description is still embedded and `dex create` is still the authoring step.
  assert.ok(prompt.includes("Add a logout button"));
  assert.ok(prompt.includes("dex create"));
});

test("newTaskPrompt: start mode reconciles BEFORE handing off to the worker", () => {
  const prompt = newTaskPrompt("Add a logout button", true);
  // The reconciliation guidance is present even in start mode...
  assert.match(prompt, /reconcile/i);
  assert.match(prompt, /--add-blocker/);
  // ...and precedes the worker handoff, so the worker never starts a task whose
  // blocked status is about to change.
  assert.ok(prompt.indexOf("reconcile") < prompt.indexOf("START WORKING"));
});

test("newTaskPrompt: a parentId authors a sub-task under the parent (no fresh epic)", () => {
  const prompt = newTaskPrompt("Add a logout endpoint", false, "abc123");
  // The description is embedded and the parent is threaded into `dex create --parent`.
  assert.ok(prompt.includes("Add a logout endpoint"));
  assert.match(prompt, /dex create --parent abc123/);
  assert.match(prompt, /sub-task/i);
  // Already inside an epic — it must default to one sub-task, not spin up a new epic.
  assert.match(prompt, /do NOT spin up a new epic/i);
  // Author-only by default still holds for a sub-task.
  assert.match(prompt, /Do NOT implement the work — only author it\./);
  // The sub-task is also reconciled against the existing tasks in the store.
  assert.match(prompt, /reconcile/i);
  assert.match(prompt, /--add-blocker/);
});

test("newTaskPrompt: parentId composes with start mode (author the sub-task, then spawn a worker)", () => {
  const prompt = newTaskPrompt("Add a logout endpoint", true, "abc123");
  assert.match(prompt, /dex create --parent abc123/);
  assert.match(prompt, /START WORKING/);
  assert.doesNotMatch(prompt, /Do NOT implement the work — only author it\./);
});

test("newTaskPrompt: offers both the single-task and the epic/sub-task path", () => {
  const prompt = newTaskPrompt("Port the renderer to React across the app");
  // It judges scope rather than forcing a single task.
  assert.match(prompt, /scope/i);
  assert.doesNotMatch(prompt, /SINGLE well-formed dex task/);
  // The epic path names the real mechanism: --parent and --blocked-by sub-tasks.
  assert.match(prompt, /epic/i);
  assert.match(prompt, /--parent/);
  assert.match(prompt, /--blocked-by/);
  assert.match(prompt, /sub-task/i);
  // …but biases toward a single task so trivial requests don't explode into fake epics.
  assert.match(prompt, /over-decompose/i);
});

// ----- runNew orchestration (seams stubbed) ---------------------------------

/** A fake terminal spawn that records it fired (see `spawn.test.ts`). */
function fakeSpawn(): { spawn: NewDeps["spawn"]; calls: number } {
  let calls = 0;
  const spawn = (() => {
    calls += 1;
    return { on: () => {}, unref: () => {} };
  }) as unknown as NewDeps["spawn"];
  return {
    spawn,
    get calls() {
      return calls;
    },
  };
}

/** A `writeScript` stub that records the command without touching disk. */
function fakeWriteScript(): { writeScript: NewDeps["writeScript"]; commands: string[] } {
  const commands: string[] = [];
  return {
    writeScript: (_label, command) => {
      commands.push(command);
      return "/tmp/perch-terminal/fake.sh";
    },
    commands,
  };
}

function deps(over: Partial<NewDeps> = {}): NewDeps {
  return {
    repos: ["/work/perch"],
    cwd: "/daemon/cwd",
    terminal: {},
    ...over,
  };
}

test("runNew: rejects an empty/whitespace description before launching", async () => {
  const term = fakeSpawn();
  const res = await runNew({ description: "   " }, deps({ spawn: term.spawn }));
  assert.equal(res.ok, false);
  assert.match(res.message, /description is required/);
  assert.equal(term.calls, 0);
});

test("runNew: happy path — launches an auto-mode agent in the sole repo with the seeded prompt", async () => {
  const term = fakeSpawn();
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a logout button" },
    deps({ spawn: term.spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.repo, "/work/perch");
  assert.equal(term.calls, 1);
  assert.equal(script.commands.length, 1);
  // The window title (description snippet) is set first, then the cd+exec claude
  // line in the resolved repo, in auto mode, with the seeded prompt.
  assert.match(script.commands[0]!, /^printf '\\033\]0;%s\\007' 'dex new · Add a logout button'\n/);
  assert.match(script.commands[0]!, /\ncd '\/work\/perch' && exec claude --permission-mode auto '/);
  assert.ok(script.commands[0]!.includes("dex create"));
  assert.ok(script.commands[0]!.includes("Add a logout button"));
});

test("runNew: start mode seeds the worker-spawning prompt and a distinct success message", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a logout button", start: true },
    deps({ spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  assert.match(res.message, /start an agent working it/);
  assert.match(script.commands[0]!, /START WORKING/);
});

test("runNew: a parentId threads `dex create --parent` into the seeded prompt", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a thing", parentId: "epic42", project: "perch" },
    deps({ spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  assert.match(script.commands[0]!, /dex create --parent epic42/);
});

test("runNew: the per-task model override emits --model; mode comes from the agent default", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a thing", model: "opus" },
    deps({
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
      agent: { permissionMode: "plan" },
    }),
  );
  assert.equal(res.ok, true);
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch' && exec claude --model opus --permission-mode plan '/,
  );
});

test("runNew: an empty model override falls back to the configured agent default", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a thing", model: "" },
    deps({
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
      agent: { model: "sonnet" },
    }),
  );
  assert.equal(res.ok, true);
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch' && exec claude --model sonnet --permission-mode auto '/,
  );
});

test("runNew: an explicit project targets that repo's directory", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Do a thing", project: "other" },
    deps({
      repos: ["/work/perch", "/work/other"],
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.repo, "/work/other");
  assert.match(script.commands[0]!, /\ncd '\/work\/other' && exec claude/);
});

test("runNew: no configured repos falls back to the daemon's cwd store", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Do a thing" },
    deps({
      repos: [],
      cwd: "/daemon/cwd",
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.repo, "/daemon/cwd");
  assert.match(script.commands[0]!, /\ncd '\/daemon\/cwd' && exec claude/);
});

test("runNew: multiple repos with no target is a clean ambiguity error, nothing launched", async () => {
  const term = fakeSpawn();
  const res = await runNew(
    { description: "Do a thing" },
    deps({
      repos: ["/work/perch", "/work/other"],
      spawn: term.spawn,
      writeScript: fakeWriteScript().writeScript,
    }),
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /multiple dex repos/);
  assert.equal(term.calls, 0);
});
