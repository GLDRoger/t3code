#!/usr/bin/env node
// Same launcher as `t3`. The name is passed through so help text says `kin`
// even after this script downloads and spawns the `t3` executable.
process.env.KIN_CLI_NAME = "kin";
await import("./t3.mjs");
