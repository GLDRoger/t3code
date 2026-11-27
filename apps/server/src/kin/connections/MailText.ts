/**
 * Mail as text an agent can read: the plain part when there is one, else the HTML with hidden
 * text dropped, and bodies of sign-in and security mail withheld. All of it stays outside text.
 */

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

/** Whether the receiving server checked the sender, from `Authentication-Results`. */
export const senderCheck = (results: ReadonlyArray<string>) => {
  const all = results.join(";").toLowerCase();
  const verdict = (name: string) => new RegExp(`\\b${name}=(\\w+)`).exec(all)?.[1];
  const dmarc = verdict("dmarc");
  if (dmarc === "pass") return "passed";
  if (dmarc === "fail") return "failed";
  if (verdict("dkim") === "pass" && verdict("spf") === "pass") return "passed";
  return "not checked";
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

/**
 * The receiving server's verdicts: only the topmost `Authentication-Results`, the one it added,
 * since a sender can write its own lower down. Read as RFC 8601 results, never as loose text.
 */
const receiverVerdicts = (results: ReadonlyArray<string>) =>
  segments((results[0] ?? "").toLowerCase()).flatMap((segment): Array<Verdict> => {
    const head = /^\s*([a-z0-9_-]+)(?:\/\d+)?\s*=\s*([a-z0-9_-]+)/.exec(segment);
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

const domainIn = (value: string | undefined) =>
  value?.slice(value.lastIndexOf("@") + 1).replace(/\.$/, "");
const aligned = (domain: string | undefined, from: string) =>
  domain !== undefined &&
  domain !== "" &&
  (domain === from || from.endsWith(`.${domain}`) || domain.endsWith(`.${from}`));

/** The receiving server's DMARC pass for exactly this From domain. */
export const dmarcPassedFor = (results: ReadonlyArray<string>, domain: string) =>
  receiverVerdicts(results).some(
    ({ method, result, props }) =>
      method === "dmarc" && result === "pass" && domainIn(props.get("header.from")) === domain,
  );

/**
 * Whether the receiving server vouched for a From domain (ASCII, lower case): DMARC passed for it,
 * or DKIM and SPF both passed for it or a domain it shares an owner with.
 */
export const senderVerdict = (results: ReadonlyArray<string>, fromDomain: string | null) => {
  const verdicts = receiverVerdicts(results);
  const passes = (method: string, domain: (props: Map<string, string>) => string | undefined) =>
    fromDomain !== null &&
    verdicts.some(
      (one) =>
        one.method === method && one.result === "pass" && aligned(domain(one.props), fromDomain),
    );
  if (fromDomain !== null && dmarcPassedFor(results, fromDomain)) return "passed" as const;
  if (verdicts.some(({ method, result }) => method === "dmarc" && result === "fail"))
    return "failed" as const;
  if (
    passes("dkim", (props) => domainIn(props.get("header.d") ?? props.get("header.i"))) &&
    passes("spf", (props) => domainIn(props.get("smtp.mailfrom")))
  )
    return "passed" as const;
  return verdicts.some(
    ({ method, result }) =>
      (method === "dkim" || method === "spf") && (result === "fail" || result === "softfail"),
  )
    ? ("failed" as const)
    : ("not checked" as const);
};

type Part = {
  readonly mimeType?: unknown;
  readonly filename?: unknown;
  readonly body?: { readonly data?: unknown; readonly size?: unknown };
  readonly parts?: unknown;
};

const fromBase64Url = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const walk = (part: unknown, out: Array<Part>, depth = 0) => {
  if (depth > 12 || typeof part !== "object" || part === null) return;
  out.push(part as Part);
  const parts = (part as Part).parts;
  if (Array.isArray(parts)) for (const child of parts) walk(child, out, depth + 1);
};

/** A message payload's text, and the attachments it names (never fetched). */
export const messageBody = (payload: unknown) => {
  const parts: Array<Part> = [];
  walk(payload, parts);
  const data = (part: Part) =>
    typeof part.body?.data === "string" ? fromBase64Url(part.body.data) : undefined;
  const isAttachment = (part: Part) => typeof part.filename === "string" && part.filename !== "";
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
  const attachments = parts.filter(isAttachment).map((part) => ({
    name: String(part.filename),
    type: typeof part.mimeType === "string" ? part.mimeType : "unknown",
    bytes: typeof part.body?.size === "number" ? part.body.size : null,
  }));
  return { text, attachments };
};
