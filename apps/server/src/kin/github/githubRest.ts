import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

export interface GitHubStatusResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** GitHub's error `message`, when the body is JSON with one. The rest of the body is dropped. */
  readonly message: string | undefined;
}

const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String) });
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

/** One GitHub REST call where only the status, headers and error message matter. */
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
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  return {
    status: response.status,
    headers: response.headers,
    message: decodeErrorBody(text).pipe(
      Option.flatMap((body) => Option.fromNullishOr(body.message)),
      Option.getOrUndefined,
    ),
  } satisfies GitHubStatusResponse;
});

/**
 * GitHub's rate limits: 429, or a 403 that says so in its headers. A rate-limited refusal says
 * nothing about the token's permissions.
 */
export const isGitHubRateLimit = (
  answer: Pick<GitHubStatusResponse, "status" | "headers"> & {
    readonly message?: string | null | undefined;
  },
) =>
  answer.status === 429 ||
  (answer.status === 403 &&
    (answer.headers["x-ratelimit-remaining"] === "0" ||
      answer.headers["retry-after"] !== undefined ||
      // GitHub's secondary limit can come with neither header.
      (answer.message?.toLowerCase().includes("secondary rate limit") ?? false)));

/** `/repos/{owner}/{name}` for an `owner/name` slug. */
export const repoPath = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};

export interface GitHubAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** GitHub's `message`, or "" when the body has none. Error messages carry no credential. */
  readonly message: string;
  readonly body: unknown;
}

/** One GitHub REST call whose answer is judged by the caller; any status is returned. */
export const gitHubAnswer = Effect.fn("KinGitHub.answer")(function* (input: {
  readonly client: HttpClient.HttpClient;
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
  const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : "";
  return {
    status: response.status,
    headers: response.headers,
    message,
    body,
  } satisfies GitHubAnswer;
});
