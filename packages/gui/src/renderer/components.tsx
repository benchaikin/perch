/**
 * Shared renderer primitives as React components: the chip/badge builders, the
 * centered message/loading renderers, and a re-export of the health-icon maps.
 * These are the reusable leaf elements every pane composes — a 1:1 port of the
 * pure DOM builders in {@link ./common.ts}, kept byte-equivalent in class names
 * and structure so `renderer.css` (which matches on `chip`/`badge`/`message …`)
 * and downstream assertions keep working unchanged.
 */

// The health maps are still plain data (not view), reused by the PR/worktree
// panes; surface them from this primitives module so panes have one building-
// block import site. Their home stays common.ts until that file is retired.
export { HEALTH_ICON, HEALTH_LABEL } from "./common.js";

/**
 * A status chip, optionally led by a (spinning) Font Awesome icon.
 *
 * When the chip carries an `href`, it renders as an actionable variant: a real
 * `<button>` (focusable + Enter/Space-activatable for free) styled as a chip,
 * with an accessible name, that opens the URL via `window.perch.openPr`. The
 * click is stopped from bubbling so it does not also fire the enclosing row's
 * open handler. Plain chips render exactly as before — a passive `<span>`.
 */
export function Chip(props: {
  label: string;
  tone: string;
  hint: string;
  icon?: string;
  spin?: boolean;
  href?: string;
  actionLabel?: string;
}): JSX.Element {
  const { label, tone, hint, icon, spin, href, actionLabel } = props;
  const className = `chip ${tone}${href ? " action" : ""}`;
  // Icon chips render `<i …/> label` (note the leading space the DOM builder
  // appended); plain chips are just the text label.
  const content = icon ? (
    <>
      <i className={`fa-solid fa-${icon}${spin ? " fa-spin" : ""}`} />
      {` ${label}`}
    </>
  ) : (
    label
  );
  if (href) {
    return (
      <button
        className={className}
        title={hint}
        aria-label={actionLabel}
        onClick={(e) => {
          // The row itself also opens the PR; stop here so we don't double-fire it.
          e.stopPropagation();
          window.perch.openPr(href);
        }}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={className} title={hint}>
      {content}
    </span>
  );
}

/** A badge (needs-rebase / conflict). */
export function Badge(props: {
  kind: "rebase" | "conflict";
  label: string;
  hint: string;
}): JSX.Element {
  return (
    <span className={`badge ${props.kind}`} title={props.hint}>
      {props.label}
    </span>
  );
}

/** A centered message (empty / daemon-down / error). */
export function Message(props: { text: string; isError?: boolean }): JSX.Element {
  return <div className={props.isError ? "message error" : "message"}>{props.text}</div>;
}

/** The initial loading state: a spinner alongside the message. */
export function Loading(props: { text: string }): JSX.Element {
  return (
    <div className="message">
      <i className="fa-solid fa-circle-notch fa-spin" />
      {` ${props.text}`}
    </div>
  );
}
