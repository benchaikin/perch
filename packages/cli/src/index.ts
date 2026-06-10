/**
 * @perch/cli — the `perch` command.
 *
 * A thin JSON-RPC client of `perchd`. Commands are generated from the registry
 * the daemon exposes (every CLI-exposed capability → a subcommand), with
 * `--json` and `--watch` support.
 *
 * M3 implements the client + command generation.
 */
export async function run(argv: string[]): Promise<void> {
  // TODO(M3): connect to perchd, fetch the registry, dispatch the command.
  void argv;
  throw new Error("perch CLI: not yet implemented (M3)");
}
