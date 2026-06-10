#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
