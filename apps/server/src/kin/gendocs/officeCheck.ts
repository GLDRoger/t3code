import { SaxesParser, type SaxesTagNS } from "saxes";

import { openZip, refuse, Refusal, ZIP_CAPS, type ZipCaps } from "../files/zipParts.ts";
import { withArticle } from "../article.ts";
import { svgProblem } from "./svgCheck.ts";

// Whether an XLSX, DOCX or PPTX is only a document: its ZIP read under Kin's caps, each XML part
// inflated a chunk at a time into an event parser. Macros, embedded objects, ActiveX, templates, data
// connections, fields and formulas that fetch or run, and outside links but web or email
// hyperlinks are refused. Hyperlinks stay: they open only when the reader clicks one.

export type OfficeKind = "xlsx" | "docx" | "pptx";

/** An SVG image inside is checked as one text, so it stays small. */
const SVG_BYTES = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;
/** One tag with its attributes, one formula or one field instruction: no real document's is near. */
const HELD_CHARS = 1024 * 1024;
/** One run of text, CDATA or comment the parser holds before it hands it on. */
const NODE_CHARS = 16 * 1024 * 1024;

const MAIN: Record<OfficeKind, { readonly part: string; readonly type: string }> = {
  xlsx: {
    part: "xl/workbook.xml",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  },
  docx: {
    part: "word/document.xml",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  pptx: {
    part: "ppt/presentation.xml",
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  },
};

const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XMLNS = "http://www.w3.org/2000/xmlns/";

type Handlers = {
  readonly open: (tag: SaxesTagNS) => void;
  readonly text?: (text: string) => void;
  readonly close?: (tag: SaxesTagNS) => void;
};

/** Reads a part into a parser's handlers; the first refusal stops it there. */
type Source = (handlers: Handlers) => Promise<void>;

/**
 * Parses one part namespace-aware, as its text arrives; a handler's refusal stops it there. What
 * the parser holds between two of its events stays under a cap: a tag under `HELD_CHARS`, any
 * other node under `NODE_CHARS`, so a part's size never becomes one string's.
 */
const parser = (part: string, handlers: Handlers) => {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const broken = () => refuse(`has ${part}, which isn't well-formed XML`);
  let held = 0;
  let inTag = false;
  const handed = () => {
    held = 0;
  };
  parser.on("doctype", broken);
  parser.on("error", broken);
  parser.on("opentagstart", () => {
    handed();
    inTag = true;
  });
  parser.on("opentag", (tag) => {
    handed();
    inTag = false;
    handlers.open(tag);
  });
  const { text, close } = handlers;
  parser.on("text", (value) => {
    handed();
    text?.(value);
  });
  parser.on("cdata", (value) => {
    handed();
    text?.(value);
  });
  parser.on("closetag", (tag) => {
    handed();
    close?.(tag);
  });
  for (const event of ["comment", "processinginstruction", "xmldecl"] as const)
    parser.on(event, handed);
  const guarded = (step: () => void) => {
    try {
      step();
    } catch (error) {
      if (error instanceof Refusal) throw error;
      broken();
    }
  };
  return {
    write: (value: string) => {
      for (let at = 0; at < value.length; at += CHUNK) {
        const piece = value.slice(at, at + CHUNK);
        guarded(() => parser.write(piece));
        held += piece.length;
        if (held > (inTag ? HELD_CHARS : NODE_CHARS))
          refuse(`has a single value larger than any real document holds (in ${part})`);
      }
    },
    close: () => guarded(() => parser.close()),
  };
};

/** An attribute with no prefix: the only one Office reads in package parts. */
const plain = (tag: SaxesTagNS, name: string) => tag.attributes[name]?.value;

const BODY_ATTRIBUTES = new Set(["instr", "fldCharType", "action", "macro", "href", "src"]);

/** The attributes the body check reads, by local name in any namespace, so none shadows another. */
const bodyAttributes = (tag: SaxesTagNS, part: string) => {
  const values = new Map<string, string>();
  for (const { uri, local, value } of Object.values(tag.attributes)) {
    if (uri === XMLNS || !BODY_ATTRIBUTES.has(local)) continue;
    if (values.has(local)) refuse(`has two ${local} attributes on one element (in ${part})`);
    values.set(local, value);
  }
  return values;
};

/** Each part's content type, from `[Content_Types].xml`. */
const contentTypes = async (read: Source, part: string) => {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  await read({
    open: (tag) => {
      if (tag.uri !== CONTENT_TYPES)
        refuse(`has <${tag.name}>, which Kin doesn't read there (in ${part})`);
      const type = plain(tag, "ContentType") ?? "";
      if (ACTIVE_TYPE.test(type)) refuse(`declares ${type}, which runs, embeds or fetches content`);
      const [map, key] =
        tag.local === "Default"
          ? [defaults, (plain(tag, "Extension") ?? "").toLowerCase()]
          : tag.local === "Override"
            ? [overrides, (plain(tag, "PartName") ?? "").toLowerCase()]
            : [undefined, ""];
      if (map === undefined) return;
      if (map.has(key)) refuse(`gives ${key} two content types`);
      map.set(key, type);
    },
  });
  return (name: string) =>
    overrides.get(`/${name}`.toLowerCase()) ??
    defaults.get(name.split("/").at(-1)!.split(".").at(-1)!.toLowerCase());
};

// Content that runs, that Office loads as another document, or that fetches data.
const ACTIVE_TYPE =
  /macroEnabled|vbaProject|vbaData|activeX|oleObject|\.template\.|\.addin\.|\.package\b|sheet\.binary|x-msdownload|ms-office\.legacy|ms-excel\.intl|macrosheet|externalLink|\.connections\+|queryTable/i;
const ACTIVE_PART =
  /(?:^|\/)(?:vbaProject[^/]*\.bin|vbaData\.xml|activeX\/|embeddings\/|oleObject|macrosheets\/|externalLinks\/|connections\.xml|queryTables\/)/i;
const ACTIVE_RELATIONSHIP =
  /\/(?:attachedTemplate|oleObject|package|control|activeXControlBinary|vbaProject|wordVbaData|aFChunk|subDocument|externalLink|externalLinkPath|frame|oleObjectBinary|externalData|connections|queryTable|xlMacrosheet|xlIntlMacrosheet)$/i;
const HYPERLINK = /\/hyperlink$/i;
const WEB_OR_MAIL = /^(?:https?:\/\/|mailto:)[^\s\\]+$/i;
// A place in this workbook, such as #'Sheet 2'!A1: Excel opens nothing outside it.
const IN_WORKBOOK = /^#[^\\/:]+$/;

/** Why a hyperlink's target isn't a plain web or email address, or `undefined` when it is. */
const linkProblem = (target: string): string | undefined => {
  if (!WEB_OR_MAIL.test(target)) return "a hyperlink that isn't a web or email address";
  if (!/^https?:/i.test(target)) return undefined;
  try {
    const url = new URL(target);
    return url.username === "" && url.password === ""
      ? undefined
      : "a web link that carries a user name or password";
  } catch {
    return "a hyperlink that isn't a web or email address";
  }
};

const relationshipsProblem = (read: Source, part: string) =>
  read({
    open: (tag) => {
      if (tag.uri !== RELATIONSHIPS)
        refuse(`has <${tag.name}>, which Kin doesn't read there (in ${part})`);
      if (tag.local !== "Relationship") return;
      const type = plain(tag, "Type") ?? "";
      const kindName = type.split("/").at(-1) ?? type;
      if (ACTIVE_RELATIONSHIP.test(type)) refuse(`has ${withArticle(kindName)} relationship`);
      const mode = (plain(tag, "TargetMode") ?? "Internal").trim().toLowerCase();
      const target = (plain(tag, "Target") ?? "").trim();
      if (mode === "internal") {
        if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(target))
          refuse(
            `has ${withArticle(kindName)} relationship inside the file that points outside it`,
          );
        return;
      }
      if (mode !== "external") refuse(`has ${withArticle(kindName)} relationship Kin can't read`);
      if (!HYPERLINK.test(type)) refuse(`links ${withArticle(kindName)} from outside the file`);
      const problem = linkProblem(target);
      if (problem !== undefined) refuse(`has ${problem}`);
    },
  });

