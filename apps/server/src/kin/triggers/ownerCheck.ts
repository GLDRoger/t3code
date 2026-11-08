import {
  KinEvent,
  KinEventId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinWidgetId,
  KinPersonId,
  type MemoryItemHead,
  WorkerReport,
  type KinWidget,
  KinChatId,
  KinOwnerCheckCard,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { stringify } from "yaml";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryWriter from "../memory/MemoryWriter.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";

const day = 86_400_000;
const reasons = ["past_review", "misleading", "old_low_trust", "no_evidence"] as const;
const Selection = Schema.Struct({ itemId: KinMemoryItemId, reason: Schema.Literals(reasons) });
type Selection = typeof Selection.Type;
const decodeCard = Schema.decodeUnknownEffect(KinOwnerCheckCard);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));
const decodeAction = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      widgetId: KinWidgetId,
      revision: Schema.Int,
      actionId: Schema.Literals(["keep", "update", "drop"]),
      value: KinMemoryItemId,
    }),
  ),
);
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerReport));
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function pickOwnerCheckItems(
  orgId: KinOrgId,
  items: ReadonlyArray<MemoryItemHead & { readonly duplicate?: boolean }>,
  misleading: ReadonlySet<string>,
  now: number,
): ReadonlyArray<Selection> {
  return items
    .filter(
      (item) =>
        item.orgId === orgId &&
        !item.duplicate &&
        item.invalid_at === null &&
        item.superseded_by === null,
    )
    .map((item) => {
      const review = memoryDateMillis(item.review_by);
      const rank =
        review < now
          ? 0
          : misleading.has(item.id)
            ? 1
            : item.kind === "claim" &&
                item.trust !== "owner" &&
                memoryDateMillis(item.recorded_at) < now - 30 * day
              ? 2
              : item.kind === "claim" && item.links.length === 0
                ? 3
                : -1;
      return { item, review, rank };
    })
    .filter(({ rank }) => rank >= 0)
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        (Number.isFinite(a.review) ? a.review : Infinity) -
          (Number.isFinite(b.review) ? b.review : Infinity) ||
        ordinal(a.item.id, b.item.id) ||
        ordinal(a.item.path, b.item.path),
    )
    .filter(
      (row, index, rows) => rows.findIndex((other) => other.item.id === row.item.id) === index,
    )
    .slice(0, 5)
    .map(({ item, rank }) => ({ itemId: item.id, reason: reasons[rank] ?? "no_evidence" }));
}

export class OwnerCheckError extends Schema.TaggedError<OwnerCheckError>()("OwnerCheckError", {
  orgId: KinOrgId,
  cause: Schema.Defect(),
}) {}
export class OwnerCheck extends Context.Service<
  OwnerCheck,
  {
    readonly select: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<Selection>, OwnerCheckError>;
    readonly post: (
      orgId: KinOrgId,
      fireId: string,
      selections: ReadonlyArray<Selection>,
    ) => Effect.Effect<ReadonlyArray<Selection>, OwnerCheckError>;
    readonly act: (
      orgId: KinOrgId,
      wakeupId: string,
      eventId: KinEventId,
    ) => Effect.Effect<
      {
        readonly chatId: KinChatId;
        readonly itemId: KinMemoryItemId;
        readonly action: "keep" | "update" | "drop";
      },
      OwnerCheckError,
      MemoryWriter.MemoryWriter
    >;
  }
>()("t3/kin/triggers/ownerCheck") {}

