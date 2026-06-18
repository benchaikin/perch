/**
 * Behavioral tests for the shared renderer primitives, rendered into a real
 * jsdom DOM via @testing-library/react. This is the first direct test of
 * renderer view code (previously only the esbuild bundle was grepped): each
 * component must render byte-equivalent class names + structure to the DOM
 * builders it replaces, since `renderer.css` and downstream panes match on them.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Badge, Chip, Loading, Message } from "./components.js";

afterEach(() => cleanup());

/** The single root element a component renders, for class/structure assertions. */
function root(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  assert.ok(el instanceof HTMLElement, "expected a rendered root element");
  return el;
}

test("a plain chip renders a passive span with no action wiring", () => {
  const { container } = render(<Chip label="✓ CI" tone="ok" hint="CI passing" />);
  const el = root(container);
  assert.equal(el.tagName, "SPAN");
  assert.equal(el.className, "chip ok");
  assert.equal(el.textContent, "✓ CI");
  assert.equal(el.title, "CI passing");
  assert.equal(el.getAttribute("aria-label"), null);
  assert.equal(el.querySelector("i"), null);
});

test("an icon chip renders a leading Font Awesome icon before the label", () => {
  const { container } = render(
    <Chip label="Building" tone="warn" hint="In progress" icon="hammer" />,
  );
  const el = root(container);
  assert.equal(el.tagName, "SPAN");
  assert.equal(el.className, "chip warn");
  const icon = el.querySelector("i");
  assert.ok(icon, "expected a leading icon");
  assert.equal(icon.className, "fa-solid fa-hammer");
  // The label keeps the leading space the DOM builder appended after the icon.
  assert.equal(el.textContent, " Building");
});

test("the spin modifier adds fa-spin to the chip icon", () => {
  const { container } = render(
    <Chip label="Syncing" tone="warn" hint="Working" icon="circle-notch" spin />,
  );
  const icon = root(container).querySelector("i");
  assert.ok(icon);
  assert.equal(icon.className, "fa-solid fa-circle-notch fa-spin");
});

test("an href chip renders a focusable, accessible action button", () => {
  const { container } = render(
    <Chip
      label="○ rev"
      tone="warn"
      hint="Open PR for review"
      href="https://github.com/o/r/pull/7"
      actionLabel="Open PR for review"
    />,
  );
  const el = root(container);
  // A <button> is focusable + Enter/Space-activatable for free.
  assert.equal(el.tagName, "BUTTON");
  assert.equal(el.className, "chip warn action");
  assert.equal(el.getAttribute("aria-label"), "Open PR for review");
  assert.equal(el.title, "Open PR for review");
});

test("activating an href chip opens the PR and stops row propagation", () => {
  const opened: string[] = [];
  (window as unknown as { perch: { openPr: (url: string) => void } }).perch = {
    openPr: (url) => opened.push(url),
  };

  let rowClicked = false;
  const { container } = render(
    <div onClick={() => (rowClicked = true)}>
      <Chip
        label="○ rev"
        tone="warn"
        hint="Open PR for review"
        href="https://github.com/o/r/pull/7"
        actionLabel="Open PR for review"
      />
    </div>,
  );
  fireEvent.click(root(container).querySelector("button")!);

  assert.deepEqual(opened, ["https://github.com/o/r/pull/7"]);
  assert.equal(rowClicked, false, "click must not bubble to the row's open handler");
});

test("a badge renders its kind class, label, and hint", () => {
  const { container } = render(<Badge kind="rebase" label="needs rebase" hint="Behind main" />);
  const el = root(container);
  assert.equal(el.tagName, "SPAN");
  assert.equal(el.className, "badge rebase");
  assert.equal(el.textContent, "needs rebase");
  assert.equal(el.title, "Behind main");
});

test("a plain message renders a centered div", () => {
  const { container } = render(<Message text="No pull requests" />);
  const el = root(container);
  assert.equal(el.className, "message");
  assert.equal(el.textContent, "No pull requests");
});

test("an error message adds the error modifier", () => {
  const { container } = render(<Message text="Daemon is down" isError />);
  assert.equal(root(container).className, "message error");
});

test("loading renders a spinner alongside the text", () => {
  const { container } = render(<Loading text="Loading…" />);
  const el = root(container);
  assert.equal(el.className, "message");
  const spinner = el.querySelector("i");
  assert.ok(spinner, "expected a spinner");
  assert.equal(spinner.className, "fa-solid fa-circle-notch fa-spin");
  assert.equal(el.textContent, " Loading…");
});
