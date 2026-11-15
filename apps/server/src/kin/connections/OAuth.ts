// @effect-diagnostics-next-line nodeBuiltinImport:off -- PKCE verifier, challenge and state.
import * as NodeCrypto from "node:crypto";
import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/** An authorization server as its own metadata describes it, checked against the issuer asked. */
export type AuthServer = {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | undefined;
  /** The server says it adds `iss` to its redirect, so a redirect without one is refused. */
  readonly issParameter: boolean;
  readonly basicOnly: boolean;
};

/** Where to sign in for one MCP server, and what to ask for. */
export type SignInPlan = {
  readonly server: AuthServer;
  /** The protected resource's identifier, sent as `resource` on both requests. */
  readonly resource: string | undefined;
  readonly scope: string | undefined;
};

export type Client = { readonly clientId: string; readonly clientSecret: string | undefined };

export type Tokens = {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** Epoch ms; undefined when the server gave no lifetime. */
  readonly expiresAt: number | undefined;
  readonly scope: string | undefined;
};

const fail = (message: string) => new KinChatError({ reason: "unavailable", message });

/** The service no longer accepts the sign-in (`invalid_grant`): the owner signs in again. */
export class SignInExpired extends Schema.TaggedError<SignInExpired>()("SignInExpired", {}) {}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const randomToken = () => base64url(NodeCrypto.randomBytes(32));
export const challengeOf = (verifier: string) =>
  base64url(NodeCrypto.createHash("sha256").update(verifier).digest());

const str = (value: unknown, name: string) => {
  const field = Predicate.hasProperty(value, name) ? value[name] : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
};
const strings = (value: unknown, name: string) => {
  const field = Predicate.hasProperty(value, name) ? value[name] : undefined;
  return Array.isArray(field) ? field.filter((entry) => typeof entry === "string") : undefined;
};
const https = (value: string | undefined) =>
  value !== undefined && URL.canParse(value) && new URL(value).protocol === "https:"
    ? value
    : undefined;

/** GET a JSON document, or `undefined` when it isn't there. Never throws the server's text. */
const getJson = (http: HttpClient.HttpClient, url: string) =>
  http.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson)).pipe(
    Effect.flatMap((response) => (response.status === 200 ? response.json : Effect.undefined)),
    Effect.orElseSucceed(() => undefined),
  );

/** `Bearer resource_metadata="…", scope="…"` from a 401, as RFC 9728 §5.1 describes it. */
const challengeParams = (header: string | undefined) => {
  const params = new Map<string, string>();
  for (const match of (header ?? "").matchAll(/([\w-]+)="([^"]*)"/g))
    params.set(match[1]!.toLowerCase(), match[2]!);
  return { resourceMetadata: params.get("resource_metadata"), scope: params.get("scope") };
};

const wellKnown = (url: URL, name: string) => {
  const path = url.pathname.replace(/\/$/, "");
  return [
    ...(path === "" ? [] : [`${url.origin}/.well-known/${name}${path}`]),
    `${url.origin}/.well-known/${name}`,
  ];
};

/** An authorization server's metadata (RFC 8414, then OpenID), only if it names this issuer. */
const authServer = Effect.fn("KinOAuth.authServer")(function* (
  http: HttpClient.HttpClient,
  issuer: string,
) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const candidates = [
    ...wellKnown(url, "oauth-authorization-server"),
    ...wellKnown(url, "openid-configuration"),
    ...(path === "" ? [] : [`${url.origin}${path}/.well-known/openid-configuration`]),
  ];
  for (const candidate of new Set(candidates)) {
    const document = yield* getJson(http, candidate);
    if (document === undefined) continue;
    if (str(document, "issuer") !== issuer)
      return yield* fail("The service's sign-in server didn't describe itself consistently.");
    const authorizationEndpoint = https(str(document, "authorization_endpoint"));
    const tokenEndpoint = https(str(document, "token_endpoint"));
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined)
      return yield* fail("The service's sign-in server is missing its sign-in addresses.");
    // The MCP spec makes PKCE support a MUST, and its absence a reason to stop.
    if (!(strings(document, "code_challenge_methods_supported") ?? []).includes("S256"))
      return yield* fail("The service's sign-in server doesn't support Kin's secure sign-in.");
    const methods = strings(document, "token_endpoint_auth_methods_supported");
    return {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: https(str(document, "registration_endpoint")),
      issParameter:
        Predicate.hasProperty(document, "authorization_response_iss_parameter_supported") &&
        document.authorization_response_iss_parameter_supported === true,
      basicOnly:
        methods !== undefined &&
        methods.includes("client_secret_basic") &&
        !methods.includes("client_secret_post"),
    } satisfies AuthServer;
  }
  return yield* fail("Kin couldn't find the service's sign-in server.");
});

/**
 * Where an MCP server sends Kin to sign in: its 401 names the resource metadata (RFC 9728), which
 * names the authorization server. An older server without that metadata is its own issuer.
 */
