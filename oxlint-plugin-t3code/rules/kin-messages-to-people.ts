import { defineRule, type ESTree } from "@oxlint/plugins";

const GATE = /\bKinLevelGate\b|\blevelGate\b|\bgate\b|\bagentServices\b/;
const FLOOR = /\bfloor\b|\bKinFloor\b/i;
const FLOOR_GRANTS = new Set(["authorize", "admitNotice", "admitToPerson"]);
const MESSAGE =
  "A relay, nudge or notice to a person posts with `KinLevelGate.postTo`, which `KinFloor.admitToPerson` admits. `post` and the floor's grants are the turn's own reply (reply/KinReplyBridge.ts) and refuse messages to people.";

const propertyName = (node: ESTree.Node) =>
  node.type === "Identifier"
    ? node.name
    : node.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Kin messages to people go through KinLevelGate.postTo, never the floor's reply path.",
    },
    schema: [],
  },
  create(context) {
    const text = (node: ESTree.Node) => context.sourceCode.getText(node);
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || node.init == null) return;
        if (!GATE.test(text(node.init))) return;
        for (const property of node.id.properties)
          if (property.type === "Property" && propertyName(property.key) === "post")
            context.report({ node: property, message: MESSAGE });
      },
      MemberExpression(node) {
        if (node.computed) return;
        const name = propertyName(node.property);
        if (name === "post" && GATE.test(text(node.object)))
          context.report({ node, message: MESSAGE });
        if (name !== undefined && FLOOR_GRANTS.has(name) && FLOOR.test(text(node.object)))
          context.report({ node, message: MESSAGE });
      },
    };
  },
});
