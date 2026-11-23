import {
  KinAttachment,
  KinChatError,
  type KinOrgId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { FieldValue } from "./lists.ts";
import { parseAmount } from "./money.ts";
import { describe, isFieldNumber, type ListDef } from "./registers.ts";

/**
 * A lead's words for a defined list's fields, as the values the list stores: a choice by its
 * name, a person as an id, a client by key or name, an amount in minor units, and files by the
 * names this turn's own messages carry. Types are checked again where the entry is written.
 */

export const FieldInputs = Schema.Record(
  Schema.String.check(Schema.isMaxLength(40)),
  Schema.NullOr(
    Schema.Union([
      Schema.String.check(Schema.isMaxLength(500)),
      Schema.Finite,
      Schema.Boolean,
      Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(10)),
    ]),
  ),
).annotate({
  description:
    'The list\'s own fields by key, as list_define named them: text, a choice, a day (2026-11-20), "you"/"me" (whoever asked)/"owner"/an agentId, a client or project, an amount (4,200.50 or 12k), a number, true or false for yes or no, or file names from this turn\'s messages. null clears one.',
});
export type FieldInputs = typeof FieldInputs.Type;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const YES_NO = new Map([
  ["yes", true],
  ["true", true],
  ["no", false],
  ["false", false],
]);
const decodeAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(KinAttachment)),
);

/** The files on the messages this turn answers, by name: the only files a lead may keep. */
export const turnFiles = Effect.fn("KinWorkTools.turnFiles")(function* (turn: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ json: string | null }>`SELECT m.attachments_json AS json
    FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'chat.message' AND m.status <> 'deleted'
    ORDER BY m.seq`;
  return rows.flatMap((row) =>
    Option.getOrElse(decodeAttachments(row.json ?? "[]"), () => []).map((file) => ({
      id: file.id,
      name: file.name,
    })),
  );
});

export const typedFields = Effect.fn("KinWorkTools.typedFields")(function* (
  def: ListDef,
  input: FieldInputs,
  resolve: {
    readonly who: (
      text: string,
    ) => Effect.Effect<KinWorkPrincipal, KinChatError | SqlError, SqlClient.SqlClient>;
    readonly ref: (
      text: string,
      list: "clients" | "projects",
    ) => Effect.Effect<string, KinChatError | SqlError, SqlClient.SqlClient>;
    readonly files: () => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string }>,
      KinChatError | SqlError,
      SqlClient.SqlClient
    >;
  },
) {
  const out: Record<string, FieldValue | null> = {};
  for (const [key, raw] of Object.entries(input)) {
    const spec = def.fields.find((one) => one.key === key);
    if (spec === undefined || raw === null) {
      // Unknown keys are refused, with the list's fields, where the entry is written.
      out[key] = raw === null ? null : Array.isArray(raw) ? [...raw] : String(raw);
      continue;
    }
    const text = Array.isArray(raw) ? raw.join(", ") : String(raw).trim();
    const wrong = invalid(`${spec.label} takes ${describe(spec)}.`);
    switch (spec.type) {
      case "text":
      case "date":
        out[key] = text;
        break;
      case "choice": {
        const choice = (spec.choices ?? []).find((one) => one.toLowerCase() === text.toLowerCase());
        if (choice === undefined) return yield* wrong;
        out[key] = choice;
        break;
      }
      case "person": {
        const who = yield* resolve.who(text);
        out[key] = who._tag === "agent" ? `agent:${who.agentId}` : `person:${who.personId}`;
        break;
      }
      case "link":
        if (spec.link === "list") return yield* wrong;
        out[key] = yield* resolve.ref(text, spec.link ?? "clients");
        break;
      case "money": {
        const parsed = parseAmount(text, def.currency);
        if ("error" in parsed) return yield* parsed.error;
        out[key] = parsed.money;
        break;
      }
      case "number": {
        const number = typeof raw === "number" ? String(raw) : text.replace(/[\s,]/g, "");
        if (!isFieldNumber(number)) return yield* wrong;
        out[key] = String(Number(number));
        break;
      }
      case "yesno": {
        const answer = typeof raw === "boolean" ? raw : YES_NO.get(text.toLowerCase());
        if (answer === undefined) return yield* wrong;
        out[key] = answer ? "yes" : "no";
        break;
      }
      case "file": {
        const names = Array.isArray(raw) ? raw : [text];
        const files = yield* resolve.files();
        const ids = [];
        for (const name of names) {
          const file = files.find((one) => one.name.toLowerCase() === name.trim().toLowerCase());
          if (file === undefined)
            return yield* invalid(
              files.length === 0
                ? "This turn's messages carry no files to keep."
                : `No file ${name.slice(0, 80)} on this turn's messages; they carry ${files.map((one) => one.name).join(", ")}.`,
            );
          ids.push(file.id);
        }
        out[key] = [...new Set(ids)];
        break;
      }
      default:
        return yield* wrong;
    }
  }
  return out;
});
