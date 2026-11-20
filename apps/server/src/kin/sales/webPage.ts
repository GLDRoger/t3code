import * as NodeDns from "node:dns";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { KinChatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

import { normalizeHostname } from "@t3tools/shared/hostClassification";

import { guardedLookup, urlRefusal } from "../connections/EgressGuard.ts";
import { ownHosts } from "../publicAddress.ts";
import { clean } from "../connections/ResultText.ts";
import {
  PAGE_ENCODED,
  PAGE_NOT_HTTPS,
  PAGE_NOT_TEXT,
  PAGE_PORT,
  PAGE_REFUSED,
  PAGE_SELF,
  PAGE_TOO_MANY_REDIRECTS,
  PAGE_UNREACHABLE,
  pageStatus,
  pageTooBig,
  pageTooSlow,
} from "./text.ts";
import { pageText } from "./pageText.ts";

/** A page's readable text is cut here; what is past it is dropped. */
export const PAGE_TEXT_CHARS = 40_000;
const PAGE_MEGABYTES = 1;
const PAGE_BYTES = PAGE_MEGABYTES * 1024 * 1024;
const PAGE_SECONDS = 20;
const REDIRECTS_MAX = 5;
const TITLE_MAX = 200;
/** Links a page gives that the turn may open next (`OutsideContent.ts`); past this they are not kept. */
const PAGE_LINKS = 500;
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

export type WebPage = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  /** Its text ran past `PAGE_TEXT_CHARS`. */
  readonly cut: boolean;
  /** The links its text shows, as absolute addresses. */
  readonly links: ReadonlyArray<string>;
};

const notRead = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** Whether the socket's lookup refused the address it resolved (`guardedLookup`), however wrapped. */
const lookupRefused = (error: unknown, depth = 0): boolean =>
  depth < 8 &&
  Predicate.isObject(error) &&
  (Reflect.get(error, "name") === "EgressRefused" ||
    Reflect.get(error, "code") === "EKINEGRESS" ||
    lookupRefused(Reflect.get(error, "cause"), depth + 1) ||
    lookupRefused(Reflect.get(error, "reason"), depth + 1));

/**
 * Reads one public https page for an agent. Every address, the first and each redirect's, passes
 * `urlRefusal`, port 443 and Kin's own hosts, and every socket resolves through `guardedLookup`,
 * so no hop reaches this machine, its networks, a metadata address or Kin's public front door. Kin follows a few redirects itself; the client follows none.
 */
export class KinWebPages extends Context.Service<
  KinWebPages,
  { readonly read: (address: string) => Effect.Effect<WebPage, KinChatError> }
>()("t3/kin/sales/webPage/KinWebPages") {}

type Hop =
  | { readonly _tag: "redirect"; readonly to: URL }
  | { readonly _tag: "page"; readonly page: WebPage };

const make = Effect.gen(function* () {
  // Each hop's response, body and all, is released when that hop's scope closes.
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  // Read where Kin keeps its public address, with the setting and T3 Connect as built.
  const own = ownHosts().pipe(Effect.provideContext(yield* Effect.context<never>()));
  const hop = Effect.fn("KinWebPages.hop")(function* (url: URL, last: boolean) {
    const response = yield* client
      .get(url.href, {
        headers: {
          accept: "text/html, application/xhtml+xml, text/plain;q=0.8",
          "accept-encoding": "identity",
        },
      })
      .pipe(
        Effect.mapError((error) => notRead(lookupRefused(error) ? PAGE_REFUSED : PAGE_UNREACHABLE)),
        // No client span: no trace headers go to the site, and no address lands in a trace.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers["location"];
      if (location === undefined || !URL.canParse(location, url.href))
        return yield* notRead(pageStatus(response.status));
      if (last) return yield* notRead(PAGE_TOO_MANY_REDIRECTS);
      return { _tag: "redirect", to: new URL(location, url.href) } satisfies Hop;
    }
    if (response.status >= 400) return yield* notRead(pageStatus(response.status));
    const type = response.headers["content-type"] ?? "text/html";
    if (!TEXT_TYPES.test(type)) return yield* notRead(PAGE_NOT_TEXT);
    const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
    if (encoding !== "identity" && encoding !== "") return yield* notRead(PAGE_ENCODED);
    const declared = Number(response.headers["content-length"] ?? "0");
    if (declared > PAGE_BYTES) return yield* notRead(pageTooBig(PAGE_MEGABYTES));
    const parts: Array<Uint8Array> = [];
    let size = 0;
    yield* response.stream.pipe(
      Stream.mapError(() => notRead(PAGE_UNREACHABLE)),
      Stream.runForEach((chunk) => {
        size += chunk.length;
        if (size > PAGE_BYTES) return Effect.fail(notRead(pageTooBig(PAGE_MEGABYTES)));
        parts.push(chunk);
        return Effect.void;
      }),
    );
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    const raw = new TextDecoder().decode(bytes);
    const read = /^text\/plain\b/i.test(type)
      ? (() => {
          const text = raw.trim();
          const cut = text.length > PAGE_TEXT_CHARS;
          return {
            title: "",
            text: cut ? text.slice(0, PAGE_TEXT_CHARS) : text,
            links: [],
            cut,
          };
        })()
      : pageText(raw, url, { chars: PAGE_TEXT_CHARS, links: PAGE_LINKS, title: TITLE_MAX });
    return {
      _tag: "page",
      page: {
        url: url.href,
        title: clean(read.title) || url.hostname,
        text: clean(read.text),
        cut: read.cut,
        links: read.links,
      },
    } satisfies Hop;
  }, Effect.scoped);
  const read = Effect.fn("KinWebPages.read")(
    function* (address: string) {
      if (!URL.canParse(address)) return yield* notRead(PAGE_NOT_HTTPS);
      let url = new URL(address);
      const self = new Set(yield* own);
      for (let count = 0; ; count += 1) {
        url.hash = "";
        if (url.protocol !== "https:") return yield* notRead(PAGE_NOT_HTTPS);
        if (urlRefusal(url) !== undefined) return yield* notRead(PAGE_REFUSED);
        // https on 443 only (the parser drops an explicit 443), and never Kin itself.
        if (url.port !== "") return yield* notRead(PAGE_PORT);
        if (self.has(normalizeHostname(url.hostname))) return yield* notRead(PAGE_SELF);
        const answer = yield* hop(url, count >= REDIRECTS_MAX);
        if (answer._tag === "page") return answer.page;
        url = answer.to;
      }
    },
    (effect) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(PAGE_SECONDS),
          orElse: () => Effect.fail(notRead(pageTooSlow(PAGE_SECONDS))),
        }),
      ),
  );
  return KinWebPages.of({ read });
});

/** On whichever client is beneath: a fake one in tests. */
export const layerFromClient = Layer.effect(KinWebPages, make);

/** The socket's resolver, a fake one in tests, with the guard's address check on every connection. */
export const layerWithLookup = (resolve: Parameters<typeof guardedLookup>[0]) =>
  layerFromClient.pipe(
    Layer.provide(
      NodeHttpClient.layerUndiciOptions({ connect: { lookup: guardedLookup(resolve) } }),
    ),
  );

/** undici, which follows no redirects, resolving through the guard. */
export const layer = layerWithLookup(NodeDns.lookup);
