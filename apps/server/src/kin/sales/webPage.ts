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

import { guardedLookup, urlRefusal } from "../connections/EgressGuard.ts";
import { htmlToText } from "../connections/MailText.ts";
import { clean } from "../connections/ResultText.ts";
import {
  PAGE_NOT_HTTPS,
  PAGE_NOT_TEXT,
  PAGE_REFUSED,
  PAGE_TOO_MANY_REDIRECTS,
  PAGE_UNREACHABLE,
  pageStatus,
  pageTooBig,
  pageTooSlow,
} from "./text.ts";

/** A page's readable text is cut here; what is past it is dropped. */
export const PAGE_TEXT_CHARS = 40_000;
const PAGE_MEGABYTES = 4;
const PAGE_BYTES = PAGE_MEGABYTES * 1024 * 1024;
const PAGE_SECONDS = 20;
const REDIRECTS_MAX = 5;
const TITLE_MAX = 200;
const TEXT_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

export type WebPage = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  /** Its text ran past `PAGE_TEXT_CHARS`. */
  readonly cut: boolean;
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

const titleOf = (html: string) =>
  htmlToText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .slice(0, TITLE_MAX);

/**
 * Reads one public https page for an agent. Every address, the first and each redirect's, passes
 * `urlRefusal`, and every socket resolves through `guardedLookup`, so no hop reaches this machine,
 * its networks or a metadata address. Kin follows a few redirects itself; the client follows none.
 */
export class KinWebPages extends Context.Service<
  KinWebPages,
  { readonly read: (address: string) => Effect.Effect<WebPage, KinChatError> }
>()("t3/kin/sales/webPage/KinWebPages") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fetchOnce = (url: URL) =>
    client
      .get(url.href, {
        headers: { accept: "text/html, application/xhtml+xml, text/plain;q=0.8" },
      })
      .pipe(
        Effect.mapError((error) => notRead(lookupRefused(error) ? PAGE_REFUSED : PAGE_UNREACHABLE)),
      );
  const read = Effect.fn("KinWebPages.read")(
    function* (address: string) {
      if (!URL.canParse(address)) return yield* notRead(PAGE_NOT_HTTPS);
      let url = new URL(address);
      for (let hop = 0; ; hop += 1) {
        url.hash = "";
        if (url.protocol !== "https:") return yield* notRead(PAGE_NOT_HTTPS);
        if (urlRefusal(url) !== undefined) return yield* notRead(PAGE_REFUSED);
        const response = yield* fetchOnce(url);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers["location"];
          if (location === undefined || !URL.canParse(location, url.href))
            return yield* notRead(pageStatus(response.status));
          if (hop >= REDIRECTS_MAX) return yield* notRead(PAGE_TOO_MANY_REDIRECTS);
          url = new URL(location, url.href);
          continue;
        }
        if (response.status >= 400) return yield* notRead(pageStatus(response.status));
        const type = response.headers["content-type"] ?? "text/html";
        if (!TEXT_TYPES.test(type)) return yield* notRead(PAGE_NOT_TEXT);
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > PAGE_BYTES) return yield* notRead(pageTooBig(PAGE_MEGABYTES));
        const chunks = yield* response.stream.pipe(
          Stream.mapError(() => notRead(PAGE_UNREACHABLE)),
          Stream.runFoldEffect(
            () => ({ size: 0, parts: [] as Array<Uint8Array> }),
            (body, chunk) =>
              body.size + chunk.length > PAGE_BYTES
                ? Effect.fail(notRead(pageTooBig(PAGE_MEGABYTES)))
                : Effect.succeed({ size: body.size + chunk.length, parts: [...body.parts, chunk] }),
          ),
        );
        const bytes = new Uint8Array(chunks.size);
        let at = 0;
        for (const part of chunks.parts) {
          bytes.set(part, at);
          at += part.length;
        }
        const raw = new TextDecoder().decode(bytes);
        const html = !/^text\/plain\b/i.test(type);
        const text = clean(html ? htmlToText(raw) : raw.trim());
        const cut = text.length > PAGE_TEXT_CHARS;
        return {
          url: url.href,
          title: clean(html ? titleOf(raw) : "") || url.hostname,
          text: cut ? text.slice(0, PAGE_TEXT_CHARS) : text,
          cut,
        } satisfies WebPage;
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
