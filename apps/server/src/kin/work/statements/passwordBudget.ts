// @effect-diagnostics nodeBuiltinImport:off -- a file's tries are keyed by a hash of its bytes.
import { formatKinWhen, KIN_TEXT_LOCALE } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerZone } from "../recordRows.ts";

/**
 * Wrong passwords a statement file takes, from its card and from the chat each, before Kin stops
 * trying them for a while. Counted per statement and per file in its chat, so sending the same
 * file again or reading it again starts nothing over; a try is taken before the file is opened,
 * so tries at once can't all get through. The right password clears them.
 */

/** Wrong passwords one way in takes before it waits. */
const TRIES = 5;
/** How long an emptied budget waits before it takes passwords again. */
const COOL_OFF_MS = 15 * 60_000;

export type PasswordWay = "card" | "chat";
const fileOf = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
const keysFor = (
  way: PasswordWay,
  input: { readonly statementId: string; readonly chatId: string; readonly bytes: Uint8Array },
) => [`${way}:st:${input.statementId}`, `${way}:file:${fileOf(input.bytes)}:${input.chatId}`];

class Spent extends Schema.TaggedError<Spent>()("Spent", { refillAt: Schema.Number }) {}

/**
 * Takes one try from every budget the file's password counts against, all or none. Returns when
 * the next is taken once they ran out, or undefined when this one may be tried.
 */
export const takeTry = Effect.fn("KinStatements.takePasswordTry")(function* (
  orgId: KinOrgId,
  way: PasswordWay,
  input: { readonly statementId: string; readonly chatId: string; readonly bytes: Uint8Array },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const keys = keysFor(way, input);
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        for (const key of keys) {
          yield* sql`INSERT OR IGNORE INTO kin_statement_password_budget
              (org_id, budget_key, remaining, refill_at)
            VALUES (${orgId}, ${key}, ${TRIES}, NULL)`;
          const [taken] = yield* sql<{ remaining: number }>`UPDATE kin_statement_password_budget
            SET remaining = (CASE WHEN remaining > 0 THEN remaining ELSE ${TRIES} END) - 1,
              refill_at = CASE WHEN (CASE WHEN remaining > 0 THEN remaining ELSE ${TRIES} END) = 1
                THEN ${now + COOL_OFF_MS} ELSE NULL END
            WHERE org_id = ${orgId} AND budget_key = ${key}
              AND (remaining > 0 OR (refill_at IS NOT NULL AND refill_at <= ${now}))
            RETURNING remaining`;
          if (taken === undefined) {
            const [spent] = yield* sql<{ refillAt: number | null }>`SELECT refill_at AS "refillAt"
              FROM kin_statement_password_budget WHERE org_id = ${orgId} AND budget_key = ${key}`;
            return yield* new Spent({ refillAt: spent?.refillAt ?? now + COOL_OFF_MS });
          }
        }
      }),
    )
    .pipe(
      Effect.as(undefined),
      Effect.catchTags({ Spent: (spent) => Effect.succeed(spent.refillAt) }),
    );
});

/** The right password opened the file: its tries start over, on the card and in the chat. */
export const clearTries = Effect.fn("KinStatements.clearPasswordTries")(function* (
  orgId: KinOrgId,
  input: { readonly statementId: string; readonly chatId: string; readonly bytes: Uint8Array },
) {
  const sql = yield* SqlClient.SqlClient;
  const keys = [...keysFor("card", input), ...keysFor("chat", input)];
  yield* sql`DELETE FROM kin_statement_password_budget
    WHERE org_id = ${orgId} AND budget_key IN ${sql.in(keys)}`;
});

/** When a way in that ran out of tries takes passwords again; undefined while it takes them. */
export const spentUntil = Effect.fn("KinStatements.passwordSpentUntil")(function* (
  orgId: KinOrgId,
  way: PasswordWay,
  input: { readonly statementId: string; readonly chatId: string; readonly bytes: Uint8Array },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ refillAt: number | null }>`SELECT MAX(refill_at) AS "refillAt"
    FROM kin_statement_password_budget
    WHERE org_id = ${orgId} AND budget_key IN ${sql.in(keysFor(way, input))} AND remaining = 0
      AND refill_at > ${now}`;
  return row?.refillAt ?? undefined;
});

/** "Kin takes another password for this file after 14:35." in the owner's time. */
export const waitLine = Effect.fn("KinStatements.passwordWaitLine")(function* (
  orgId: KinOrgId,
  refillAt: number,
) {
  const zone = yield* ownerZone(orgId);
  const at = formatKinWhen(refillAt, "time", { zone, locale: KIN_TEXT_LOCALE });
  return `Too many wrong passwords for this file. Kin takes another after ${at}; the right one clears them.`;
});
