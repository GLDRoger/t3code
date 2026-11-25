import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

const TYPE_WORDS: Partial<Record<SchemaAST.AST["_tag"], string>> = {
  String: "text",
  Number: "a number",
  Boolean: "true or false",
  Arrays: "a list",
  Objects: "an object",
};

/** One argument's failure as a sentence an agent can act on; undefined keeps the default text. */
export const plainParameterIssue = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
): string | undefined => {
  const at = path.map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`));
  const where = at.join("").replace(/^\./, "");
  if (issue._tag === "Pointer") return plainParameterIssue(issue.issue, [...path, ...issue.path]);
  if (issue._tag === "Encoding") return plainParameterIssue(issue.issue, path);
  if (issue._tag === "Composite") {
    const each = issue.issues.map((one) => plainParameterIssue(one, path));
    return each.every((one) => one !== undefined) ? each.join(" ") : undefined;
  }
  if (where === "") return undefined;
  if (issue._tag === "MissingKey") return `${where} is missing.`;
  if (issue._tag === "AnyOf" && issue.ast.types.every(SchemaAST.isLiteral))
    return `${where} must be one of ${issue.ast.types.map((type) => String(type.literal)).join(", ")}.`;
  if (issue._tag === "InvalidType" && TYPE_WORDS[issue.ast._tag] !== undefined)
    return `${where} must be ${TYPE_WORDS[issue.ast._tag]}.`;
  const bound = issue._tag === "Filter" ? issue.filter.annotations?.arbitraryConstraint : undefined;
  const actual = issue._tag === "Filter" ? issue.input : undefined;
  if (!(typeof actual === "string" || Array.isArray(actual)) || !Predicate.isObject(bound))
    return undefined;
  const size = `${actual.length} ${typeof actual === "string" ? "characters" : "items"}`;
  if (typeof bound.maxLength === "number" && actual.length > bound.maxLength)
    return `${where} is ${size}; at most ${bound.maxLength}.`;
  if (typeof bound.minLength === "number" && actual.length < bound.minLength)
    return `${where} is ${size}; at least ${bound.minLength}.`;
  return undefined;
};

/** Fails with the plain sentence where there is one; otherwise the decode after it fails as before. */
export const plainly = <S extends Schema.Top>(codec: S) =>
  SchemaGetter.checkEffect<Record<string, unknown>, S["DecodingServices"]>((input, options) =>
    Schema.decodeEffect(codec)(input, { ...options, reportInput: true }).pipe(
      Effect.as(undefined),
      Effect.catch((error) => {
        const message = plainParameterIssue(error.issue);
        return Effect.succeed(
          message === undefined ? undefined : new SchemaIssue.InvalidValue({ message }),
        );
      }),
    ),
  );
