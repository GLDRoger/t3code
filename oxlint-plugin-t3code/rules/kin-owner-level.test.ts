import { assert } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const state = createOxlintRuleHarness("t3code/kin-owner-level", { filename: "fixture.ts" });

// RequestAction before the co-owner fix: a co-owner's answer in her own chat counted as a member's (G01).
state.invalid(
  "catches the owner-by-id check that left co-owners out",
  'const level = role === "owner" && author.personId !== agent.ownerPersonId ? "member" : role;',
  (output) => assert.include(output, "mayActAsOwner"),
);
state.invalid(
  "catches a comparison with the org owner",
  "if (caller.personId === identity.owner.personId) return;",
);
state.invalid("catches the bare owner id", "const named = personId === ownerPersonId;");
state.valid(
  "allows comparing two owner ids, a consistency check between rows",
  "const same = lead.ownerPersonId === owner.personId;",
);
state.valid("allows a presence check", "const known = ownerPersonId !== undefined;");
state.valid("allows the record holder's id", "const mine = row.ownerId === personId;");
