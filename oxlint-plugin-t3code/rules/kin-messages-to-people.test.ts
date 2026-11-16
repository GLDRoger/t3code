import { assert } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const state = createOxlintRuleHarness("t3code/kin-messages-to-people", { filename: "fixture.ts" });

// pulse/mcp.ts's nudge before it moved to postTo: refused in every owner-chat turn (H03, J01).
state.invalid(
  "catches a nudge posted through the gate's reply post",
  `const { agent, post } = yield* agentServices;
   post(agent, { chatId, body: input.text, intent: "question", clientMessageId });`,
  (output) => assert.include(output, "KinLevelGate.postTo"),
);
state.invalid(
  "catches the gate's post called directly",
  "yield* (yield* KinLevelGate).post(agent, { chatId, body, intent: 'evidence', clientMessageId });",
);
state.invalid(
  "catches a floor grant taken outside the chat service",
  "yield* floor.authorize(identity, chat, 'answer', grant);",
);
state.valid(
  "allows the one way to message a person",
  `const { agent, postTo } = yield* agentServices;
   postTo(agent, personId, { chatId, body, intent: "question", clientMessageId });`,
);
state.valid("allows other posts", "yield* cards.post(chatId, card);");
