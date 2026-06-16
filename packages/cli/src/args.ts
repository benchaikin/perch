/**
 * Tiny argv parser for the `perch` CLI.
 *
 * Splits argv into positional tokens (used to resolve a capability id), the
 * three CLI-level flags (`--json`, `--watch`, `--socket <path>`), and a bag of
 * arbitrary `--key value` flags forwarded as capability input.
 *
 * The input schema is intentionally NOT serialized over RPC, so we cannot
 * derive precise per-capability flags here. Instead we collect generic flags:
 *   --key value     → { key: <coerced value> }
 *   --flag          → { flag: true }            (valueless, or before another --flag)
 *   --key=value     → { key: <coerced value> }
 * Coercion: a value that looks numeric becomes a number, "true"/"false" become
 * booleans, everything else stays a string. The daemon validates the result
 * against the capability's zod schema and returns clear errors on mismatch.
 * (Precise flags can come later once the registry exposes JSON Schema.)
 */

/** Reserved CLI-level flags, never forwarded as capability input. */
export interface CliFlags {
  json: boolean;
  watch: boolean;
  socket?: string;
  /**
   * Read a JSON object from stdin and merge it into the capability input (with
   * explicit `--key value` flags taking precedence). Lets a single command
   * forward a raw payload — e.g. a Claude Code hook piping its event JSON to
   * `perch agents report --stdin-json`.
   */
  stdinJson: boolean;
}

/** Result of parsing argv (after the `perch` program name). */
export interface ParsedArgs {
  /** Positional tokens, e.g. `["stack", "view"]`. */
  positionals: string[];
  /** Reserved CLI-level flags. */
  cli: CliFlags;
  /** Arbitrary input flags, or `undefined` if none were given. */
  input: Record<string, unknown> | undefined;
}

const RESERVED = new Set(["json", "watch", "socket", "stdin-json"]);

/** Coerce a raw string flag value into a number, boolean, or string. */
function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Numeric-looking (ints, decimals, negatives) → number.
  if (raw !== "" && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Parse argv tokens (excluding `node` and the script path) into
 * {@link ParsedArgs}. Throws on an unknown reserved-flag misuse only when it
 * would be ambiguous (e.g. `--socket` with no value).
 */
export function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const cli: CliFlags = { json: false, watch: false, stdinJson: false };
  const input: Record<string, unknown> = {};
  let hadInput = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (RESERVED.has(key)) {
      if (key === "json") cli.json = true;
      else if (key === "watch") cli.watch = true;
      else if (key === "stdin-json") cli.stdinJson = true;
      else {
        // --socket requires a value (inline or next token).
        const value = inlineValue ?? tokens[++i];
        if (value === undefined) {
          throw new Error("--socket requires a path argument");
        }
        cli.socket = value;
      }
      continue;
    }

    // Generic input flag.
    hadInput = true;
    if (inlineValue !== undefined) {
      input[key] = coerce(inlineValue);
      continue;
    }
    // Look ahead: if the next token is a value (not another flag), consume it.
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      input[key] = coerce(next);
      i++;
    } else {
      input[key] = true;
    }
  }

  return { positionals, cli, input: hadInput ? input : undefined };
}
