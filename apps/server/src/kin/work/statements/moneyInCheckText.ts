import type { KinMoneyInCheckCard } from "@t3tools/contracts";
import { shortDay } from "./bankKnown.ts";

type Card = KinMoneyInCheckCard;
type Line = Card["lines"][number];
type Group = Line["group"];
const MATCHES =
  "Matches are the same currency and cash amount to the minor unit, with tax a client withheld left out, on the same account where the bank names one, tied in Kin or no more than 3 days apart. This check records nothing.";

export const groups = ["matched", "bankOnly", "kinOnly", "notSeenYet", "differs"] as const;
export const groupHeads = (n: Card["counts"]) => ({
  matched: `${n.matched} ${n.matched === 1 ? "matches" : "match"}`,
  bankOnly: `${n.bankOnly} ${n.bankOnly === 1 ? "is" : "are"} at the bank and not in Kin`,
  kinOnly: `${n.kinOnly} ${n.kinOnly === 1 ? "is" : "are"} in Kin and not at the bank`,
  notSeenYet: `${n.notSeenYet} ${n.notSeenYet === 1 ? "is" : "are"} in Kin and not seen at the bank yet`,
  differs: `${n.differs} ${n.differs === 1 ? "differs" : "differ"}`,
});
export const cardText = (card: Omit<Card, "text">) => {
  const heads = groupHeads(card.counts);
  const matchedPayments = card.counts.matched - card.explained;
  heads.matched = `${matchedPayments} ${matchedPayments === 1 ? "matches" : "match"}: each is a payment in Kin and a credit at the bank`;
  const lines = Map.groupBy(card.lines, (line) => line.group);
  return [
    card.changes,
    card.title,
    ...groups.flatMap((group) => [
      `${heads[group]}.`,
      ...(lines.get(group) ?? []).map((line) => line.text),
      ...(group !== "matched" || card.explained === 0
        ? []
        : [
            `${card.explained} more credit${card.explained === 1 ? " was" : "s were"} explained by a person as transfer, interest, refund or other money.`,
          ]),
    ]),
    ...(card.covered.length === 0 ? [] : ["What this checked", ...card.covered]),
    MATCHES,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
};

export const changesSince = (prior: Card, next: Card) => {
  const keys = (line: Line) => [line.id, ...line.payments.map((p) => `payment:${p.id}`)];
  const before = new Map(
    prior.lines.flatMap((line) => keys(line).map((key) => [key, line] as const)),
  );
  const after = next.lines;
  const afterKeys = new Map(after.flatMap((line) => keys(line).map((key) => [key, line] as const)));
  const added = (group: Group) =>
    after.filter(
      (line) => line.group === group && keys(line).every((key) => before.get(key)?.group !== group),
    ).length;
  const fixed = prior.lines.filter(
    (line) =>
      line.group !== "matched" &&
      line.group !== "notSeenYet" &&
      keys(line).some((key) => afterKeys.get(key)?.group === "matched"),
  ).length;
  const matches = added("matched");
  const bank = added("bankOnly");
  const differences = added("differs") + added("kinOnly");
  const changes = [
    matches > 0 ? `${matches} new match${matches === 1 ? "" : "es"}` : "",
    fixed > 0 ? `${fixed} fixed` : "",
    bank > 0 ? `${bank} new at the bank and not in Kin` : "",
    differences > 0 ? `${differences} new difference${differences === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const day = shortDay(prior.checkedOn);
  return changes.length === 0
    ? `Nothing changed since the check on ${day}.`
    : `Since the check on ${day}: ${changes.join(", ")}.`;
};
