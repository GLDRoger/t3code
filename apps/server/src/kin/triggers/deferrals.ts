import {
  KinChatId,
  KinDeferralCard,
  KinEventId,
  KinMemoryItemId,
  KinOrgId,
  KinTriggerId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { stringify } from "yaml";

import * as Repository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryWriter from "../memory/MemoryWriter.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import { deferralCardActions } from "../widgets/deferralCard.ts";
import { verifyOwnerTap } from "./ownerCheck.ts";

const HEADS_UP_MS = 30 * 60_000;
export type OnDue = KinDeferralCard["onDue"];
export type DeferralPhase = "heads_up" | "due";

export interface DeferralPlan {
  readonly armed: boolean;
  readonly dueAt: number | null;
  readonly onDue: OnDue;
  readonly phases: ReadonlyArray<{ readonly phase: DeferralPhase; readonly runAt: number }>;
}

export const deferralTriggerId = (itemId: string, phase: DeferralPhase) =>
  KinTriggerId.make(`deferral:${itemId}:${phase}`);
export const deferralWidgetId = (orgId: string, itemId: string) => `deferral:${orgId}:${itemId}`;

// A deferral without on_due only reminds: silence never starts work.
export function planDeferral(
  item: MemoryItemHead & { readonly duplicate?: boolean },
): DeferralPlan {
  const onDue = item.on_due ?? "remind";
  const due = memoryDateMillis(item.due);
  const dueAt = Number.isFinite(due) ? due : null;
  const armed =
    item.kind === "deferral" &&
    item.status === "open" &&
    item.invalid_at === null &&
    item.superseded_by === null &&
    item.duplicate !== true &&
    dueAt !== null;
  if (!armed || dueAt === null) return { armed: false, dueAt, onDue, phases: [] };
  const dueFire = { phase: "due" as const, runAt: dueAt };
  return {
    armed,
    dueAt,
    onDue,
    phases:
      onDue === "start" ? [{ phase: "heads_up", runAt: dueAt - HEADS_UP_MS }, dueFire] : [dueFire],
  };
}

/** The item half of the recheck baseline; TRIG-8 adds the GitHub half. */
export const DeferralSnapshot = Schema.Struct({
  recordedAt: Schema.String,
  supersededBy: Schema.NullOr(KinMemoryItemId),
  links: Schema.Array(Schema.String),
});
export const deferralSnapshot = (item: MemoryItemHead): typeof DeferralSnapshot.Type => ({
  recordedAt: item.recorded_at,
  supersededBy: item.superseded_by,
  links: item.links,
});

const then: Record<OnDue, string> = {
  start: "I'll start then.",
  remind: "I'll remind you then.",
  ask: "I'll ask you then.",
  chase: "I'll chase it then.",
};

export function confirmText(dueAt: number, onDue: OnDue, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(dueAt)
      .map((part) => [part.type, part.value]),
  );
  return `Deferred to ${parts.weekday} ${parts.day} ${parts.month}, ${Number(parts.hour)}:${parts.minute}. ${then[onDue]}`;
}

export class DeferralError extends Schema.TaggedError<DeferralError>()("DeferralError", {
  orgId: KinOrgId,
  cause: Schema.Defect(),
}) {}

const decodeCard = Schema.decodeUnknownEffect(KinDeferralCard);
const decodeAction = Schema.decodeUnknownEffect(
  Schema.Struct({ actionId: Schema.Literals(deferralCardActions), value: KinMemoryItemId }),
);

export class Deferrals extends Context.Service<
  Deferrals,
  {
    /** Applies a verified owner tap on a deferral card. [Change] hands the item to the lead. */
    readonly act: (
      orgId: KinOrgId,
      wakeupId: string,
      eventId: KinEventId,
    ) => Effect.Effect<
      {
        readonly chatId: KinChatId;
        readonly itemId: KinMemoryItemId;
        readonly action: (typeof deferralCardActions)[number];
      },
      DeferralError,
      MemoryWriter.MemoryWriter
    >;
  }
>()("t3/kin/triggers/deferrals") {}

const make = Effect.gen(function* () {
  const memory = yield* Memory.Memory;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  return Deferrals.of({
    act: Effect.fn("Deferrals.act")((orgId, wakeupId, eventId) =>
      Effect.gen(function* () {
        const writer = yield* MemoryWriter.MemoryWriter;
        const tap = yield* verifyOwnerTap(orgId, wakeupId, eventId, "deferral").pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Repository.KinChatRepository, repo),
        );
        const action = yield* decodeAction(tap.action);
        const card = yield* decodeCard(tap.widget.state);
        if (card.itemId !== action.value) return yield* Effect.fail("unknown_item" as const);
        if (action.actionId === "remind") {
          const item = yield* memory.readItemQuietly(orgId, card.itemId);
          if (item.head.kind !== "deferral" || item.head.status !== "open")
            return yield* Effect.fail("not_open" as const);
          if (item.head.on_due !== "remind") {
            const { orgId: _org, path, ...frontMatter } = item.head;
            yield* writer.stage(orgId, wakeupId, {
              path,
              content: `---\n${stringify({ ...frontMatter, on_due: "remind" })}---\n${item.body}`,
              sourceEventId: eventId,
            });
          }
        }
        return { chatId: tap.chatId, itemId: card.itemId, action: action.actionId };
      }).pipe(Effect.mapError((cause) => new DeferralError({ orgId, cause }))),
    ),
  });
});

export const layer = Layer.effect(Deferrals, make);
