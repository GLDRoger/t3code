import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

// Kin's GitHub calls carry Kin's own credentials, so they don't go through GitHubRequestPolicy,
// which picks T3's credential for the host.
const GITHUB_API_URL = "https://api.github.com";

export class KinGitHubRequestError extends Schema.TaggedError<KinGitHubRequestError>()(
  "KinGitHubRequestError",
  {
    operation: Schema.String,
    // No `cause`: request and response bodies here can hold tokens and keys.
    stage: Schema.Literals(["transport", "status", "decode"]),
    status: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "transport":
        return `Could not reach GitHub for ${this.operation}.`;
      case "status":
        return `GitHub answered ${this.operation} with HTTP ${this.status ?? "?"}.`;
      case "decode":
        return `GitHub's answer to ${this.operation} was not in the expected shape.`;
    }
  }
}

export interface GitHubJsonResponse<A> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: A;
}

/** Standard headers for a Kin GitHub REST call. */
export const gitHubRequest = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  token: Redacted.Redacted<string> | undefined,
) => {
  const request = HttpClientRequest.make(method)(`${GITHUB_API_URL}${path}`).pipe(
    HttpClientRequest.setHeaders({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kin",
    }),
  );
  return token === undefined ? request : HttpClientRequest.bearerToken(request, token);
};

/** One GitHub REST call with a JSON answer; any status outside `okStatuses` fails with it only. */
export const gitHubJson = Effect.fn("KinGitHub.request")(function* <S extends Schema.Top>(input: {
  readonly client: HttpClient.HttpClient;
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly token?: Redacted.Redacted<string> | undefined;
  readonly body?: unknown;
  readonly schema: S;
  readonly okStatuses?: ReadonlyArray<number>;
}) {
  yield* Effect.annotateCurrentSpan({ "kin.github.operation": input.operation });
  const fail = (stage: KinGitHubRequestError["stage"], status?: number) =>
    new KinGitHubRequestError({
      operation: input.operation,
      stage,
      ...(status === undefined ? {} : { status }),
    });
  let request = gitHubRequest(input.method, input.path, input.token);
  if (input.body !== undefined) {
    request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
      Effect.mapError(() => fail("transport")),
    );
  }
  const response = yield* input.client
    .execute(request)
    .pipe(Effect.mapError(() => fail("transport")));
  if (!(input.okStatuses ?? [200]).includes(response.status)) {
    return yield* fail("status", response.status);
  }
  const body: S["Type"] = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(input.schema)),
    Effect.mapError(() => fail("decode", response.status)),
  );
  return { status: response.status, headers: response.headers, body } satisfies GitHubJsonResponse<
    S["Type"]
  >;
});

/** One GitHub REST call where only the status matters; the body is never read. */
export const gitHubStatus = Effect.fn("KinGitHub.status")(function* (input: {
  readonly client: HttpClient.HttpClient;
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly token: Redacted.Redacted<string>;
  readonly body?: unknown;
}) {
  yield* Effect.annotateCurrentSpan({ "kin.github.operation": input.operation });
  const fail = () => new KinGitHubRequestError({ operation: input.operation, stage: "transport" });
  let request = gitHubRequest(input.method, input.path, input.token);
  if (input.body !== undefined) {
    request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(Effect.mapError(fail));
  }
  const response = yield* input.client.execute(request).pipe(Effect.mapError(fail));
  return response.status;
});
