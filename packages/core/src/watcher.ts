/**
 * Config file watcher.
 *
 * Watches `perch.yaml` and invokes a callback (debounced) whenever it settles
 * after a change. Editors frequently *replace* a file atomically (write a temp
 * file, then rename over the target) rather than mutating it in place, which
 * tears down an `fs.watch` bound to the file inode. To stay robust we watch the
 * **containing directory** and filter to the config's basename; that survives
 * create/replace/atomic-rewrite and the file not existing yet. We additionally
 * re-arm the directory watch if it errors (e.g. the dir is recreated).
 *
 * Watching is opt-in at the daemon level (off in tests) so the core reload logic
 * never depends on real fs-watch timing; this module only debounces and fires.
 */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

/** Options for {@link ConfigWatcher}. */
export interface ConfigWatcherOptions {
  /** Absolute path to the config file to watch. */
  configPath: string;
  /** Called (debounced) after the file settles following a change. */
  onChange: () => void;
  /** Debounce window in ms; coalesces rapid events. Default 200. */
  debounceMs?: number;
  /** Optional logger for watch errors; defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Debounced watcher over a single config file. Watches the parent directory so
 * it is resilient to atomic replace and to the file being absent initially.
 * Call {@link ConfigWatcher.start} to begin and {@link ConfigWatcher.stop} for
 * cleanup (idempotent); no timers or watchers leak after `stop`.
 */
export class ConfigWatcher {
  readonly #path: string;
  readonly #dir: string;
  readonly #base: string;
  readonly #onChange: () => void;
  readonly #debounceMs: number;
  readonly #log: (message: string) => void;

  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(opts: ConfigWatcherOptions) {
    this.#path = opts.configPath;
    this.#dir = dirname(opts.configPath);
    this.#base = basename(opts.configPath);
    this.#onChange = opts.onChange;
    this.#debounceMs = opts.debounceMs ?? 200;
    this.#log = opts.log ?? ((m) => console.error(m));
  }

  /** Begin watching. Safe to call once; a second call is a no-op while running. */
  start(): void {
    if (this.#watcher || this.#stopped) return;
    this.#arm();
  }

  #arm(): void {
    if (this.#stopped) return;
    try {
      const watcher = watch(this.#dir, { persistent: false }, (_event, filename) => {
        // `filename` can be null on some platforms; treat null as "maybe ours".
        if (filename != null && basename(filename.toString()) !== this.#base) return;
        this.#schedule();
      });
      watcher.on("error", (err) => {
        this.#log(`perchd: config watch error on ${this.#path}: ${message(err)}`);
        // The directory watch died (e.g. dir replaced); re-arm on next tick.
        this.#rearm();
      });
      this.#watcher = watcher;
    } catch (err) {
      this.#log(`perchd: failed to watch config dir ${this.#dir}: ${message(err)}`);
    }
  }

  #rearm(): void {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = undefined;
    }
    if (this.#stopped) return;
    // Brief delay so a transient dir replace settles before we re-watch.
    const t = setTimeout(() => this.#arm(), 50);
    t.unref?.();
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#stopped) return;
      this.#onChange();
    }, this.#debounceMs);
    this.#timer.unref?.();
  }

  /** Stop watching and clear any pending debounce timer. Idempotent. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = undefined;
    }
  }
}

/** Structured `unknown`-error → message. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
