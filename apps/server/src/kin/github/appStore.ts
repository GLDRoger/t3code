import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { GH_APP_FOLDER } from "./ghSign.ts";

/**
 * Kin's GitHub App as Settings holds it: its public facts, beside the shell's files; its key is in
 * the server's secret store. One the host's environment named is adopted into this record once.
 */
export const StoredApp = Schema.Struct({
  appId: Schema.Int,
  slug: Schema.String,
  name: Schema.String,
  /** The account that owns it, in GitHub's casing. */
  owner: Schema.String,
  botLogin: Schema.optional(Schema.String),
  /** When and by whom it was made in Kin; null for an App adopted from the host's environment. */
  at: Schema.NullOr(Schema.Int),
  by: Schema.NullOr(Schema.String),
  /** An owner's yes to Kin setting this App's webhook, for one Kin didn't make: who, and when. */
  hookAllowed: Schema.optional(Schema.Struct({ by: Schema.String, at: Schema.Int })),
});
export type StoredApp = typeof StoredApp.Type;

const Json = Schema.fromJsonString(StoredApp);
const decode = Schema.decodeUnknownOption(Json);
const encode = Schema.encodeSync(Json);

const file = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  return path.join(stateDir, "kin", GH_APP_FOLDER, "app.json");
});

export const readStoredApp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(yield* file).pipe(Effect.orElseSucceed(() => ""));
  return text === "" ? Option.none<StoredApp>() : decode(text);
});

export const writeStoredApp = Effect.fn("KinGitHubApp.store")(function* (app: StoredApp) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* file;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(`${target}.next`, encode(app), { mode: 0o600 });
  yield* fs.rename(`${target}.next`, target);
});

export const removeStoredApp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* file, { force: true });
});

/**
 * The App id from the host's environment that Settings already adopted or disconnected: from then
 * on that id is Settings' to keep or drop, and a restart doesn't bring it back.
 */
const seedFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  return path.join(stateDir, "kin", GH_APP_FOLDER, "seed-taken");
});

export const readSeedTaken = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readFileString(yield* seedFile).pipe(Effect.orElseSucceed(() => ""))).trim();
});

export const writeSeedTaken = Effect.fn("KinGitHubApp.seedTaken")(function* (appId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* seedFile;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(target, `${appId}\n`, { mode: 0o600 });
});
