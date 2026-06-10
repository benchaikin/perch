#!/usr/bin/env node
import { startDaemon } from "./index.js";

const plugins = process.argv.slice(2);

startDaemon({ plugins })
  .then((daemon) => {
    console.error(`perchd listening on ${daemon.socketPath}`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
