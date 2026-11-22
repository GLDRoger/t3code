/**
 * Case patterns as RegExps. V8 applies inline modifier groups such as `(?i:…)` inconsistently across
 * Node versions, so they are rewritten away: a flag moves onto the RegExp when nothing outside its
 * groups depends on it, else an `i` group's letters become classes such as `[aA]`.
 */

const MODIFIER = /^\(\?([ims]*)(?:-([ims]*))?:/;
const CLASS_ESCAPE = /^\\[dDsSwWbB]$/;

/** The `i` flag's Canonicalize without `u`: chars match when these agree. */
const canonical = (char: string) => {
  const upper = char.toUpperCase();
  if (upper.length !== 1) return char;
  return char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? char : upper;
};
let folds: Map<string, ReadonlyArray<string>> | undefined;
/** Every char the `i` flag treats as `char`, `char` included. */
const variants = (char: string): ReadonlyArray<string> => {
  if (folds === undefined) {
    const groups = new Map<string, Array<string>>();
    for (let code = 0; code < 0x10000; code++) {
      const one = String.fromCharCode(code);
      const key = canonical(one);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [one]);
      else group.push(one);
    }
    folds = groups;
  }
  return folds.get(canonical(char)) ?? [char];
};
const classChar = (char: string) => (/[\\\]^-]/.test(char) ? `\\${char}` : char);

interface Scan {
  /** The pattern with every modifier group opened as `(?:`. */
  readonly parts: ReadonlyArray<{
    readonly text: string;
    readonly flags: string;
    readonly kind: Kind;
  }>;
  readonly removes: boolean;
}
type Kind = "letter" | "class" | "backref" | "anchor" | "dot" | "other";

/** Splits the pattern into atoms, each with the flags its enclosing modifier groups give it. */
const scan = (pattern: string): Scan => {
  const parts: Array<{ text: string; flags: string; kind: Kind }> = [];
  const stack: Array<string> = [];
  let removes = false;
  let flags = "";
  const push = (text: string, kind: Kind) => parts.push({ text, flags, kind });
  for (let i = 0; i < pattern.length;) {
    const rest = pattern.slice(i);
    const modifier = MODIFIER.exec(rest);
    if (modifier !== null && (modifier[1] !== "" || modifier[2] !== undefined)) {
      const [, add = "", remove = ""] = modifier;
      if (remove !== "") removes = true;
      stack.push(flags);
      flags = [...new Set([...flags, ...add])].filter((flag) => !remove.includes(flag)).join("");
      parts.push({ text: "(?:", flags, kind: "other" });
      i += modifier[0].length;
      continue;
    }
    const char = pattern[i]!;
    if (char === "(") {
      stack.push(flags);
      const opener = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(rest)?.[0] ?? "(";
      push(opener, "other");
      i += opener.length;
    } else if (char === ")") {
      push(")", "other");
      flags = stack.pop() ?? "";
      i += 1;
    } else if (char === "[") {
      let end = i + 1;
      if (pattern[end] === "^") end++;
      while (end < pattern.length && pattern[end] !== "]") end += pattern[end] === "\\" ? 2 : 1;
      push(pattern.slice(i, end + 1), "class");
      i = end + 1;
    } else if (char === "\\") {
      const escape =
        /^\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|c[A-Za-z]|k<[^>]*>|[1-9]\d*|[\s\S])/.exec(rest)![0];
      const kind: Kind = /^\\(?:k<|[1-9])/.test(escape)
        ? "backref"
        : /^\\(?:x|u)/.test(escape) ||
            (escape.length === 2 && /[A-Za-z]/.test(escape[1]!) === false)
          ? "letter"
          : "other";
      push(escape, kind);
      i += escape.length;
    } else if (char === "{") {
      const quantifier = /^\{\d+(?:,\d*)?\}/.exec(rest)?.[0] ?? "{";
      push(quantifier, "other");
      i += quantifier.length;
    } else {
      push(char, char === "^" || char === "$" ? "anchor" : char === "." ? "dot" : "letter");
      i += 1;
    }
  }
  return { parts, removes };
};

/** The char an escape or literal stands for, when it is one char. */
const literal = (text: string) => {
  if (!text.startsWith("\\")) return text;
  if (/^\\[xu]/.test(text)) return String.fromCharCode(Number.parseInt(text.slice(2), 16));
  return text.slice(1);
};
const foldable = (text: string) => variants(literal(text)).length > 1;

/**
 * An `i` class without the flag: each char and range gains the chars `i` matches with it. `closed`
 * when it already has them all, so the flag changes nothing. Class escapes are closed already.
 */
const foldClass = (text: string) => {
  const negated = text.startsWith("[^");
  const body = text.slice(negated ? 2 : 1, -1);
  const items = [
    ...body.matchAll(/\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|c[A-Za-z]|[\s\S])|[\s\S]/g),
  ].map((match) => match[0]);
  const members = new Set<string>();
  for (let at = 0; at < items.length; at++) {
    const item = items[at]!;
    if (CLASS_ESCAPE.test(item)) continue;
    const next = items[at + 2];
    if (items[at + 1] === "-" && next !== undefined && !CLASS_ESCAPE.test(next)) {
      const to = literal(next).charCodeAt(0);
      for (let code = literal(item).charCodeAt(0); code <= to; code++)
        members.add(String.fromCharCode(code));
      at += 2;
      continue;
    }
    members.add(literal(item));
  }
  const extra = new Set([...members].flatMap(variants).filter((one) => !members.has(one)));
  return {
    closed: extra.size === 0,
    text: `[${negated ? "^" : ""}${body}${[...extra].map(classChar).join("")}]`,
  };
};

/** The RegExp a case pattern means, with the same meaning on every call in every process. */
export const casePattern = (pattern: string): RegExp => {
  if (!/\(\?(?:[ims]+(?:-[ims]*)?|-[ims]+):/.test(pattern)) return new RegExp(pattern);
  const { parts, removes } = scan(pattern);
  if (removes) throw new Error(`Unsupported modifier group (a flag turned off): ${pattern}`);
  // A flag can move onto the RegExp when no atom outside its groups behaves differently with it.
  const outside = (flag: string) => parts.filter((part) => !part.flags.includes(flag));
  const sensitive: Record<string, (part: Scan["parts"][number]) => boolean> = {
    i: (part) =>
      part.kind === "backref" ||
      (part.kind === "letter" && foldable(part.text)) ||
      (part.kind === "class" && !foldClass(part.text).closed),
    m: (part) => part.kind === "anchor",
    s: (part) => part.kind === "dot",
  };
  const used = [...new Set(parts.flatMap((part) => [...part.flags]))];
  const hoisted = used.filter((flag) => !outside(flag).some(sensitive[flag]!));
  const unhoisted = used.filter((flag) => !hoisted.includes(flag));
  if (unhoisted.some((flag) => flag !== "i"))
    throw new Error(
      `Unsupported modifier group (${unhoisted.join("")} cannot be hoisted): ${pattern}`,
    );
  const source = parts
    .map(({ text, flags, kind }) => {
      if (unhoisted.length === 0 || !flags.includes("i")) return text;
      if (kind === "backref")
        throw new Error(`Unsupported backreference inside an (?i:) group: ${pattern}`);
      if (kind === "class") return foldClass(text).text;
      if (kind === "letter" && foldable(text))
        return `[${variants(literal(text)).map(classChar).join("")}]`;
      return text;
    })
    .join("");
  return new RegExp(source, hoisted.join(""));
};
