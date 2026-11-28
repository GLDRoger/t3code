/**
 * Mail as text an agent can read: the plain part when there is one, else the HTML with hidden
 * text dropped, and bodies of sign-in and security mail withheld. All of it stays outside text.
 */

import { isPlainAddress, type MailAuthResults } from "./MailProvider.ts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

// Text a reader never sees can still talk to an agent, so it goes before anything else.
const HIDDEN =
  /<(\w+)\b[^>]*?(?:\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0(?![.\d]))[^>]*>[\s\S]*?<\/\1\s*>/gi;

export const htmlToText = (html: string) => {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(HIDDEN, "");
    if (next === text) break;
    text = next;
  }
  text = text
    .replace(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, href, label) => `${label} (${href})`,
    )
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(text));
};

const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const SIGN_IN_MAIL =
  /\b(verification|security|confirmation|one[- ]time|sign[- ]?in|log[- ]?in|login|access|auth(?:entication)?) (code|link|pin)\b|\bpassword reset\b|\breset your password\b|\bmagic link\b|\b2fa\b|\botp\b|\bverify your (email|account|identity)\b/i;

/** Sign-in codes and reset links: an agent that reads them could be talked into using them. */
export const looksLikeSignInMail = (subject: string, body: string) =>
  SIGN_IN_MAIL.test(subject) || SIGN_IN_MAIL.test(body.slice(0, 2000));

export const WITHHELD = "[body withheld: this looks like a sign-in or security message]";

export const senderVerdictForAddress = (results: MailAuthResults, fromAddress: string | null) => {
  const from = fromAddress?.trim().toLowerCase();
  const domain = from !== undefined && isPlainAddress(from) ? (domainIn(from) ?? null) : null;
  return senderVerdict(results, domain);
};

type Verdict = {
  readonly method: string;
  readonly result: string;
  readonly props: Map<string, string>;
};

// Comments and quoted values carry sender-controlled text (a bounce address), so they never split.
const segments = (header: string) => {
  const out: Array<string> = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (char === "\\" && (quoted || depth > 0)) {
      if (quoted) current += char + (header[i + 1] ?? "");
      i++;
    } else if (quoted) {
      current += char;
      if (char === '"') quoted = false;
    } else if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if (depth > 0) continue;
    else if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === ";") {
      out.push(current);
      current = "";
    } else current += char;
  }
  return [...out, current];
};