type FieldToken = {
  readonly text: string;
  readonly switch: boolean;
  /** Quoted with `\"` or `\\` escapes inside, which Word reads but a target never needs. */
  readonly escaped: boolean;
};
/**
 * A field instruction as Word splits it: quoted text, switches and bare words. `undefined` when
 * Kin can't split it with certainty, such as a quote left open or two tokens run together.
 */
const fieldTokens = (instruction: string): ReadonlyArray<FieldToken> | undefined => {
  const tokens: Array<FieldToken> = [];
  let at = 0;
  while (at < instruction.length) {
    if (/\s/.test(instruction[at]!)) {
      at += 1;
      continue;
    }
    if (instruction[at] === '"') {
      let text = "";
      let escaped = false;
      at += 1;
      for (;;) {
        const char = instruction[at];
        if (char === undefined) return undefined;
        if (char === '"') break;
        if (char === "\\" && (instruction[at + 1] === '"' || instruction[at + 1] === "\\")) {
          escaped = true;
          at += 1;
        }
        text += instruction[at];
        at += 1;
      }
      tokens.push({ text, switch: false, escaped });
      at += 1;
    } else {
      const word = /^[^\s"]+/.exec(instruction.slice(at))![0];
      const isSwitch = word.startsWith("\\");
      if (isSwitch ? !/^\\[A-Za-z*@#!]$/.test(word) : word.includes("\\")) return undefined;
      tokens.push({ text: word, switch: isSwitch, escaped: false });
      at += word.length;
    }
    if (at < instruction.length && !/\s/.test(instruction[at]!)) return undefined;
  }
  return tokens;
};
// HYPERLINK's switches: these take the next token, the others none.
const LINK_ARGUMENT_SWITCHES = new Set(["\\l", "\\o", "\\t", "\\*"]);
const LINK_FLAG_SWITCHES = new Set(["\\m", "\\n"]);

/**
 * Why a HYPERLINK field's address isn't one the link rule keeps, or `undefined` when it is, when it
 * is a link to a bookmark here only, or when the field is another field.
 */
const hyperlinkProblem = (instruction: string, nested: boolean): string | undefined => {
  if (!/^\s*"?HYPERLINK\b/i.test(instruction)) return undefined;
  const unreadable = "a hyperlink field whose address Kin can't read";
  if (nested) return "a hyperlink field whose address another field writes";
  const tokens = fieldTokens(instruction);
  if (tokens === undefined || tokens[0]?.text.toUpperCase() !== "HYPERLINK") return unreadable;
  let target: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const name = token.text.toLowerCase();
    if (token.switch && LINK_ARGUMENT_SWITCHES.has(name)) {
      index += 1;
      if (tokens[index] === undefined || tokens[index]!.switch) return unreadable;
    } else if (token.switch && !LINK_FLAG_SWITCHES.has(name)) return unreadable;
    else if (!token.switch) {
      if (target !== undefined || token.escaped) return unreadable;
      target = token.text.trim();
    }
  }
  if (target === undefined) return undefined;
  const problem = linkProblem(target);
  return problem === undefined ? undefined : `${problem} in a field`;
};

// Word fields that load another file or address, talk to another program, or run a command.
const FETCHING_FIELDS = new Set([
  "INCLUDEPICTURE",
  "INCLUDETEXT",
  "INCLUDE",
  "DDE",
  "DDEAUTO",
  "LINK",
  "IMPORT",
  "DATABASE",
  "MACROBUTTON",
]);
const fieldProblem = (instruction: string, anywhere = false, nested = false) => {
  if (!anywhere) {
    const link = hyperlinkProblem(instruction, nested);
    if (link !== undefined) return link;
  }
  const words = instruction
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  const name = (anywhere ? words : words.slice(0, 1)).find((word) => FETCHING_FIELDS.has(word));
  if (name === undefined) return undefined;
  return `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name} field, which fetches or runs content`;
};

const FORMULAS = new Set([
  "f",
  "formula",
  "formula1",
  "formula2",
  "definedName",
  "calculatedColumnFormula",
  "totalsRowFormula",
]);
const FETCHING_FUNCTIONS =
  /(?:^|[^A-Z0-9_.])(?:_XL[A-Z]+\.)*(WEBSERVICE|RTD|IMAGE|CALL|REGISTER\.ID|REGISTER|EXEC)\s*\(/;

/** Why an Excel formula could fetch or run something, or `undefined` when it only computes. */
const formulaProblem = (formula: string): string | undefined => {
  // Text and quoted sheet names first, so only the formula's own syntax is checked.
  const texts: Array<string> = [];
  const bare = formula
    .replace(/"((?:[^"]|"")*)"|'(?:[^']|'')*'/g, (_, text: string | undefined) =>
      text === undefined ? "''" : `"${texts.push(text.replaceAll('""', '"')) - 1}"`,
    )
    .toUpperCase();
  if (/["']/.test(bare.replace(/"\d+"|''/g, ""))) return "a formula Kin can't read";
  if (bare.includes("|")) return "a formula that talks to another program";
  if (bare.includes("_XLUDF.")) return "a formula that calls an add-in";
  const call = FETCHING_FUNCTIONS.exec(bare);
  if (call !== null) return `a formula that calls ${call[1]}, which fetches or runs content`;
  for (const match of bare.matchAll(/(?:^|[^A-Z0-9_.])(?:_XL[A-Z]+\.)*HYPERLINK\s*\(\s*/g)) {
    const target = /^"(\d+)"\s*[,)]/.exec(bare.slice(match.index + match[0].length));
    if (target === null) return "a HYPERLINK formula whose address Kin can't see";
    const address = texts[Number(target[1])]!.trim();
    const problem = IN_WORKBOOK.test(address) ? undefined : linkProblem(address);
    if (problem !== undefined) return `${problem} in a formula`;
  }
  return undefined;
};

/** Refuses fields, formulas, actions and links in one XML part that fetch or run something. */
const bodyProblem = async (kind: OfficeKind, read: Source, part: string) => {
  // Word splits a field's instruction over runs; nested fields sit inside it. Instruction text
  // outside a field's instruction is checked word by word.
  const fields: Array<{ text: string; checked: boolean; nested: boolean }> = [];
  let loose = "";
  let instruction = 0;
  let formula: string | undefined;
  const found = (problem: string | undefined) => {
    if (problem !== undefined) refuse(`has ${problem} (in ${part})`);
  };
  const check = (field: { text: string; checked: boolean; nested: boolean }) => {
    if (field.checked) return;
    field.checked = true;
    found(fieldProblem(field.text, false, field.nested));
  };
  const longer = (text: string, what: string) => {
    if (text.length > HELD_CHARS) found(`${what} larger than any real document's`);
    return text;
  };
  await read({
    open: (tag) => {
      const attributes = bodyAttributes(tag, part);
      switch (tag.local) {
        case "fldSimple":
          found(fieldProblem(attributes.get("instr") ?? ""));
          break;
        case "fldChar": {
          const type = attributes.get("fldCharType");
          const top = fields.at(-1);
          if (type === "begin") {
            if (top !== undefined && !top.checked && top.text.trim() === "")
              found("a field whose name another field writes");
            if (top !== undefined && !top.checked) top.nested = true;
            fields.push({ text: "", checked: false, nested: false });
          } else if (type === "separate" && top !== undefined) check(top);
          else if (type === "end" && top !== undefined) check(fields.pop()!);
          break;
        }
        case "instrText":
        case "delInstrText":
          instruction += 1;
          break;
        case "hlinkClick":
        case "hlinkMouseOver":
        case "hlinkHover":
          if (/^\s*ppaction:\/\/(?:program|macro|ole)/i.test(attributes.get("action") ?? ""))
            found("an action that runs a program or macro");
          break;
        case "entryMacro":
        case "exitMacro":
          found("a form field that runs a macro");
          break;
        case "mailMerge":
          found("a mail merge, which loads data from outside the file");
          break;
      }
      if ((attributes.get("macro") ?? "").trim() !== "") found("a shape that runs a macro");
      for (const local of ["href", "src"]) {
        const link = (attributes.get(local) ?? "").trim();
        if (link !== "" && !link.startsWith("#")) found("a link to something outside the file");
      }
      if (kind === "xlsx" && FORMULAS.has(tag.local)) formula = "";
    },
    text: (text) => {
      if (instruction > 0) {
        const top = fields.at(-1);
        if (top === undefined || top.checked) loose = longer(loose + text, "field instructions");
        else top.text = longer(top.text + text, "a field instruction");
      }
      if (formula !== undefined) formula = longer(formula + text, "a formula");
    },
    close: (tag) => {
      if (tag.local === "instrText" || tag.local === "delInstrText") instruction -= 1;
      if (formula !== undefined && FORMULAS.has(tag.local)) {
        const text = formula;
        formula = undefined;
        found(formulaProblem(text));
      }
    },
  });
  for (const field of fields) check(field);
  found(fieldProblem(loose, true));
};

const XML_TYPE = /[/+]xml$/i;
const SVG_TYPE = /^image\/svg\+xml$/i;

/** Why these bytes aren't a plain `kind` document, as a phrase completing "it …", or `undefined`. */
export const officeProblem = async (
  kind: OfficeKind,
  input: Uint8Array,
  caps: ZipCaps = ZIP_CAPS,
): Promise<string | undefined> => {
  try {
    const zip = openZip(input, caps);
    const entries = zip.parts;
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const main = MAIN[kind];
    if (!byName.has(main.part)) return refuse(`has no ${main.part}`);
    const active = entries.find((entry) => ACTIVE_PART.test(entry.name));
    if (active !== undefined)
      return refuse(`carries ${active.name}, which runs, embeds or fetches content`);
    const types = byName.get("[Content_Types].xml");
    if (types === undefined) return refuse("has no [Content_Types].xml");
    const source =
      (entry: (typeof entries)[number]): Source =>
      async (handlers) => {
        const xml = parser(entry.name, handlers);
        await zip.stream(entry, xml.write);
        xml.close();
      };
    const typeOf = await contentTypes(source(types), types.name);
    if (typeOf(main.part) !== main.type)
      return refuse(`has ${main.part}, which isn't a plain ${kind.toUpperCase()}'s main part`);
    const rest = entries.filter((entry) => entry !== types && !entry.name.endsWith("/"));
    for (const entry of rest)
      if (entry.name.toLowerCase().endsWith(".rels"))
        await relationshipsProblem(source(entry), entry.name);
    for (const entry of rest) {
      if (entry.name.toLowerCase().endsWith(".rels")) continue;
      const type = typeOf(entry.name) ?? "";
      if (SVG_TYPE.test(type) || entry.name.toLowerCase().endsWith(".svg")) {
        if (entry.size > SVG_BYTES)
          refuse(`has ${entry.name}, which is too large for Kin to check`);
        const chunks: Array<string> = [];
        await zip.stream(entry, (text) => chunks.push(text));
        const problem = svgProblem(chunks.join(""));
        if (problem !== undefined) refuse(`has ${entry.name}, an SVG with ${problem}`);
      } else if (XML_TYPE.test(type) || entry.name.toLowerCase().endsWith(".xml"))
        await bodyProblem(kind, source(entry), entry.name);
    }
    return undefined;
  } catch (error) {
    if (error instanceof Refusal) return error.reason;
    return "has a ZIP Kin couldn't read";
  }
};
