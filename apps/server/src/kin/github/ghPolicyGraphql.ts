/**
 * The GraphQL reader in a Kin agent's gh policy (`ghPolicy.ts`), as plain JavaScript: enough of the
 * spec to see every operation in a document and each mutation's root fields and arguments, with
 * each string's place so a body can be signed where it stands. Anything else it can't read throws.
 */
export const GRAPHQL_READER = String.raw`
// GraphQL, as the spec reads it: enough to see every operation and each mutation's arguments.
const lex = (source) => {
  const tokens = [];
  let i = 0;
  const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  while (i < source.length) {
    const c = source[i];
    if (c === "﻿" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    if (source.startsWith("...", i)) {
      tokens.push({ type: "p", value: "...", start: i, end: i + 3 });
      i += 3;
      continue;
    }
    if ("!$&():=@[]{}|".includes(c)) {
      tokens.push({ type: "p", value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i, i + 256));
    if (name) {
      tokens.push({ type: "n", value: name[0], start: i, end: i + name[0].length });
      i += name[0].length;
      continue;
    }
    const number = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i, i + 64));
    if (number && number[0] !== "" && number[0] !== "-") {
      tokens.push({ type: "num", value: number[0], start: i, end: i + number[0].length });
      i += number[0].length;
      continue;
    }
    if (source.startsWith('"""', i)) {
      let j = i + 3;
      let raw = "";
      for (;;) {
        if (j >= source.length) throw new Error("block string");
        if (source.startsWith('\\"""', j)) {
          raw += '"""';
          j += 4;
          continue;
        }
        if (source.startsWith('"""', j)) break;
        raw += source[j++];
      }
      tokens.push({ type: "s", value: blockValue(raw), start: i, end: j + 3 });
      i = j + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        const d = source[j];
        if (d === undefined || d === "\n" || d === "\r") throw new Error("string");
        if (d === '"') break;
        if (d !== "\\") {
          value += d;
          j++;
          continue;
        }
        const e = source[j + 1];
        if (Object.hasOwn(ESCAPES, e)) {
          value += ESCAPES[e];
          j += 2;
        } else if (e === "u" && source[j + 2] === "{") {
          const close = source.indexOf("}", j + 3);
          const point = parseInt(source.slice(j + 3, close), 16);
          if (close < 0 || !Number.isInteger(point)) throw new Error("escape");
          value += String.fromCodePoint(point);
          j = close + 1;
        } else if (e === "u" && /^[0-9A-Fa-f]{4}$/.test(source.slice(j + 2, j + 6))) {
          value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
          j += 6;
        } else throw new Error("escape");
      }
      tokens.push({ type: "s", value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    throw new Error("character " + c);
  }
  return tokens;
};
const blockValue = (raw) => {
  const lines = raw.split(/\r\n|\n|\r/);
  let common = null;
  for (const line of lines.slice(1)) {
    const indent = line.length - line.replace(/^[ \t]+/, "").length;
    if (indent < line.length && (common === null || indent < common)) common = indent;
  }
  if (common) for (let k = 1; k < lines.length; k++) lines[k] = lines[k].slice(common);
  while (lines.length > 0 && /^[ \t]*$/.test(lines[0])) lines.shift();
  while (lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
};
const parseGraphql = (source) => {
  const tokens = lex(source);
  let k = 0;
  const isP = (token, value) => token !== undefined && token.type === "p" && token.value === value;
  const next = () => {
    const token = tokens[k++];
    if (token === undefined) throw new Error("end");
    return token;
  };
  const expect = (value) => {
    const token = next();
    if (token.value !== value || token.type === "s" || token.type === "num") throw new Error("expected " + value);
  };
  const nameToken = () => {
    const token = next();
    if (token.type !== "n") throw new Error("name");
    return token;
  };
  const value = () => {
    const token = next();
    if (isP(token, "$")) return { kind: "var", name: nameToken().value };
    if (token.type === "s") return { kind: "str", value: token.value, token };
    if (token.type === "num") return { kind: "num" };
    if (token.type === "n")
      return token.value === "true" || token.value === "false"
        ? { kind: "bool" }
        : token.value === "null"
          ? { kind: "null" }
          : { kind: "enum", value: token.value };
    if (isP(token, "[")) {
      const items = [];
      while (!isP(tokens[k], "]")) items.push(value());
      next();
      return { kind: "list", items };
    }
    if (isP(token, "{")) {
      const fields = [];
      while (!isP(tokens[k], "}")) {
        const name = nameToken().value;
        expect(":");
        fields.push([name, value()]);
      }
      next();
      return { kind: "obj", fields };
    }
    throw new Error("value");
  };
  const args = () => {
    const out = [];
    if (!isP(tokens[k], "(")) return out;
    next();
    while (!isP(tokens[k], ")")) {
      const name = nameToken().value;
      expect(":");
      out.push([name, value()]);
    }
    next();
    return out;
  };
  const directives = () => {
    while (isP(tokens[k], "@")) {
      next();
      nameToken();
      args();
    }
  };
  const type = () => {
    const token = next();
    if (isP(token, "[")) {
      type();
      expect("]");
    } else if (token.type !== "n") throw new Error("type");
    if (isP(tokens[k], "!")) next();
  };
  const skipSet = () => {
    expect("{");
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (isP(token, "{")) depth++;
      else if (isP(token, "}")) depth--;
    }
  };
  const rootFields = () => {
    expect("{");
    const fields = [];
    while (!isP(tokens[k], "}")) {
      const token = next();
      if (isP(token, "...")) throw new Error("a fragment at a mutation's root");
      if (token.type !== "n") throw new Error("field");
      let name = token.value;
      if (isP(tokens[k], ":")) {
        next();
        name = nameToken().value;
      }
      const fieldArgs = args();
      directives();
      if (isP(tokens[k], "{")) skipSet();
      fields.push({ name, args: fieldArgs });
    }
    next();
    return fields;
  };
  const operations = [];
  while (k < tokens.length) {
    const token = tokens[k];
    if (isP(token, "{")) {
      skipSet();
      operations.push({ type: "query" });
      continue;
    }
    if (token.type === "n" && ["query", "mutation", "subscription"].includes(token.value)) {
      next();
      if (tokens[k] !== undefined && tokens[k].type === "n") next();
      let defaults = false;
      if (isP(tokens[k], "(")) {
        next();
        while (!isP(tokens[k], ")")) {
          expect("$");
          nameToken();
          expect(":");
          type();
          if (isP(tokens[k], "=")) {
            next();
            value();
            defaults = true;
          }
          directives();
        }
        next();
      }
      directives();
      if (token.value === "mutation") operations.push({ type: "mutation", fields: rootFields(), defaults });
      else {
        skipSet();
        operations.push({ type: token.value });
      }
      continue;
    }
    if (token.type === "n" && token.value === "fragment") {
      next();
      nameToken();
      expect("on");
      nameToken();
      directives();
      skipSet();
      continue;
    }
    throw new Error("definition");
  }
  return operations;
};
`;
