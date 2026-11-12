import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import { hostShell, readStatus } from "../lead/workSandbox.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The last sandbox check a worker's start ran on this host, and what the host now asks for. */
export const workerShellCommand = Command.make("worker-shell", {
  ...authLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of a status line."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Say whether Kin's workers get a sandboxed shell here. Each worker's start runs the check; this shows the last result.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      const host = hostShell(yield* HostProcess.Environment);
      const last = yield* readStatus(config.stateDir);
      if (flags.json)
        return yield* Console.log(yield* encodeJson({ host, last: Option.getOrNull(last) }));
      const asked =
        host._tag === "off"
          ? `off: ${host.reason}`
          : `on if the check passes; hosts are set in Kin's settings${host.domains.length === 0 ? "" : `, plus ${host.domains.join(", ")} from this host`}`;
      const checked = Option.match(last, {
        onNone: () => "no worker has started since this host kept a check",
        onSome: (status) =>
          `${status.shell ? "shell" : "file tools only"} since ${DateTime.formatIso(DateTime.makeUnsafe(status.checkedAt))}: ${status.reason}${status.claudeCodeVersion === null ? "" : ` (Claude Code ${status.claudeCodeVersion})`}${(status.install ?? []).length === 0 ? "" : `; install ${(status.install ?? []).join(", ")}`}`,
      });
      yield* Console.log(`Worker shell: ${asked}. Last check: ${checked}.`);
    }),
  ),
);
