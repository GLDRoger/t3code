import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { weeklyFigures } from "./weekly.ts";
import {
  coOwnerChat,
  measureLayer,
  memberChat,
  mondayMorning,
  orgId,
  ownerChat,
  seedCompany,
  seedMeasuredWeek,
} from "./weekMeasure.testkit.ts";

it.effect("shows the measure to owners and co-owners only, and only for a nonempty week", () =>
  Effect.gen(function* () {
    yield* seedCompany;
    const figures = (chatId: typeof ownerChat) =>
      weeklyFigures({ orgId, chatId, now: mondayMorning });
    assert.notInclude(yield* figures(ownerChat), "How Kin did:");
    yield* seedMeasuredWeek;
    const expected = [
      "How Kin did:",
      "- Unasked: 5 turns with a message, 4 with something ready to act on.",
      "- Of those: 1 acted on as shown, 1 changed first, 1 dismissed, 1 unanswered.",
      "- Asked: 1 turn, 1 followed by a same-day message after a card was dismissed or changed.",
      "- Things Kin said it would do: 3 came due, 1 on time, 1 late, 1 missed.",
    ].join("\n");
    assert.include(yield* figures(ownerChat), expected);
    assert.include(yield* figures(coOwnerChat), expected);
    assert.notInclude(yield* figures(memberChat), "How Kin did:");
  }).pipe(Effect.provide(measureLayer)),
);
