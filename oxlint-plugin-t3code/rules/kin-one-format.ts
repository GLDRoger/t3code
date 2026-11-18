import { defineRule, type ESTree } from "@oxlint/plugins";

const DISPLAY_KEYS = new Set([
  "hour",
  "minute",
  "weekday",
  "month",
  "day",
  "year",
  "dateStyle",
  "timeStyle",
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

const MONEY =
  "Write and read money through `formatKinMoney` and `parseKinMoney` (contracts kinCurrency.ts), which know each currency's decimals and symbol.";
const HOME =
  "A company's currency is its profile's `homeCurrency`; a missing one is `KIN_DEFAULT_HOME_CURRENCY` (contracts kinCurrency.ts).";
const WHEN =
  "Write a day or a time through `formatKinWhen` or `kinWhenFormat` (contracts kinWhen.ts), with the reader's zone and, on the server, the company's `textLocale` (work/companyProfile.ts).";
const LOCALE =
  "A locale comes from one place: the company's `textLocale` (work/companyProfile.ts) on the server, the device's on a client. A country's locale is a row of its region (work/region.ts).";
const HOST =
  "Ask `kinIsLocalOnlyHost` (contracts kinPeople.ts) whether a host is reachable only from this machine.";

const keys = (node: ESTree.Node | undefined) =>
  node?.type === "ObjectExpression"
    ? node.properties.flatMap((property) =>
        property.type === "Property" && property.key.type === "Identifier"
          ? [property.key.name]
          : [],
      )
    : [];
const valueOf = (node: ESTree.Node | undefined, key: string) =>
  node?.type === "ObjectExpression"
    ? node.properties.find(
        (property): property is ESTree.ObjectProperty =>
          property.type === "Property" &&
          property.key.type === "Identifier" &&
          property.key.name === key,
      )?.value
    : undefined;
const isString = (node: ESTree.Node | undefined, value?: string) =>
  node?.type === "Literal" &&
  typeof node.value === "string" &&
  (value === undefined || node.value === value);
/** Date options that put a day or a time on screen; a zone-name or offset lookup is not one. */
const showsWhen = (options: ESTree.Node | undefined) => {
  const named = keys(options);
  return !named.includes("timeZoneName") && named.some((key) => DISPLAY_KEYS.has(key));
};
const isMoneyOptions = (options: ESTree.Node | undefined) =>
  isString(valueOf(options, "style") as ESTree.Node | undefined, "currency");
const intlNamed = (callee: ESTree.Node, name: string) =>
  callee.type === "MemberExpression" &&
  callee.object.type === "Identifier" &&
  callee.object.name === "Intl" &&
  callee.property.type === "Identifier" &&
  callee.property.name === name;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Kin writes money, days and times and judges local hosts from one source each, never a copy at the call site.",
    },
    schema: [],
  },
  create(context) {
    const report = (node: ESTree.Node, message: string) => context.report({ node, message });
    return {
      Literal(node) {
        if (node.value === "INR") report(node, HOME);
      },
      NewExpression(node) {
        const options = node.arguments[1] as ESTree.Node | undefined;
        if (intlNamed(node.callee, "NumberFormat") && isMoneyOptions(options)) report(node, MONEY);
        if (intlNamed(node.callee, "DateTimeFormat") && showsWhen(options)) report(node, WHEN);
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
        const property = node.callee.property;
        if (property.type !== "Identifier") return;
        const options = node.arguments[1] as ESTree.Node | undefined;
        if (property.name === "toLocaleDateString" || property.name === "toLocaleTimeString")
          return report(node, WHEN);
        if (property.name === "toLocaleString") {
          if (isMoneyOptions(options)) return report(node, MONEY);
          if (showsWhen(options)) return report(node, WHEN);
        }
        if (property.name === "startsWith" && isString(node.arguments[0], "127."))
          report(node, HOST);
      },
      Property(node) {
        if (
          node.key.type === "Identifier" &&
          node.key.name === "locale" &&
          isString(node.value as ESTree.Node)
        )
          report(node, LOCALE);
      },
      BinaryExpression(node) {
        if (node.operator !== "===" && node.operator !== "!==") return;
        const literal = [node.left, node.right].find(
          (side) => side.type === "Literal" && typeof side.value === "string",
        );
        if (literal?.type === "Literal" && LOCAL_HOSTS.has(String(literal.value)))
          report(node, HOST);
      },
    };
  },
});
