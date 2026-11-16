import { defineRule, type ESTree } from "@oxlint/plugins";

const unwrap = (node: ESTree.Node): ESTree.Node =>
  node.type === "TSNonNullExpression" || node.type === "ChainExpression"
    ? unwrap(node.expression)
    : node;

const propertyName = (node: ESTree.MemberExpression) =>
  node.property.type === "Identifier" && !node.computed ? node.property.name : undefined;

/** `owner.personId`, `identity.owner.personId`, `x.ownerPersonId`, or a bare `ownerPersonId`. */
const isOwnerId = (raw: ESTree.Node): boolean => {
  const node = unwrap(raw);
  if (node.type === "Identifier") return node.name === "ownerPersonId";
  if (node.type !== "MemberExpression") return false;
  const name = propertyName(node);
  if (name === "ownerPersonId") return true;
  if (name !== "personId") return false;
  const object = unwrap(node.object);
  return (
    (object.type === "Identifier" && object.name === "owner") ||
    (object.type === "MemberExpression" && propertyName(object) === "owner")
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Kin decides owner authority with KinAccess, which includes co-owners, never by comparing with the owner's id.",
    },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        const left = isOwnerId(node.left);
        const right = isOwnerId(node.right);
        // Two owner ids compared is a consistency check between rows, not a decision about a person.
        if (left === right) return;
        const other = unwrap(left ? node.right : node.left);
        if (
          (other.type === "Literal" && other.value === null) ||
          (other.type === "Identifier" && other.name === "undefined")
        )
          return;
        context.report({
          node,
          message:
            "Comparing a person with the owner's id leaves co-owners out. For authority use `mayActAsOwner` from people/KinAccess.ts; where only the owner himself is meant (his private chats, statement notices, managing co-owners) use `isOwnerHimself`, and `ownsAgent` for an agent's own owner.",
        });
      },
    };
  },
});
