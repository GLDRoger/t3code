import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The only items Kin keeps; anything else is refused so a caller can't read unrelated secrets. */
export const KinKeychainService = Schema.Literals(["kin-github-app", "kin-owner-merge"]);
export type KinKeychainService = typeof KinKeychainService.Type;

export class KinKeychainError extends Schema.TaggedError<KinKeychainError>()("KinKeychainError", {
  service: KinKeychainService,
  operation: Schema.Literals(["secret_service", "load", "get", "set", "remove"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.operation === "secret_service"
      ? `No Secret Service (org.freedesktop.secrets) answers on this user's D-Bus session, so Kin won't store or read the ${this.service} item: the keyring library would fall back to kernel keyutils, which loses it at logout or reboot. Start one for this user, such as gnome-keyring-daemon.`
      : `The OS keychain refused to ${this.operation} the ${this.service} item.`;
  }
}

/** OS keychain items. Values are secret: they leave only as `Redacted`, never in errors or logs. */
export class KinKeychain extends Context.Service<
  KinKeychain,
  {
    readonly get: (
      service: KinKeychainService,
      account: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, KinKeychainError>;
    readonly set: (
      service: KinKeychainService,
      account: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, KinKeychainError>;
    readonly remove: (
      service: KinKeychainService,
      account: string,
    ) => Effect.Effect<void, KinKeychainError>;
    /** Fails when this OS has no safe store; setup calls it before making a secret it must keep. */
    readonly ready: (service: KinKeychainService) => Effect.Effect<void, KinKeychainError>;
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
  if (yield* answers("dbus-send", ["--session", "--print-reply", `--dest=${dest}`, path, method])) {
    return true;
  }
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

/**
 * `@napi-rs/keyring` 1.3.0 on Linux silently uses kernel keyutils when no Secret Service answers,
 * and has no option to pin the backend, so every Linux operation checks for one first.
 */
export const make = (options: {
  readonly platform: string;
  readonly secretServiceReachable: Effect.Effect<boolean>;
}) => {
  const ready = Effect.fn("KinKeychain.ready")(function* (service: KinKeychainService) {
    if (options.platform !== "linux") return;
    if (!(yield* options.secretServiceReachable)) {
      return yield* new KinKeychainError({
        service,
        operation: "secret_service",
        cause: "org.freedesktop.secrets did not answer",
      });
    }
  });

  // Loading the native binding at startup can stop other platforms from opening (ChromiumKeys).
  const entry = (
    service: KinKeychainService,
    account: string,
    operation: KinKeychainError["operation"],
  ) =>
    ready(service).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => import("@napi-rs/keyring"),
          catch: (cause) => new KinKeychainError({ service, operation: "load", cause }),
        }),
      ),
      Effect.map((Keyring) => new Keyring.AsyncEntry(service, account)),
      Effect.withSpan("KinKeychain.entry", { attributes: { service, operation } }),
    );

  const get = Effect.fn("KinKeychain.get")(function* (
    service: KinKeychainService,
    account: string,
  ) {
    const item = yield* entry(service, account, "get");
    const value = yield* Effect.tryPromise({
      try: () => item.getPassword(),
      catch: (cause) => new KinKeychainError({ service, operation: "get", cause }),
    });
    return value === undefined || value === null || value === ""
      ? Option.none()
      : Option.some(Redacted.make(value));
  });

  const set = Effect.fn("KinKeychain.set")(function* (
    service: KinKeychainService,
    account: string,
    value: Redacted.Redacted<string>,
  ) {
    const item = yield* entry(service, account, "set");
    yield* Effect.tryPromise({
      try: () => item.setPassword(Redacted.value(value)),
      catch: (cause) => new KinKeychainError({ service, operation: "set", cause }),
    });
  });

  const remove = Effect.fn("KinKeychain.remove")(function* (
    service: KinKeychainService,
    account: string,
  ) {
    const item = yield* entry(service, account, "remove");
    yield* Effect.tryPromise({
      try: () => item.deleteCredential(),
      catch: (cause) => new KinKeychainError({ service, operation: "remove", cause }),
    });
  });

  return KinKeychain.of({ get, set, remove, ready });
};

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