const make = Effect.gen(function* () {
  const memory = yield* Memory.Memory;
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* Chat.KinChatService;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const wrap = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new OwnerCheckError({ orgId, cause })));
  const select = Effect.fn("OwnerCheck.select")((orgId: KinOrgId) =>
    wrap(
      orgId,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const items = yield* memory.query(orgId, { excludeInvalid: true });
        const reports = yield* sql<{
          report_json: string;
        }>`SELECT report_json FROM kin_workers WHERE org_id = ${orgId} AND report_json IS NOT NULL AND ended_at >= ${now - 90 * day} ORDER BY ended_at, worker_id`.pipe(
          Effect.mapError((cause) =>
            isSqlError(cause) ? toPersistenceSqlError("OwnerCheck.select")(cause) : cause,
          ),
        );
        const misleading = new Set<string>();
        for (const row of reports) {
          const report = yield* decodeReport(row.report_json);
          for (const finding of report.misleadingMemory) misleading.add(finding.itemId);
        }
        return pickOwnerCheckItems(orgId, items, misleading, now);
      }),
    ),
  );
  const post = Effect.fn("OwnerCheck.post")(
    (orgId: KinOrgId, fireId: string, selections: ReadonlyArray<Selection>) =>
      wrap(
        orgId,
        Effect.gen(function* () {
          const widgetId = KinWidgetId.make(`owner-check:${orgId}:${fireId}`);
          const previous = yield* repo.getWidget({ orgId, widgetId });
          if (Option.isSome(previous))
            return (yield* decodeCard(previous.value.state)).items.map(({ itemId, reason }) => ({
              itemId,
              reason,
            }));
          const heads = yield* Effect.forEach(selections, (selection) =>
            memory.readItemQuietly(orgId, selection.itemId),
          );
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const existing = yield* repo.getWidget({ orgId, widgetId });
                if (Option.isSome(existing))
                  return (yield* decodeCard(existing.value.state)).items.map(
                    ({ itemId, reason }) => ({ itemId, reason }),
                  );
                if (selections.length === 0) return selections;
                const [lead] = yield* sql<{
                  owner_chat_id: string;
                  owner_person_id: string;
                }>`SELECT l.owner_chat_id, a.owner_person_id FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
                if (lead === undefined) return yield* Effect.fail("missing_lead");
                const chatId = KinChatId.make(lead.owner_chat_id);
                const { message } = yield* chat.notice({
                  orgId,
                  chatId,
                  messageId: KinMessageId.make(widgetId),
                  body: "Memory to review",
                });
                const now = DateTime.formatIso(yield* DateTime.now);
                const state = {
                  items: selections.map((selection, index) => ({
                    ...selection,
                    title: heads[index]?.head.title ?? "",
                    path: heads[index]?.head.path ?? "",
                  })),
                };
                const widget: KinWidget = {
                  orgId,
                  chatId,
                  messageId: message.messageId,
                  widgetId,
                  widgetClass: "native",
                  type: "owner_check",
                  revision: 1,
                  state,
                  source: null,
                  feed: null,
                  awaiting: [KinPersonId.make(lead.owner_person_id)],
                  pinnedAt: null,
                  closedAt: null,
                  updatedAt: now,
                };
                yield* repo.insertWidget(widget);
                yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
                return selections;
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                isSqlError(cause) ? toPersistenceSqlError("OwnerCheck.post")(cause) : cause,
              ),
            );
        }),
      ),
  );
  const act = Effect.fn("OwnerCheck.act")(
    (orgId: KinOrgId, wakeupId: string, eventId: KinEventId) =>
      wrap(
        orgId,
        Effect.gen(function* () {
          const writer = yield* MemoryWriter.MemoryWriter;
          const verified = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const [row] = yield* sql<{
                  json: string;
                }>`SELECT e.json FROM kin_events e JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id WHERE e.org_id = ${orgId} AND e.event_id = ${eventId} AND e.wakeup_id = ${wakeupId} AND e.state = 'claimed' AND w.status = 'running' ORDER BY e.event_id`;
                if (row === undefined) return yield* Effect.fail("unclaimed_action");
                const event = yield* decodeEvent(row.json);
                if (
                  event.orgId !== orgId ||
                  event.eventId !== eventId ||
                  event._tag !== "widget.action" ||
                  event.provenance._tag !== "human"
                )
                  return yield* Effect.fail("not_owner");
                const message = yield* repo.getMessage({ orgId, messageId: event.messageId });
                if (
                  Option.isNone(message) ||
                  message.value.chatId !== event.chatId ||
                  message.value.kind !== "widget_action" ||
                  message.value.authorRole !== "owner" ||
                  message.value.author._tag !== "human" ||
                  message.value.author.personId !== event.provenance.personId ||
                  message.value.author.memberId !== event.provenance.memberId
                )
                  return yield* Effect.fail("not_owner");
                const owners =
                  yield* sql`SELECT m.member_id FROM kin_chat_members m JOIN kin_agents a ON a.org_id = m.org_id AND a.owner_person_id = m.person_id WHERE m.org_id = ${orgId} AND m.member_id = ${event.provenance.memberId} AND m.chat_id = ${event.chatId} AND m.person_id = ${event.provenance.personId} AND m.role = 'owner' AND m.left_at IS NULL AND a.agent_id = ${event.agentId} AND a.retired_at IS NULL ORDER BY m.member_id`;
                if (owners.length === 0) return yield* Effect.fail("not_owner");
                const action = yield* decodeAction(message.value.body);
                const widget = yield* repo.getWidget({ orgId, widgetId: action.widgetId });
                if (
                  Option.isNone(widget) ||
                  widget.value.type !== "owner_check" ||
                  widget.value.chatId !== event.chatId ||
                  message.value.widgetId !== action.widgetId ||
                  widget.value.closedAt !== null ||
                  widget.value.revision !== action.revision ||
                  event.actionId !== action.actionId
                )
                  return yield* Effect.fail("invalid_card");
                const card = yield* decodeCard(widget.value.state);
                if (
                  !card.items.some(
                    (item) => item.itemId === action.value && item.handled === undefined,
                  )
                )
                  return yield* Effect.fail("unknown_item");
                return { action, chatId: event.chatId, widget: widget.value, card };
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                isSqlError(cause) ? toPersistenceSqlError("OwnerCheck.act")(cause) : cause,
              ),
            );
          const item = yield* memory.readItemQuietly(orgId, verified.action.value);
          if (verified.action.actionId !== "update") {
            const { orgId: _org, path, ...frontMatter } = item.head;
            const now = yield* Clock.currentTimeMillis;
            const period = (frontMatter.kind === "person" ? 90 : 30) * day;
            const updated =
              verified.action.actionId === "keep"
                ? {
                    ...frontMatter,
                    review_by: DateTime.formatIso(DateTime.makeUnsafe(now + period)),
                  }
                : { ...frontMatter, invalid_at: DateTime.formatIso(DateTime.makeUnsafe(now)) };
            yield* writer.stage(orgId, wakeupId, {
              path,
              content: `---\n${stringify(updated)}---\n${item.body}`,
              sourceEventId: eventId,
            });
          }
          const at = DateTime.formatIso(yield* DateTime.now);
          const items = verified.card.items.map((item) =>
            item.itemId === verified.action.value
              ? { ...item, handled: verified.action.actionId }
              : item,
          );
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const widget = yield* repo.updateWidget({
                  ...verified.widget,
                  expectedRevision: verified.widget.revision,
                  state: { items },
                  awaiting: items.every((item) => item.handled !== undefined)
                    ? []
                    : verified.widget.awaiting,
                  closedAt: items.every((item) => item.handled !== undefined) ? at : null,
                  updatedAt: at,
                });
                yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                isSqlError(cause) ? toPersistenceSqlError("OwnerCheck.act")(cause) : cause,
              ),
              Effect.tapError((cause) =>
                cause._tag === "KinChatError" &&
                cause.reason === "widget_changed" &&
                verified.action.actionId !== "update"
                  ? writer.discard(orgId, wakeupId)
                  : Effect.void,
              ),
            );
          return {
            chatId: verified.chatId,
            itemId: verified.action.value,
            action: verified.action.actionId,
          };
        }),
      ),
  );
  return OwnerCheck.of({ select, post, act });
});
export const layer = Layer.effect(OwnerCheck, make);
