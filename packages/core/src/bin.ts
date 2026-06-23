#!/usr/bin/env node
import { startDaemon } from "./index.js";

// `perchd`              → load enabled plugins from perch.yaml.
// `perchd <pkg…>`       → override: load exactly these plugin package ids.
const args = process.argv.slice(2);
const options = args.length > 0 ? { plugins: args } : {};

startDaemon(options)
  .then((daemon) => {
    console.error(`perchd listening on ${daemon.socketPath}`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
