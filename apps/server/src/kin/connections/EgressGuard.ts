// @effect-diagnostics-next-line nodeBuiltinImport:off -- undici's connect takes Node's own lookup.
import * as NodeDns from "node:dns";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the type of that lookup.
import type * as NodeNet from "node:net";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { isPublicFaviconHost, normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

/** Why the gateway won't send a request to this URL, or `undefined` when it may. */
export const urlRefusal = (url: URL): string | undefined => {
  if (url.protocol !== "https:") return "Kin connects only over https.";
  if (url.username !== "" || url.password !== "")
    return "A connection's address can't carry a name or password; use the key field.";
  const host = normalizeHostname(url.hostname);
  const literal = host.includes(":") || /^[\d.]+$/.test(host);
  // A name is checked again on the address it resolves to; a literal never resolves.
  if (literal ? !isPublicFaviconHost(host) : !isPublicName(host))
    return "Kin connects only to public internet addresses, not to this machine or its networks.";
  return undefined;
};

const isPublicName = (host: string) =>
  host.includes(".") &&
  !["localhost", "local", "internal", "home.arpa", "ts.net"].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );

/** Loopback, private, link-local, CGNAT and tailnet, ULA, multicast, unspecified: all refused. */
const addressRefused = (address: string) => !isPublicFaviconHost(address);

// @effect-diagnostics-next-line extendsNativeError:off -- undici's lookup callback takes an Error.
export class EgressRefused extends Error {
  override readonly name = "EgressRefused";
}

type Resolve = (
  hostname: string,
  options: NodeDns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: Array<NodeDns.LookupAddress>) => void,
) => void;

/**
 * A `lookup` for the sockets the gateway opens: it refuses a name when any address it resolves
 * to is not public, so the check holds on the address actually connected to, rebinding or not.
 */
export const guardedLookup =
  (resolve: Resolve): NodeNet.LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, "", 4);
      const refused = addresses.find((entry) => addressRefused(entry.address));
      if (refused !== undefined || addresses.length === 0)
        return callback(
          Object.assign(
            new EgressRefused(
              "Kin connects only to public internet addresses, not to this machine or its networks.",
            ),
            { code: "EKINEGRESS" },
          ),
          "",
          4,
        );
      if (options.all === true) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first!.address, first!.family);
    });
  };

const refuse = (request: HttpClientRequest.HttpClientRequest, description: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description }),
  });

/** Every gateway request: a checked URL going in, and no redirect ever followed coming out. */
export const guard = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.mapRequestEffect((request) => {
      const reason = URL.canParse(request.url) ? urlRefusal(new URL(request.url)) : "Not a URL.";
      return reason === undefined ? Effect.succeed(request) : Effect.fail(refuse(request, reason));
    }),
    HttpClient.transformResponse(
      Effect.flatMap((response) =>
        response.status >= 300 && response.status < 400
          ? Effect.fail(
              refuse(
                response.request,
                `The server answered with a redirect (${response.status}); Kin doesn't follow them.`,
              ),
            )
          : Effect.succeed(response),
      ),
    ),
  );

/** Guards whichever client is beneath: undici in the server, a fake server in tests. */
export const guarded = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    return guard(yield* HttpClient.HttpClient);
  }),
);

/** The gateway's only way out: undici, which follows no redirects, with the guarded lookup. */
export const layer = guarded.pipe(
  Layer.provide(
    NodeHttpClient.layerUndiciOptions({ connect: { lookup: guardedLookup(NodeDns.lookup) } }),
  ),
);
