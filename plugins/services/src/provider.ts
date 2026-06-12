/**
 * HTTP client over the process-compose REST API (Dev services M1).
 *
 * process-compose exposes a small REST API either on a TCP address
 * (`http://localhost:8080` by default) or — preferably — over a Unix domain
 * socket when launched with `--use-uds`. This module wraps the two endpoints M1
 * needs (`GET /processes`, `GET /live`) behind a tiny injectable HTTP function
 * so the read + tests never depend on a real server or the `process-compose`
 * binary being installed.
 *
 * The request function ({@link FetchJson}) is the single seam: the default
 * implementation uses Node's `http.request` (with `socketPath` for UDS), and
 * unit tests inject a fixture that returns canned JSON.
 */
import { spawn } from "node:child_process";
import { request as httpRequest, type RequestOptions } from "node:http";

/** The default TCP address when neither `socket` nor `address` is configured. */
export const DEFAULT_ADDRESS = "http://localhost:8080";

/** Where process-compose's REST API lives. Exactly one transport is used. */
export interface ServerTarget {
  /**
   * Unix domain socket path (process-compose `--use-uds`). Preferred when set —
   * requests go over the socket and `address` is ignored.
   */
  socket?: string;
  /** HTTP base address, e.g. `http://localhost:8080`. Used when `socket` is unset. */
  address?: string;
}

/**
 * One HTTP request against the process-compose API. `path` is the request path
 * (e.g. `/processes`). Resolves with the decoded JSON body and HTTP status;
 * rejects only on a transport-level failure (connection refused, socket
 * missing) — a non-2xx response still resolves so callers can branch on `status`.
 */
export type FetchJson = (args: {
  target: ServerTarget;
  method: "GET" | "POST";
  path: string;
}) => Promise<{ status: number; body: unknown }>;

/**
 * Default {@link FetchJson} over Node's `http`. Uses `socketPath` for a Unix
 * socket target, else parses `address` (host/port) for TCP. Empty/invalid bodies
 * decode to `undefined` rather than throwing, so a health probe that returns no
 * body still resolves.
 */
export const defaultFetchJson: FetchJson = ({ target, method, path }) =>
  new Promise((resolve, reject) => {
    const options = requestOptions(target, method, path);
    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });

/** Build `http.request` options for either a UDS or a TCP address target. */
function requestOptions(
  target: ServerTarget,
  method: "GET" | "POST",
  path: string,
): RequestOptions {
  const headers = { accept: "application/json" };
  if (target.socket) {
    return { socketPath: target.socket, method, path, headers };
  }
  const url = new URL(path, target.address ?? DEFAULT_ADDRESS);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    method,
    path: url.pathname + url.search,
    headers,
  };
}

/** Raw process-compose `ProcessState` (the fields M1 reads; all others ignored). */
export interface ProcessState {
  name: string;
  namespace?: string;
  status: string;
  system_time?: string;
  age?: number;
  is_ready?: string;
  restarts?: number;
  exit_code?: number;
  pid?: number;
  mem?: number;
  cpu?: number;
}

/** Options for {@link ServicesProvider}. */
export interface ProviderOptions extends ServerTarget {
  /** Injected HTTP function (tests pass a fixture; defaults to {@link defaultFetchJson}). */
  fetchJson?: FetchJson;
  /** Path to the process-compose config file (for `autostart`). */
  composeFile?: string;
  /** When true, attempt `process-compose up -D` if the server is unreachable. */
  autostart?: boolean;
  /** Optional log sink. */
  log?: (message: string) => void;
  /** Injected spawn (tests stub it); defaults to `child_process.spawn`. */
  spawn?: typeof spawn;
}

/** Resolve the {@link ServerTarget} from provider options (socket preferred). */
function targetOf(options: ProviderOptions): ServerTarget {
  return options.socket
    ? { socket: options.socket }
    : { address: options.address ?? DEFAULT_ADDRESS };
}

/**
 * A thin client over the process-compose REST API. Never throws out of its read
 * methods: {@link ServicesProvider.processes} returns `undefined` when the
 * server is unreachable (the read maps that to `available: false`), and
 * {@link ServicesProvider.health} returns `false` rather than rejecting.
 */
export class ServicesProvider {
  private readonly fetchJson: FetchJson;
  private readonly target: ServerTarget;
  private readonly options: ProviderOptions;
  /** Guards `autostart` so we attempt to spawn the server at most once. */
  private autostartAttempted = false;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.target = targetOf(options);
  }

  /** `GET /live` → true when the server answers 2xx. Never throws. */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetchJson({ target: this.target, method: "GET", path: "/live" });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /**
   * `GET /processes` → the list of {@link ProcessState}. Returns `undefined`
   * when the server is unreachable or answers non-2xx (→ `available: false` in
   * the read). On a clean reach with `autostart` requested but the server down,
   * a single best-effort `process-compose up -D` is attempted first.
   */
  async processes(): Promise<ProcessState[] | undefined> {
    const res = await this.tryProcesses();
    if (res === undefined && this.options.autostart && !this.autostartAttempted) {
      this.autostartAttempted = true;
      this.startServer();
      // Best-effort only: we don't block the read waiting for the server to
      // bind. A subsequent poll (5s refresh) picks it up once it's live.
    }
    return res;
  }

  /** One `GET /processes` attempt; `undefined` on any failure / non-2xx. */
  private async tryProcesses(): Promise<ProcessState[] | undefined> {
    let res: { status: number; body: unknown };
    try {
      res = await this.fetchJson({ target: this.target, method: "GET", path: "/processes" });
    } catch {
      return undefined;
    }
    if (res.status < 200 || res.status >= 300) return undefined;
    return extractProcesses(res.body);
  }

  /**
   * Best-effort `process-compose up -D` (detached, no TUI) against the configured
   * compose file. Wrapped so a missing binary or any spawn error never throws
   * into the read — it just logs and the next poll retries the connection.
   */
  private startServer(): void {
    const spawnFn = this.options.spawn ?? spawn;
    const args = ["up", "-D"];
    if (this.options.composeFile) args.push("-f", this.options.composeFile);
    if (this.options.socket) args.push("--use-uds", "--unix-socket", this.options.socket);
    try {
      const child = spawnFn("process-compose", args, { detached: true, stdio: "ignore" });
      child.on("error", (err: Error) => {
        this.options.log?.(`process-compose autostart failed: ${err.message}`);
      });
      child.unref();
      this.options.log?.("process-compose autostart attempted (up -D)");
    } catch (err) {
      this.options.log?.(`process-compose autostart failed: ${errorMessage(err)}`);
    }
  }
}

/** Pull the `data` array out of a `GET /processes` body, tolerating shapes. */
function extractProcesses(body: unknown): ProcessState[] {
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: ProcessState[] }).data.filter(
      (p): p is ProcessState => !!p && typeof p === "object" && typeof p.name === "string",
    );
  }
  return [];
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
