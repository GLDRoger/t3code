import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * The keyring item hosts set up before November 2026 kept the GitHub App's key in, account
 * `<app id>`. Kin only reads it, to copy it into its secret store once (see `appKey.ts`).
 */
const SERVICE = "kin-github-app";

export class KinKeychainError extends Schema.TaggedError<KinKeychainError>()("KinKeychainError", {
  operation: Schema.Literals(["secret_service", "load", "get"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.operation === "secret_service"
      ? `No Secret Service (org.freedesktop.secrets) answers on this user's D-Bus session, so Kin won't read the ${SERVICE} item. Start one for this user, such as gnome-keyring-daemon.`
      : `The OS keychain refused to ${this.operation} the ${SERVICE} item.`;
  }
}

/** Reads the App's keyring item. The value leaves only as `Redacted`, never in errors or logs. */
export class KinKeychain extends Context.Service<
  KinKeychain,
  {
    readonly appSecret: (
      appId: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KinKeychainError>;
  }
>()("t3/kin/github/Keychain/KinKeychain") {}

const SECRET_SERVICE_PING = {
  dest: "org.freedesktop.secrets",
  path: "/org/freedesktop/secrets",
  method: "org.freedesktop.DBus.Peer.Ping",
} as const;

/** Pings the Secret Service on the session bus (activating it if installed): dbus-send, else gdbus. */
const probeSecretService = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const answers = (command: string, args: ReadonlyArray<string>) =>
    spawner
      .exitCode(
        ChildProcess.make(command, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: "1 second",
        }),
      )
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.map((code) => code === 0),
        Effect.orElseSucceed(() => false),
      );
  const { dest, path, method } = SECRET_SERVICE_PING;
  if (yield* answers("dbus-send", ["--session", "--print-reply", `--dest=${dest}`, path, method]))
    return true;
  return yield* answers("gdbus", [
    "call",
    "--session",
    "--dest",
    dest,
    "--object-path",
    path,
    "--method",
    method,
  ]);
});

// gnome-keyring's plaintext keyring rewrote escapes when it reloaded its file, which broke the
// App's JSON (a PEM in a string); the setup script stored it base64 behind this prefix.
const ENCODED = "kin-b64:";
const decodeSecret = (stored: string) =>
  stored.startsWith(ENCODED)
    ? Buffer.from(stored.slice(ENCODED.length), "base64").toString("utf8")
    : stored;

/**
 * `@napi-rs/keyring` 1.3.0 on Linux silently uses kernel keyutils when no Secret Service answers,
 * which loses items on reboot, so a Linux read checks for one first.
 */
const make = (options: {
  readonly platform: string;
  readonly secretServiceReachable: Effect.Effect<boolean>;
}) =>
  KinKeychain.of({
    appSecret: Effect.fn("KinKeychain.appSecret")(function* (appId: string) {
      if (options.platform === "linux" && !(yield* options.secretServiceReachable))
        return yield* new KinKeychainError({
          operation: "secret_service",
          cause: "org.freedesktop.secrets did not answer",
        });
      // Loading the native binding at startup can stop other platforms from opening.
      const Keyring = yield* Effect.tryPromise({
        try: () => import("@napi-rs/keyring"),
        catch: (cause) => new KinKeychainError({ operation: "load", cause }),
      });
      const value = yield* Effect.tryPromise({
        try: () => new Keyring.AsyncEntry(SERVICE, appId).getPassword(),
        catch: (cause) => new KinKeychainError({ operation: "get", cause }),
      });
      return value === undefined || value === null || value === ""
        ? Option.none()
        : Option.some(Redacted.make(decodeSecret(value)));
    }),
  });

export const layer = Layer.effect(
  KinKeychain,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return make({
      platform: yield* HostProcess.Platform,
      secretServiceReachable: probeSecretService.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    });
  }),
);
