#!/usr/bin/env node
import { startDaemon } from "./index.js";

startDaemon().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
