import { defineRule, type ESTree } from "@oxlint/plugins";

// "Check your connection", "check the connection", "Try again" and "try again in a moment".
const WORDS = /\bcheck (?:your|the) connection\b|\btry again\b/i;

const MESSAGE =
  "Kin screens say what failed through `kinFailure` in client-runtime's kin/kinAnswers.ts: a refusal is said plainly, something gone is the empty or handled state, and only a request that got no answer asks to check the connection or offers Try again. Use `kinFailure(cause, what)` and its `retry`, or `KIN_RETRY` / `KIN_CHECK_CONNECTION` where the failure is known to be the connection.";

// Comments are not copy, so only string, template and JSX text nodes are checked.
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep Kin's connection and retry words in the one mapping from a host's answer to text.",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string | null | undefined) => {
      if (text !== null && text !== undefined && WORDS.test(text))
        context.report({ node, message: MESSAGE });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
});
