/**
 * Whether the mailbox's own receiving service vouched for a message's sender, for each vendor in
 * the one shape that vendor documents (`Google.ts`, `Microsoft.ts`). Nothing above the adapters
 * reads authentication headers: they hand over this verdict and the one From mailbox it is for.
 */

export type SenderVerdict = "passed" | "failed" | "not_checked";
export type SenderCheck = {
  readonly verdict: SenderVerdict;
  /** The From header's one mailbox, lowercased; null when it names several or doesn't parse. */
  readonly address: string | null;
};

const unfold = (value: string) => value.replace(/\r?\n[ \t]+/g, " ");

/** Comments (nested, with quoted pairs) become a space; quoted strings stay as they are. */
const uncommented = (value: string) => {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let at = 0; at < value.length; at++) {
    const char = value[at]!;
    if (char === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += value.slice(at, at + 2);
      at += 1;
      continue;
    }
    if (depth === 0 && char === '"') quoted = !quoted;
    if (!quoted && char === "(") {
      depth += 1;
      continue;
    }
    if (!quoted && depth > 0 && char === ")") {
      depth -= 1;
      if (depth === 0) out += " ";
      continue;
    }
    if (depth === 0) out += char;
  }
  return depth === 0 && !quoted ? out : undefined;
};

/** Splits on `separator` outside quoted strings. */
const splitOutsideQuotes = (value: string, separator: string) => {
  const parts: Array<string> = [];
  let current = "";
  let quoted = false;
  for (let at = 0; at < value.length; at++) {
    const char = value[at]!;
    if (char === "\\" && quoted) {
      current += value.slice(at, at + 2);
      at += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === separator) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
};

const unquote = (value: string) =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;

export type AuthResult = {
  readonly method: string;
  readonly result: string;
  /** `header.from`, `header.d`, `smtp.mailfrom` and the like, names and values lowercased. */
  readonly props: ReadonlyMap<string, string>;
};
export type AuthResults = {
  /** The first segment when it names the service that checked; null when it is a result itself. */
  readonly authservId: string | null;
  readonly results: ReadonlyArray<AuthResult>;
};

const resultOf = (segment: string): AuthResult | undefined => {
  const tokens = segment
    .replace(/\s*=\s*/g, "=")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  const head = /^([a-z0-9_-]+)(?:\/\d+)?=([a-z0-9_-]+)$/i.exec(tokens[0] ?? "");
  if (head === null) return undefined;
  const props = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const prop = /^([a-z0-9_-]+(?:\.[a-z0-9_-]+)?)=(.+)$/i.exec(token);
    if (prop === null) continue;
    const name = prop[1]!.toLowerCase();
    if (!props.has(name)) props.set(name, unquote(prop[2]!).toLowerCase());
  }
  return { method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), props };
};

/**
 * One `Authentication-Results` value as RFC 8601 writes it: folding undone, comments dropped, then
 * `authserv-id; method=result ptype.property=value; …`, matched token by token.
 */
const parseAuthResults = (value: string): AuthResults | undefined => {
  const plain = uncommented(unfold(value));
  if (plain === undefined) return undefined;
  const segments = splitOutsideQuotes(plain, ";").map((one) => one.trim());
  const first = segments[0] ?? "";
  const named = first !== "" && !first.includes("=");
  const results = (named ? segments.slice(1) : segments)
    .filter((one) => one !== "" && one.toLowerCase() !== "none")
    .map(resultOf);
  if (results.some((one) => one === undefined)) return undefined;
  return {
    authservId: named ? (first.split(/\s+/)[0] ?? "").toLowerCase() : null,
    results: results.filter((one): one is AuthResult => one !== undefined),
  };
};

const PLAIN = /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+\.[^\s<>@,;:"()[\]\\]+$/;

/**
 * The one mailbox a From header names (`Name <a@b.example>` or `a@b.example`), lowercased; undefined
 * for several, a group, or anything that doesn't parse.
 */
export const oneMailbox = (header: string | null) => {
  if (header === null) return undefined;
  const plain = uncommented(unfold(header));
  if (plain === undefined) return undefined;
  const outside = plain.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/[,;:]/.test(outside)) return undefined;
  const open = outside.indexOf("<");
  if (open === -1) {
    const bare = plain.trim();
    return PLAIN.test(bare) ? bare.toLowerCase() : undefined;
  }
  if (outside.indexOf("<", open + 1) !== -1) return undefined;
  const close = outside.indexOf(">");
  if (close < open || outside.indexOf(">", close + 1) !== -1) return undefined;
  if (outside.slice(close + 1).trim() !== "") return undefined;
  const inside = /<([^<>]*)>\s*$/.exec(plain)?.[1]?.trim() ?? "";
  return PLAIN.test(inside) ? inside.toLowerCase() : undefined;
};

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const identityDomain = (value: string | undefined) =>
  value === undefined ? undefined : value.slice(value.lastIndexOf("@") + 1);

/**
 * The verdict of the receiving service's own results for a From mailbox: DMARC pass for the From's
 * own domain; with no DMARC result, a DKIM pass signed by that domain or a parent of it. A DMARC
 * other than pass or fail (none, bestguesspass, an error) is no DMARC result.
 */
const verdictOf = (results: AuthResults, address: string): SenderVerdict => {
  const domain = domainOf(address);
  const dmarc = results.results.find((one) => one.method === "dmarc");
  if (dmarc?.result === "pass")
    return dmarc.props.get("header.from") === domain ? "passed" : "failed";
  if (dmarc?.result === "fail") return "failed";
  const signers = results.results
    .filter((one) => one.method === "dkim")
    .map((one) => ({
      result: one.result,
      // `header.i`'s domain is the signer's or a subdomain of it, so its alignment is at least as strict.
      signer: one.props.get("header.d") ?? identityDomain(one.props.get("header.i")),
    }))
    .filter(
      (one) =>
        one.signer !== undefined && (domain === one.signer || domain.endsWith(`.${one.signer}`)),
    );
  if (signers.some((one) => one.result === "pass")) return "passed";
  if (signers.some((one) => one.result === "fail")) return "failed";
  return "not_checked";
};

/**
 * The verdict from the topmost `Authentication-Results` (`values` topmost first), counted only when
 * `ours` says it is in the receiving service's own documented shape; else not checked.
 */
export const senderCheckOf = (
  values: ReadonlyArray<string>,
  fromHeaders: ReadonlyArray<string>,
  ours: (results: AuthResults) => boolean,
): SenderCheck => {
  const address = fromHeaders.length === 1 ? oneMailbox(fromHeaders[0]!) : undefined;
  if (address === undefined) return { verdict: "not_checked", address: null };
  const top = values[0] === undefined ? undefined : parseAuthResults(values[0]);
  if (top === undefined || !ours(top)) return { verdict: "not_checked", address };
  return { verdict: verdictOf(top, address), address };
};

// support.google.com/mail/answer/180707: Gmail's own result is the Authentication-Results it adds
// on receipt, `mx.google.com` its authserv-id; one under any other name is not Google's.
export const gmailOwn = (results: AuthResults) => results.authservId === "mx.google.com";
// learn.microsoft.com/defender-office-365/message-headers-eop-mdo: Exchange Online stamps its
// results with no authserv-id and its own `compauth`; any other shape is someone else's.
export const exchangeOwn = (results: AuthResults) =>
  results.authservId === null && results.results.some((one) => one.method === "compauth");
