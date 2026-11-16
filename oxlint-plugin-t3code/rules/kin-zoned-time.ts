import { defineRule, type ESTree } from "@oxlint/plugins";

const DATE_ONLY_FORMATS = new Set(["toLocaleDateString", "toLocaleTimeString"]);
const DATE_KEYS = new Set([
  "hour",
  "minute",
  "weekday",
  "month",
  "day",
  "year",
  "dateStyle",
  "timeStyle",
]);
const DATE_LIKE = /[Dd]ate|[Tt]ime|[Ww]hen|[Dd]ay|[a-z]At$/;
const LOCAL_GETTERS = new Set([
  "getHours",
  "getMinutes",
  "getDate",
  "getDay",
  "getMonth",
  "getFullYear",
  "getTimezoneOffset",
  "setHours",
  "setDate",
]);

const keys = (node: ESTree.Node | undefined) =>
  node?.type === "ObjectExpression"
    ? node.properties.flatMap((property) =>
        property.type === "Property" && property.key.type === "Identifier"
          ? [property.key.name]
          : [],
      )
    : [];
/** An options object naming `timeZone`, or options built elsewhere, which may carry one. */
const hasTimeZone = (node: ESTree.Node | undefined): boolean =>
  node !== undefined &&
  (node.type !== "ObjectExpression" ||
    node.properties.some((property) => property.type === "SpreadElement") ||
    keys(node).includes("timeZone"));
const OWNER_ZONE =
  "Read the owner's zone with `ownerZone` (work/recordRows.ts), which falls back to the host's, never UTC.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Kin renders times in a person's zone through its formatter, never the zone the process runs in.",
    },
    schema: [],
  },
  create(context) {
    const report = (node: ESTree.Node) =>
      context.report({
        node,
        message:
          "This formats in the zone the server runs in, which is no person's. Pass the person's zone as `timeZone`: the owner's from `ownerZone` (work/recordRows.ts), a person's from his profile.",
      });
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
        const property = node.callee.property;
        if (property.type !== "Identifier") return;
        if (LOCAL_GETTERS.has(property.name)) return report(node);
        const options = node.arguments[1] as ESTree.Node | undefined;
        if (hasTimeZone(options)) return;
        if (DATE_ONLY_FORMATS.has(property.name)) return report(node);
        // Numbers have a toLocaleString too; only a date-shaped receiver or date options count.
        if (
          property.name === "toLocaleString" &&
          (DATE_LIKE.test(context.sourceCode.getText(node.callee.object)) ||
            keys(options).some((key) => DATE_KEYS.has(key)))
        )
          report(node);
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return;
        const text = node.quasi.quasis.map((part) => part.value.raw).join(" ");
        if (
          /\bSELECT\b/i.test(text) &&
          /\btime_zone\b/.test(text) &&
          /\bkin_trigger_settings\b/.test(text)
        )
          context.report({ node, message: OWNER_ZONE });
      },
      NewExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Intl" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "DateTimeFormat" &&
          !hasTimeZone(node.arguments[1] as ESTree.Node)
        )
          report(node);
      },
    };
  },
});