export const discover = Effect.fn("KinOAuth.discover")(function* (
  http: HttpClient.HttpClient,
  mcpUrl: string,
) {
  const probe = yield* http
    .execute(
      HttpClientRequest.post(mcpUrl).pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "kin", version: "1" },
          },
        }),
      ),
    )
    .pipe(Effect.mapError(() => fail(`Kin couldn't reach ${new URL(mcpUrl).host}.`)));
  if (probe.status !== 401)
    return yield* fail(`${new URL(mcpUrl).host} didn't ask Kin to sign in (HTTP ${probe.status}).`);
  const challenge = challengeParams(probe.headers["www-authenticate"]);
  const target = new URL(mcpUrl);
  const metadataUrls =
    https(challenge.resourceMetadata) === undefined
      ? wellKnown(target, "oauth-protected-resource")
      : [challenge.resourceMetadata!];
  let metadata: unknown;
  for (const url of metadataUrls) {
    metadata = yield* getJson(http, url);
    if (metadata !== undefined) break;
  }
  const issuer =
    metadata === undefined ? target.origin : https(strings(metadata, "authorization_servers")?.[0]);
  if (issuer === undefined) return yield* fail("The service didn't say where to sign in.");
  const scopes = metadata === undefined ? undefined : strings(metadata, "scopes_supported");
  return {
    server: yield* authServer(http, issuer),
    resource: metadata === undefined ? undefined : str(metadata, "resource"),
    scope: challenge.scope ?? (scopes === undefined ? undefined : scopes.join(" ")),
  } satisfies SignInPlan;
});

/** Dynamic client registration (RFC 7591), the route Zoho and Sentry still take. */
export const register = Effect.fn("KinOAuth.register")(function* (
  http: HttpClient.HttpClient,
  server: AuthServer,
  redirectUri: string,
) {
  if (server.registrationEndpoint === undefined)
    return yield* fail("This service needs a sign-in client set up first.");
  const response = yield* http
    .execute(
      HttpClientRequest.post(server.registrationEndpoint).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({
          client_name: "Kin",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "web",
        }),
      ),
    )
    .pipe(Effect.mapError(() => fail("Kin couldn't register with the service's sign-in.")));
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  const clientId = str(body, "client_id");
  if (response.status >= 300 || clientId === undefined)
    return yield* fail("The service refused Kin's sign-in registration.");
  return { clientId, clientSecret: str(body, "client_secret") } satisfies Client;
});

export const authorizationUrl = (input: {
  readonly plan: SignInPlan;
  readonly client: Client;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
  readonly extra?: Readonly<Record<string, string>>;
}) => {
  const url = new URL(input.plan.server.authorizationEndpoint);
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: input.client.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: challengeOf(input.verifier),
    code_challenge_method: "S256",
    resource: input.plan.resource,
    scope: input.plan.scope,
    ...input.extra,
  };
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
};

/** What came back on the redirect: the code, or the service's error code (never its text). */
export const redirectResult = (response: string) => {
  const trimmed = response.trim();
  const query = URL.canParse(trimmed)
    ? new URL(trimmed).searchParams
    : new URLSearchParams(trimmed.replace(/^[^?]*\?/, ""));
  const one = (key: string) => {
    const values = query.getAll(key);
    return values.length === 1 && values[0] !== "" ? values[0] : undefined;
  };
  return { state: one("state"), code: one("code"), error: one("error"), iss: one("iss") };
};

const tokenRequest = Effect.fn("KinOAuth.tokenRequest")(function* (
  http: HttpClient.HttpClient,
  server: Pick<AuthServer, "tokenEndpoint" | "basicOnly">,
  client: Client,
  params: Readonly<Record<string, string | undefined>>,
  now: number,
) {
  const form: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...params,
    client_id: client.clientId,
    ...(client.clientSecret !== undefined && !server.basicOnly
      ? { client_secret: client.clientSecret }
      : {}),
  }))
    if (value !== undefined) form[key] = value;
  let request = HttpClientRequest.post(server.tokenEndpoint).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyUrlParams(form),
  );
  if (client.clientSecret !== undefined && server.basicOnly)
    request = HttpClientRequest.basicAuth(
      request,
      encodeURIComponent(client.clientId),
      encodeURIComponent(client.clientSecret),
    );
  const response = yield* http
    .execute(request)
    .pipe(Effect.mapError(() => fail("Kin couldn't reach the service's sign-in server.")));
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  if (response.status === 400 && str(body, "error") === "invalid_grant")
    return yield* new SignInExpired();
  const accessToken = str(body, "access_token");
  if (response.status !== 200 || accessToken === undefined)
    return yield* fail(
      `The service's sign-in server refused Kin (${str(body, "error") ?? `HTTP ${response.status}`}).`.replace(
        /[^\w .,()'-]/g,
        "",
      ),
    );
  const expiresIn = Predicate.hasProperty(body, "expires_in") ? Number(body.expires_in) : NaN;
  return {
    accessToken,
    refreshToken: str(body, "refresh_token") ?? params.refresh_token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scope: str(body, "scope"),
  } satisfies Tokens;
});

export const exchange = (
  http: HttpClient.HttpClient,
  input: {
    readonly server: Pick<AuthServer, "tokenEndpoint" | "basicOnly">;
    readonly client: Client;
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
    readonly resource: string | undefined;
    readonly now: number;
  },
) =>
  tokenRequest(
    http,
    input.server,
    input.client,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: input.resource,
    },
    input.now,
  );

export const refresh = (
  http: HttpClient.HttpClient,
  input: {
    readonly server: Pick<AuthServer, "tokenEndpoint" | "basicOnly">;
    readonly client: Client;
    readonly refreshToken: string;
    readonly resource: string | undefined;
    readonly now: number;
  },
) =>
  tokenRequest(
    http,
    input.server,
    input.client,
    { grant_type: "refresh_token", refresh_token: input.refreshToken, resource: input.resource },
    input.now,
  );
