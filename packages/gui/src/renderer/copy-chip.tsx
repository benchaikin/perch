/**
 * A small monospace reference chip that copies its value to the clipboard on
 * click, with a brief inline `copied ✓` confirmation. Shared by the Dex id chip
 * and the Services PID badge so the copy-on-click affordance lives in one place
 * rather than being duplicated per call site.
 *
 * `stopPropagation` on the click so copying never triggers the surrounding row's
 * own behavior. The visual variant (font, hover, color) is driven entirely by
 * the caller's `className` + the shared `chip muted` base, so each chip reads in
 * its own context's style.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useActions } from "./actions.js";

export function CopyChip({
  value,
  className,
  title,
  style,
}: {
  value: string;
  className?: string;
  title?: string;
  style?: CSSProperties;
}): JSX.Element {
  const actions = useActions();
  const [copied, setCopied] = useState(false);

  // Revert the inline "copied ✓" confirmation after a moment; the cleanup clears
  // the timer if the chip unmounts (or is re-clicked) first, so no stray update.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <span
      className={`chip muted${className ? ` ${className}` : ""}${copied ? " copied" : ""}`}
      title={title}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        actions.copyText(value);
        setCopied(true);
      }}
    >
      {copied ? "copied ✓" : value}
    </span>
  );
}
