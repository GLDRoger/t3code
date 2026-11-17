import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { GH_APP_FOLDER } from "./ghSign.ts";

/**
 * The GitHub App Kin made in Settings: its public facts, beside the shell's files. Its key is only
 * in the keyring. A host's `KIN_GITHUB_APP_ID` still names the App when set, and wins.
 */
export const StoredApp = Schema.Struct({
  appId: Schema.Int,
  slug: Schema.String,
  name: Schema.String,
  /** The account that owns it on GitHub. */
  owner: Schema.String,
  at: Schema.Int,
  /** Who made it in Kin, by name. */
  by: Schema.String,
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