const PROPERTY = /^\s*([a-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s"]+)/;

const GMAIL = /^\s*mx\.google\.com\s*;/i;
const METHOD_RESULT = /^\s*([a-z0-9_-]+)(?:\/\d+)?\s*=\s*([a-z0-9_-]+)/;

// Keep sender-controlled comments and quoted properties out of the method results.
const parseVerdicts = (header: string) =>
  segments(header).flatMap((segment): Array<Verdict> => {
    const head = METHOD_RESULT.exec(segment);
    if (head === null) return [];
    const props = new Map<string, string>();
    let rest = segment.slice(head[0].length);
    for (let found = PROPERTY.exec(rest); found !== null; found = PROPERTY.exec(rest)) {
      const value = found[2]!;
      props.set(
        found[1]!,
        value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value,
      );
      rest = rest.slice(found[0].length);
    }
    return [{ method: head[1]!, result: head[2]!, props }];
  });

const receiverVerdicts = (auth: MailAuthResults) => {
  if ("receiver" in auth) {
    if (auth.results.length !== 1) return { vouches: false, verdicts: [] };
    const header = auth.results[0]!.toLowerCase();
    const verdicts = parseVerdicts(header);
    // Microsoft stamps inbound mail. A second result makes the receiver's stamp ambiguous.
    const vouches =
      auth.isDraft !== true &&
      METHOD_RESULT.test(header) &&
      verdicts.some(({ method }) => method === "compauth");
    return { vouches, verdicts };
  }
  // Gmail puts its own named header above any results carried with the message.
  const header = (auth[0] ?? "").toLowerCase();
  const receiver = GMAIL.exec(header);
  const verdicts = parseVerdicts(receiver === null ? header : header.slice(receiver[0].length));
  return { vouches: receiver !== null, verdicts };
};

const domainIn = (value: string | undefined) =>
  value?.slice(value.lastIndexOf("@") + 1).replace(/\.$/, "");
const aligned = (domain: string | undefined, from: string) =>
  domain !== undefined &&
  domain !== "" &&
  (domain === from || from.endsWith(`.${domain}`) || domain.endsWith(`.${from}`));

const dmarcPass = (verdicts: ReadonlyArray<Verdict>, domain: string) =>
  verdicts.some(
    ({ method, result, props }) =>
      method === "dmarc" && result === "pass" && domainIn(props.get("header.from")) === domain,
  );

const dmarcFailed = (verdicts: ReadonlyArray<Verdict>) =>
  verdicts.some(({ method, result }) => method === "dmarc" && result === "fail");

/** The receiving server's DMARC pass for exactly this From domain. */
export const dmarcPassedFor = (results: MailAuthResults, domain: string) => {
  const { vouches, verdicts } = receiverVerdicts(results);
  return vouches && !dmarcFailed(verdicts) && dmarcPass(verdicts, domain);
};

const verdictOf = (verdicts: ReadonlyArray<Verdict>, fromDomain: string | null) => {
  const passes = (method: string, domain: (props: Map<string, string>) => string | undefined) =>
    fromDomain !== null &&
    verdicts.some(
      (one) =>
        one.method === method && one.result === "pass" && aligned(domain(one.props), fromDomain),
    );
  if (dmarcFailed(verdicts)) return "failed" as const;
  if (fromDomain !== null && dmarcPass(verdicts, fromDomain)) return "passed" as const;
  if (
    verdicts.some(
      ({ method, result }) =>
        (method === "dkim" || method === "spf") && (result === "fail" || result === "softfail"),
    )
  )
    return "failed" as const;
  if (
    passes("dkim", (props) => domainIn(props.get("header.d") ?? props.get("header.i"))) &&
    passes("spf", (props) => domainIn(props.get("smtp.mailfrom")))
  )
    return "passed" as const;
  return "not checked" as const;
};

/**
 * DMARC passed for the From domain (ASCII, lower case), or for Gmail only, aligned DKIM and SPF
 * both passed.
 */
export const senderVerdict = (results: MailAuthResults, fromDomain: string | null) => {
  const microsoft = "receiver" in results;
  if (microsoft && results.results.length > 1) {
    return results.results.some(
      (header) => verdictOf(parseVerdicts(header.toLowerCase()), fromDomain) === "failed",
    )
      ? ("failed" as const)
      : ("not checked" as const);
  }
  const { vouches, verdicts } = receiverVerdicts(results);
  const verdict = verdictOf(verdicts, fromDomain);
  if (verdict !== "passed") return verdict;
  return vouches && (!microsoft || (fromDomain !== null && dmarcPass(verdicts, fromDomain)))
    ? ("passed" as const)
    : ("not checked" as const);
};

type Part = {
  readonly mimeType?: unknown;
  readonly filename?: unknown;
  readonly partId?: unknown;
  readonly body?: {
    readonly data?: unknown;
    readonly size?: unknown;
    readonly attachmentId?: unknown;
  };
  readonly parts?: unknown;
};

const fromBase64Url = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const walk = (part: unknown, out: Array<Part>, depth = 0) => {
  if (depth > 12 || typeof part !== "object" || part === null) return;
  out.push(part as Part);
  const parts = (part as Part).parts;
  if (Array.isArray(parts)) for (const child of parts) walk(child, out, depth + 1);
};

// Gmail gives an attachment a new attachmentId on every read of its message; its partId stays.
const attachmentIdOf = (part: Part) =>
  typeof part.partId === "string" &&
  ((typeof part.body?.attachmentId === "string" && part.body.attachmentId !== "") ||
    typeof part.body?.data === "string")
    ? `part:${part.partId}`
    : undefined;
const isAttachment = (part: Part) => typeof part.filename === "string" && part.filename !== "";
const fileOf = (part: Part) => {
  const attachmentId = attachmentIdOf(part);
  return {
    name: String(part.filename),
    type: typeof part.mimeType === "string" ? part.mimeType : "unknown",
    bytes: typeof part.body?.size === "number" ? part.body.size : null,
    ...(attachmentId === undefined ? {} : { attachmentId }),
  };
};
export const attachmentPart = (payload: unknown, id: string) => {
  const parts: Array<Part> = [];
  walk(payload, parts);
  const part = parts.find((item) => isAttachment(item) && attachmentIdOf(item) === id);
  return part === undefined
    ? undefined
    : {
        ...fileOf(part),
        data: typeof part.body?.data === "string" ? part.body.data : undefined,
        /** This read's own download id, good for this payload only. */
        fetchId: typeof part.body?.attachmentId === "string" ? part.body.attachmentId : undefined,
      };
};

/** A message payload's text, and the attachments it names (never fetched). */
export const messageBody = (payload: unknown) => {
  const parts: Array<Part> = [];
  walk(payload, parts);
  const data = (part: Part) =>
    typeof part.body?.data === "string" ? fromBase64Url(part.body.data) : undefined;
  const plain = parts.find((part) => part.mimeType === "text/plain" && !isAttachment(part));
  const html = parts.find((part) => part.mimeType === "text/html" && !isAttachment(part));
  const plainText = plain === undefined ? undefined : data(plain);
  const htmlText = html === undefined ? undefined : data(html);
  const text =
    plainText !== undefined && plainText.trim() !== ""
      ? tidy(plainText)
      : htmlText !== undefined
        ? htmlToText(htmlText)
        : "";
  const attachments = parts.filter(isAttachment).map(fileOf);
  return { text, attachments };
};
