import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export class T3GitHubCredentialError extends Schema.TaggedError<T3GitHubCredentialError>()(
  "T3GitHubCredentialError",
  // A fixed reason, never the credential or anything GitHub answered.
  { reason: Schema.String },
) {
  override get message(): string {
    return `Could not read T3's GitHub credential (${this.reason}).`;
  }
}

export interface T3HeldCredential {
  readonly token: Redacted.Redacted<string>;
  readonly source: string;
}
type ReadT3Credential = Effect.Effect<Option.Option<T3HeldCredential>, T3GitHubCredentialError>;

/**
 * T3's own credential for github.com, as `GitHubRequestPolicy.credential` picks it. The executor
 * is built before the server's source control host, so the server installs the reader later
 * (`install`); until then every read fails, and so does the credential check.
 */
export class T3GitHubCredential extends Context.Service<
  T3GitHubCredential,
  {
    readonly read: ReadT3Credential;
    readonly install: (read: ReadT3Credential) => Effect.Effect<void>;
  }
>()("t3/kin/approvals/T3GitHubCredential") {}

export const slotLayer = Layer.effect(
  T3GitHubCredential,
  Effect.gen(function* () {
    const reader = yield* Ref.make(Option.none<ReadT3Credential>());
    return T3GitHubCredential.of({
      read: Ref.get(reader).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new T3GitHubCredentialError({ reason: "the reader isn't installed" })),
            onSome: (read) => read,
          }),
        ),
      ),
      install: Effect.fn("T3GitHubCredential.install")(function* (read: ReadT3Credential) {
        yield* Ref.set(reader, Option.some(read));
      }),
    });
  }),
);

/** What `credential` fails with when T3 simply has no GitHub credential for the host. */
const NO_CREDENTIAL = new Set([
  "GitHubCliMissingError",
  "GitHubNotSignedInError",
  "GitHubHostDisabledError",
]);

/**
 * Reads through a second `GitHubRequestPolicy`, since the driver builds its own privately. Both
 * share the server's settings, secrets and rate-limit pause; only their token caches differ.
 */
export const installLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* T3GitHubCredential;
    const policy = yield* GitHubDriver.GitHubRequestPolicy;
    yield* slot.install(
      policy.credential("github.com").pipe(
        Effect.map((held) =>
          Option.some<T3HeldCredential>({ token: held.token, source: held.source ?? "unknown" }),
        ),
        Effect.catch((error) =>
          NO_CREDENTIAL.has(error._tag)
            ? Effect.succeedNone
            : Effect.fail(new T3GitHubCredentialError({ reason: error._tag })),
        ),
      ),
    );
  }),
).pipe(Layer.provide(GitHubDriver.gitHubRequestPolicyLayer));
