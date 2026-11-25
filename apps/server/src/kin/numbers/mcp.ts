import {
  KinChatError,
  KinDay,
  KinNumbersListResult,
  KinNumbersRecordResult,
  KinNumbersValuesResult,
  KinNumberSource,
  KinNumberValueInput,
  KinRecordKey,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Tool } from "effect/ai";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { encoded } from "../lead/quote.ts";
import { KinToolText } from "../work/leadSchemas.ts";
import { leadTool } from "../work/leadWork.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as Numbers from "./KinNumbers.ts";

const shared = {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, KinIdentity, SqlClient.SqlClient, ThreadManagementService],
};

const NumberRecordInput = Schema.Struct({
  values: Schema.Array(
    Schema.Struct({
      ...KinNumberValueInput.fields,
      number: KinToolText(80, "Its key (G-1) or name."),
      source: KinNumberSource,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
const isKey = Schema.is(KinRecordKey);

const NumbersReadInput = Schema.Struct({
  numbers: Schema.optional(Schema.Array(KinRecordKey).check(Schema.isMaxLength(50))),
  from: Schema.optional(KinDay),
  to: Schema.optional(KinDay),
});
const sensitive = Schema.Literal(true);
const NumbersReadResult = Schema.Union([
  Schema.Struct({ ...KinNumbersListResult.fields, sensitive }),
  Schema.Struct({ history: Schema.Array(KinNumbersValuesResult), sensitive }),
]);

export const numberRecordTool = Tool.make("number_record", {
  ...shared,
  description:
    "Record values of this company's watched numbers. Each value names its number, the value, the day it is as of, and where it came from. A newer value for the same day is the one shown; both are kept. Works only where just the owner or a co-owner reads.",
  parameters: NumberRecordInput,
  success: KinNumbersRecordResult,
});

export const numbersReadTool = Tool.make("numbers_read", {
  ...shared,
  description:
    "Read this company's watched numbers: each one's latest value, unit, bound and the day it is as of; or, with from and to, the recorded values of the numbers named between those days. Read-only.",
  parameters: NumbersReadInput,
  success: NumbersReadResult,
});

export const recordWatched = leadTool(
  "KinNumbers.mcp.record",
  Effect.fnUntraced(function* (lead, { values }: typeof NumberRecordInput.Type) {
    // A number named rather than keyed is found among the watched ones; else it isn't one yet.
    const named = values.some(({ number }) => !isKey(number))
      ? (yield* Numbers.list(lead)).numbers
      : [];
    const keyed = [];
    for (const value of values) {
      const wanted = value.number.trim().toLowerCase();
      const key = isKey(value.number)
        ? value.number
        : named.find((number) => number.name.trim().toLowerCase() === wanted)?.key;
      if (key === undefined)
        return yield* new KinChatError({
          reason: "not_found",
          message: `${encoded(value.number)} isn't a watched number yet: propose it with numbers_watch.`,
        });
      keyed.push({ ...value, number: key });
    }
    return yield* Numbers.record(lead, keyed);
  }),
);

export const readWatched = leadTool(
  "KinNumbers.mcp.read",
  Effect.fnUntraced(function* (lead, { numbers: keys, from, to }: typeof NumbersReadInput.Type) {
    if (from === undefined && to === undefined)
      return { ...(yield* Numbers.list(lead, keys)), sensitive: true as const };
    if (from === undefined || to === undefined || keys === undefined || keys.length === 0)
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "For recorded values, give the number keys and both days.",
      });
    const history = yield* Effect.forEach([...new Set(keys)], (key) =>
      Numbers.values(lead, key, from, to),
    );
    return { history, sensitive: true as const };
  }),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

export const numbersHandlers = {
  number_record: McpToolAccess.actsAsCaller(
    Effect.fn("KinNumbers.mcp.number_record")(function* (input: typeof NumberRecordInput.Type) {
      return yield* recordWatched(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  numbers_read: McpToolAccess.reads(
    Effect.fn("KinNumbers.mcp.numbers_read")(function* (input: typeof NumbersReadInput.Type) {
      return yield* readWatched(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
};
