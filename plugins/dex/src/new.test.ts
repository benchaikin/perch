/**
 * Unit tests for the `dex.new` action's pure helpers + the `runNew`
 * orchestration. The terminal launcher (`spawn`/`writeScript`) is stubbed, so
 * nothing spawns a real process — we assert the repo resolution, the bootstrap
 * prompt, the window title, the safely-quoted `claude` launch command, and the
 * graceful failure paths. Mirrors `spawn.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_ATTACHED_FILES,
  newTaskPrompt,
  newTaskTitle,
  normalizeAttachedFiles,
  resolveNewRepo,
  runNew,
  type NewDeps,
} from "./new.js";

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

// ----- attached files ------------------------------------------------------

test("normalizeAttachedFiles: trims, drops blanks, and lifts a bare string", () => {
  assert.deepEqual(normalizeAttachedFiles(["  /a/shot.png  ", "", "   "]), ["/a/shot.png"]);
  // A single string is the CLI shape (`--files <path>`), lifted to a one-element list.
  assert.deepEqual(normalizeAttachedFiles("/a/spec.md"), ["/a/spec.md"]);
});

test("normalizeAttachedFiles: drops relative paths (they'd resolve against the repo)", () => {
  assert.deepEqual(normalizeAttachedFiles(["docs/spec.md", "./shot.png", "../up.txt"]), []);
  assert.deepEqual(normalizeAttachedFiles(["rel.md", "/abs.md"]), ["/abs.md"]);
});

test("normalizeAttachedFiles: dedupes, preserving first-seen order", () => {
  assert.deepEqual(normalizeAttachedFiles(["/a.png", "/b.png", "/a.png"]), ["/a.png", "/b.png"]);
});

test("normalizeAttachedFiles: caps the list so the quoted prompt can't eat ARG_MAX", () => {
  const many = Array.from({ length: MAX_ATTACHED_FILES + 5 }, (_, i) => `/f/${i}.png`);
  const normalized = normalizeAttachedFiles(many);
  assert.equal(normalized.length, MAX_ATTACHED_FILES);
  assert.deepEqual(normalized, many.slice(0, MAX_ATTACHED_FILES));
});

test("normalizeAttachedFiles: junk values normalize away rather than throwing", () => {
  assert.deepEqual(normalizeAttachedFiles(undefined), []);
  assert.deepEqual(normalizeAttachedFiles(null), []);
  assert.deepEqual(normalizeAttachedFiles(42), []);
  assert.deepEqual(normalizeAttachedFiles({ files: "/a.png" }), []);
  assert.deepEqual(normalizeAttachedFiles([null, 7, "/ok.png"]), ["/ok.png"]);
});

test("newTaskPrompt: an ATTACHED FILES block lists the paths and says to read them first", () => {
  const prompt = newTaskPrompt("Fix the broken header", false, undefined, [
    "/tmp/shot.png",
    "/docs/spec.md",
  ]);
  assert.match(prompt, /ATTACHED FILES/);
  assert.ok(prompt.includes("/tmp/shot.png"));
  assert.ok(prompt.includes("/docs/spec.md"));
  assert.match(prompt, /READ them FIRST/);
  // The authored task must not end up depending on a path that may be gone later.
  assert.match(prompt, /Fold whatever matters from them into the task description/);
  // The block follows the description and precedes the authoring guidance.
  assert.ok(prompt.indexOf("Fix the broken header") < prompt.indexOf("ATTACHED FILES"));
  assert.ok(prompt.indexOf("ATTACHED FILES") < prompt.indexOf("Author this as well-formed"));
});

test("newTaskPrompt: no attachments leaves the prompt byte-identical", () => {
  assert.equal(newTaskPrompt("Do a thing", false, undefined, []), newTaskPrompt("Do a thing"));
  assert.equal(
    newTaskPrompt("Do a thing", true, "epic1", []),
    newTaskPrompt("Do a thing", true, "epic1"),
  );
  assert.doesNotMatch(newTaskPrompt("Do a thing"), /ATTACHED FILES/);
});

test("newTaskPrompt: start mode puts the attachments before the worker handoff", () => {
  const prompt = newTaskPrompt("Fix the header", true, undefined, ["/tmp/shot.png"]);
  // The worker inherits the context through the description the author writes, so
  // the block must land before the handoff (same rule as the reconcile block).
  assert.ok(prompt.indexOf("ATTACHED FILES") < prompt.indexOf("START WORKING"));
});

test("newTaskPrompt: a sub-task composition carries the attachments too", () => {
  const prompt = newTaskPrompt("Fix the header", false, "epic1", ["/tmp/shot.png"]);
  assert.match(prompt, /dex create --parent epic1/);
  assert.match(prompt, /ATTACHED FILES/);
  assert.ok(prompt.includes("/tmp/shot.png"));
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

test("runNew: threads the configured agent model + permission mode into the launch", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a logout button" },
    deps({
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
      agent: { model: "opus", permissionMode: "acceptEdits" },
    }),
  );
  assert.equal(res.ok, true);
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch' && exec claude --model opus --permission-mode acceptEdits '/,
  );
});

test("runNew: a per-task agentModel override wins over the configured default", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a logout button", agentModel: "sonnet" },
    deps({
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
      agent: { model: "opus", permissionMode: "acceptEdits" },
    }),
  );
  assert.equal(res.ok, true);
  // The per-task pick replaces the configured model but keeps the permission mode.
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch' && exec claude --model sonnet --permission-mode acceptEdits '/,
  );
});

test("runNew: an empty agentModel falls through to the configured default", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a logout button", agentModel: "" },
    deps({
      spawn: fakeSpawn().spawn,
      writeScript: script.writeScript,
      agent: { model: "opus" },
    }),
  );
  assert.equal(res.ok, true);
  assert.match(script.commands[0]!, /exec claude --model opus --permission-mode auto '/);
});

test("runNew: an invalid agentModel is rejected — no --model reaches the shell", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Add a logout button", agentModel: "evil; rm -rf /" },
    deps({ spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  // The out-of-whitelist value is dropped, not interpolated — auto mode, no --model.
  assert.match(script.commands[0]!, /\ncd '\/work\/perch' && exec claude --permission-mode auto '/);
  assert.doesNotMatch(script.commands[0]!, /--model/);
  assert.ok(!script.commands[0]!.includes("rm -rf"));
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

test("runNew: threads the attached files into the launched prompt", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Fix the header", files: ["/tmp/shot.png", "/docs/spec.md"] },
    deps({ spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  assert.ok(script.commands[0]!.includes("ATTACHED FILES"));
  assert.ok(script.commands[0]!.includes("/tmp/shot.png"));
  assert.ok(script.commands[0]!.includes("/docs/spec.md"));
});

test("runNew: normalizes the files before prompting (relative dropped, dupes collapsed)", async () => {
  const script = fakeWriteScript();
  const res = await runNew(
    { description: "Fix the header", files: ["docs/rel.md", " /a.png ", "/a.png", ""] },
    deps({ spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  assert.ok(!script.commands[0]!.includes("docs/rel.md"));
  // The one surviving path appears exactly once in the prompt's list.
  assert.equal(script.commands[0]!.split("/a.png").length - 1, 1);
});

test("runNew: an unusable files value is normalized away, not a failed launch", async () => {
  const term = fakeSpawn();
  const script = fakeWriteScript();
  const res = await runNew(
    // The action's schema would reject this shape, but `runNew` never throws on it.
    { description: "Fix the header", files: 42 as unknown as string[] },
    deps({ spawn: term.spawn, writeScript: script.writeScript }),
  );
  assert.equal(res.ok, true);
  assert.equal(term.calls, 1, "the launch still happens");
  assert.ok(!script.commands[0]!.includes("ATTACHED FILES"));
});
