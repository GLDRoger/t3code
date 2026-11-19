// Loaded with `--import` into every process a look book instance starts; only the server freezes.
import { freezeFromEnv, install } from "./freeze.ts";

const freeze = freezeFromEnv();
if (freeze !== undefined && /apps[\\/]server[\\/]src[\\/]bin\.ts$/.test(process.argv[1] ?? ""))
  install(freeze, "/apps/server/src");
