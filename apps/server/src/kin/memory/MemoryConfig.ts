import type { KinOrgId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { isCredentialHelperReference, isSshCommandReference } from "./purgePush.ts";

export class MemoryConfig extends Context.Service<
  MemoryConfig,
  {
    readonly baseDirectory: string;
    readonly defaultBranch?: string;
    readonly botName?: string;
    readonly credentialHelper?: string;
    readonly sshCommand?: string;
    readonly botEmail?: string;
    readonly repositories: ReadonlyArray<{
      readonly orgId: KinOrgId;
      readonly repoUrl: string;
      readonly path: string;
    }>;
  }
>()("t3/kin/memory/MemoryConfig") {}

export class MemoryCredentialConfigError extends Schema.TaggedError<MemoryCredentialConfigError>()(
  "MemoryCredentialConfigError",
  { variable: Schema.Literals(["KIN_MEMORY_CREDENTIAL_HELPER", "KIN_MEMORY_SSH_COMMAND"]) },
) {
  override get message(): string {
    return this.variable === "KIN_MEMORY_CREDENTIAL_HELPER"
      ? "KIN_MEMORY_CREDENTIAL_HELPER must be a git credential helper name or absolute path, not an inline script."
      : "KIN_MEMORY_SSH_COMMAND must be a plain ssh command naming its key file, without shell syntax.";
  }
}

const credential = Effect.fn("MemoryConfig.credential")(function* (
  variable: MemoryCredentialConfigError["variable"],
  valid: (value: string) => boolean,
) {
  const value = yield* Config.option(Config.String(variable));
  if (Option.isSome(value) && !valid(value.value))
    return yield* new MemoryCredentialConfigError({ variable });
  return Option.getOrUndefined(value);
});

export const layer = (
  repositories: ReadonlyArray<{ readonly orgId: KinOrgId; readonly repoUrl: string }>,
) =>
  Layer.effect(
    MemoryConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      // Only memory git reads these; a server-wide GIT_SSH_COMMAND would reach every agent's git.
      const credentialHelper = yield* credential(
        "KIN_MEMORY_CREDENTIAL_HELPER",
        isCredentialHelperReference,
      );
      const sshCommand = yield* credential("KIN_MEMORY_SSH_COMMAND", isSshCommandReference);
      return MemoryConfig.of({
        baseDirectory: path.join(config.stateDir, "kin"),
        ...(credentialHelper === undefined ? {} : { credentialHelper }),
        ...(sshCommand === undefined ? {} : { sshCommand }),
        repositories: repositories.map((repo) => ({
          ...repo,
          path: encodeURIComponent(repo.orgId),
        })),
      });
    }),
  );
