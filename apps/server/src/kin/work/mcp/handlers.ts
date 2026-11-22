import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { numbersHandlers } from "../../numbers/mcp.ts";
import { LeadMemory } from "../../lead/LeadMemory.ts";
import * as Clients from "../leadClients.ts";
import * as Money from "../leadMoney.ts";
import * as Work from "../leadWork.ts";
import * as Comments from "../workComments.ts";
import { liftMarks } from "../pageMarks.ts";
import { KinWorkToolkit } from "./tools.ts";

const isKinChatError = Schema.is(KinChatError);
const RELATIONSHIP_ITEMS = 5;
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Work is unavailable right now." });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinWorkToolkit, {
  ...numbersHandlers,
  records_query: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.query")(function* (input) {
      const result = yield* Work.query(yield* McpInvocationContext, input);
      const [records, marks] = liftMarks(result.records);
      return { ...result, records, ...marks };
    }, Effect.mapError(failure)),
  ),
  record_get: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.get")(function* (input) {
      return yield* Work.get(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  client_read: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.clientRead")(function* (input) {
      const scope = yield* McpInvocationContext;
      const record = yield* Work.get(scope, input);
      const contact = yield* Clients.contact(scope, input);
      const memory = yield* LeadMemory;
      const items = yield* memory.search(scope, {
        kind: "relationship",
        linksTo: `client:${record.key}`,
        limit: RELATIONSHIP_ITEMS,
      });
      const relationship = yield* Effect.forEach(items, (item) =>
        memory.read(scope, { id: item.id }),
      );
      return { record, ...contact, relationship };
    }, Effect.mapError(failure)),
  ),
  touch_log: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.touchLog")(function* (input) {
      return yield* Clients.logTouch(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_create: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.create")(function* (input) {
      const result = yield* Work.create(yield* McpInvocationContext, input);
      const [records, marks] = liftMarks(result.records);
      return { ...result, records, ...marks };
    }, Effect.mapError(failure)),
  ),
  record_update: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.update")(function* (input) {
      const scope = yield* McpInvocationContext;
      const { key, ...change } = input;
      return key === undefined || input.keys !== undefined
        ? yield* Work.updateMany(scope, input)
        : yield* Work.update(scope, { ...change, key });
    }, Effect.mapError(failure)),
  ),
  record_assign: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.assign")(function* (input) {
      return yield* Work.assign(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_hand_back: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.handBack")(function* (input) {
      return yield* Work.handBack(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_comment: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.comment")(function* (input) {
      return yield* Comments.leadComment(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  record_link: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.link")(function* (input) {
      return yield* Comments.leadLink(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  project_note: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.projectNote")(function* (input) {
      return yield* Comments.leadProjectNote(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  list_define: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.define")(function* (input) {
      return yield* Money.define(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  payment_record: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.payment")(function* (input) {
      return yield* Money.payment(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  deal_stages: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.dealStages")(function* (input) {
      return yield* Work.dealStages(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  money_summary: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.money")(function* (input) {
      return yield* Money.money(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  money_query: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.moneyQuery")(function* (input) {
      return yield* Money.moneyQuery(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  budget_set: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.budget")(function* (input) {
      return yield* Money.budget(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  dates_query: McpToolAccess.reads(
    Effect.fn("KinWorkToolkit.dates")(function* (input) {
      const result = yield* Money.datesQuery(yield* McpInvocationContext, input);
      const [dates, marks] = liftMarks(result.dates);
      return { ...result, dates, ...marks };
    }, Effect.mapError(failure)),
  ),
  company_profile: McpToolAccess.actsAsCaller(
    Effect.fn("KinWorkToolkit.profile")(function* (input) {
      return yield* Money.profile(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
