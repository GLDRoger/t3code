import {
  KinAgentId,
  KinChatError,
  type KinCanvasActivity,
  type KinCanvasChange,
  type KinCanvasEvent,
  type KinCanvasInput,
  type KinCanvasPlace,
  type KinCanvasPlaceInput,
  type KinCanvasPlacesResult,
  type KinCanvasRead,
  type KinCanvasRemoved,
  type KinCanvasSeenResult,
  type KinCanvasUnplaceInput,
  type KinCanvasWidget,
  type KinCanvasWidgetAddInput,
  type KinCanvasWidgetKind,
  type KinCanvasWidgetRemoveInput,
  type KinChatId,
  type KinOrgId,
  type KinRecordRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Pull from "effect/Pull";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as Presence from "../reply/KinPresence.ts";
import { KinRecords, type Tick } from "../work/KinRecords.ts";
import { type Viewer, viewerOf } from "../work/ownerWork.ts";
import { actorOf, isClosed, iso, unavailable, workFailure } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, type KinViewer, ledProjects, viewerOfPeople } from "../work/teamView.ts";
import { changesSince, projectCounts, shownEntries, wakeupKeys } from "./canvasReads.ts";

/** At most this many changed entries in the since list, and keys per agent's activity. */
const SINCE_MAX = 40;
const ACTIVITY_KEYS = 20;
/** A burst of Work changes or status lines is read once. */
const SETTLE = Duration.millis(250);

const arrangeRefused = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner arranges the canvas.",
});
const noItem = (key: string) =>
  new KinChatError({ reason: "not_found", message: `Nothing called ${key.slice(0, 40)} here.` });
const notAProject = (key: string) =>
  new KinChatError({
    reason: "invalid_state",
    message: `Progress and facts count a project's tasks; ${key.slice(0, 40)} isn't a project.`,
  });

/** What a screen holds, to tell whether a fresh read differs from it. */
const fingerprint = (value: unknown): string => JSON.stringify(value);

const isWidgetId = (key: string) => key.startsWith("cw_");

type StoredWidget = {
  readonly widgetId: string;
  readonly kind: KinCanvasWidgetKind;
  readonly sourceRecordId: string;
  readonly sourceKey: string;
  readonly sourceTitle: string;
  readonly addedByKind: string;
  readonly addedById: string | null;
  readonly addedAt: number;
};

/** A canvas write, told to every open canvas of the org; each session keeps what its viewer reads. */
type News =
  | { readonly _tag: "placed"; readonly places: ReadonlyArray<KinCanvasPlace> }
  | { readonly _tag: "unplaced"; readonly keys: ReadonlyArray<string> }
  | { readonly _tag: "widget"; readonly id: string }
  | { readonly _tag: "widgetRemoved"; readonly id: string };

export class KinCanvas extends Context.Service<
  KinCanvas,
  {
    readonly read: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasInput,
    ) => Effect.Effect<KinCanvasRead, KinChatError>;
    /** The read whole, then what moved, as the viewer's own read would show it. */
    readonly subscribe: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasInput,
    ) => Stream.Stream<KinCanvasEvent, KinChatError>;
    /** One viewer's session, driven by hand in tests; `subscribe` runs it over the live sources. */
    readonly session: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasInput,
    ) => Effect.Effect<CanvasSession, KinChatError>;
    readonly place: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasPlaceInput,
    ) => Effect.Effect<KinCanvasPlacesResult, KinChatError>;
    readonly unplace: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasUnplaceInput,
    ) => Effect.Effect<KinCanvasPlacesResult, KinChatError>;
    readonly widgetAdd: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasWidgetAddInput,
    ) => Effect.Effect<KinCanvasWidget, KinChatError>;
    readonly widgetRemove: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasWidgetRemoveInput,
    ) => Effect.Effect<KinCanvasRemoved, KinChatError>;
    readonly seen: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinCanvasInput,
    ) => Effect.Effect<KinCanvasSeenResult, KinChatError>;
  }
>()("t3/kin/canvas/KinCanvas") {}

type CanvasSession = {
  readonly start: () => Effect.Effect<ReadonlyArray<KinCanvasEvent>, KinChatError>;
  readonly news: (news: News) => Effect.Effect<ReadonlyArray<KinCanvasEvent>, KinChatError>;
  readonly ticks: (
    ticks: ReadonlyArray<Tick>,
  ) => Effect.Effect<ReadonlyArray<KinCanvasEvent>, KinChatError>;
  readonly presence: () => Effect.Effect<ReadonlyArray<KinCanvasEvent>, KinChatError>;
};

const viewOf = (viewer: Viewer): KinViewer =>
  viewer.teammate ? viewerOfPeople([viewer.person.personId]) : KIN_OWNER_LEVEL;

const randomId = Effect.fn("KinCanvas.randomId")(function* () {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "cw_";
  for (let i = 0; i < 16; i++) id += alphabet.charAt(yield* Random.nextIntBetween(0, 35));
  return id;
});

type Needs =
  | KinIdentity
  | KinRecords
  | SqlClient.SqlClient
  | Presence.KinPresence
  | Hub.KinChatHub
  | Repository.KinChatRepository;

const make = Effect.gen(function* () {
  const services = yield* Effect.context<Needs>();
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const presence = yield* Presence.KinPresence;
  const chatHub = yield* Hub.KinChatHub;
  const repo = yield* Repository.KinChatRepository;
  const hubs = new Map<KinOrgId, PubSub.PubSub<News>>();
  yield* Effect.addFinalizer(() => Effect.forEach([...hubs.values()], PubSub.shutdown));
  const hubOf = Effect.fn("KinCanvas.hub")(function* (orgId: KinOrgId) {
    const found = hubs.get(orgId);
    if (found !== undefined) return found;
    const created = yield* PubSub.unbounded<News>();
    hubs.set(orgId, created);
    return created;
  });
  const tell = (orgId: KinOrgId, news: News) =>
    sql.afterCommit(
      Effect.suspend(() => {
        const hub = hubs.get(orgId);
        return hub === undefined ? Effect.void : PubSub.publish(hub, news);
      }),
    );
  const sqlFailure = workFailure;
  const provided =
    <Args extends ReadonlyArray<unknown>, A>(
      run: (...args: Args) => Effect.Effect<A, KinChatError, Needs>,
    ) =>
    (...args: Args) =>
      run(...args).pipe(Effect.provideContext(services));

  const storedPlaces = Effect.fn("KinCanvas.storedPlaces")(function* (orgId: KinOrgId) {
    return yield* sql<KinCanvasPlace>`SELECT item_key AS key, x, y FROM kin_canvas_places
      WHERE org_id = ${orgId} ORDER BY item_key`.pipe(sqlFailure);
  });
  const storedWidgets = Effect.fn("KinCanvas.storedWidgets")(function* (
    orgId: KinOrgId,
    ids?: ReadonlyArray<string>,
  ) {
    if (ids !== undefined && ids.length === 0) return [];
    return yield* sql<StoredWidget>`SELECT widget_id AS "widgetId", kind,
        source_record_id AS "sourceRecordId", source_key AS "sourceKey",
        source_title AS "sourceTitle", added_by_kind AS "addedByKind",
        added_by_id AS "addedById", added_at AS "addedAt"
      FROM kin_canvas_widgets WHERE org_id = ${orgId}
        ${ids === undefined ? sql`` : sql`AND widget_id IN ${sql.in(ids)}`}
      ORDER BY added_at, rowid`.pipe(sqlFailure);
  });

  /** The widgets this viewer may read, valued from their own read; one gone shows owner-level only. */
  const widgetsFor = Effect.fn("KinCanvas.widgetsFor")(function* (
    viewer: KinViewer,
    orgId: KinOrgId,
    stored: ReadonlyArray<StoredWidget>,
  ) {
    if (stored.length === 0) return [];
    const now = yield* Clock.currentTimeMillis;
    const sources = new Map(
      (yield* shownEntries(viewer, orgId, {
        ids: stored.map((widget) => widget.sourceRecordId),
      })).map((entry) => [entry.recordId, entry]),
    );
    const counted = yield* projectCounts(
      viewer,
      orgId,
      stored.flatMap((widget) => {
        const source = sources.get(widget.sourceRecordId);
        return widget.kind !== "countdown" && source?.registerId === "projects"
          ? [source.recordId]
          : [];
      }),
      now,
    );
    const out: Array<KinCanvasWidget> = [];
    for (const widget of stored) {
      const source = sources.get(widget.sourceRecordId);
      if (source === undefined && viewer._tag !== "ownerLevel") continue;
      if (source !== undefined && source.title !== widget.sourceTitle)
        yield* sql`UPDATE kin_canvas_widgets SET source_title = ${source.title}
          WHERE org_id = ${orgId} AND widget_id = ${widget.widgetId}`.pipe(sqlFailure);
      const counts = source === undefined ? undefined : counted.get(source.recordId);
      out.push({
        id: widget.widgetId,
        kind: widget.kind,
        source: {
          recordId: widget.sourceRecordId as KinRecordRef["recordId"],
          key: source?.key ?? widget.sourceKey,
          title: (source?.title ?? widget.sourceTitle) as KinRecordRef["title"],
        },
        value:
          source === undefined
            ? { _tag: "gone" }
            : widget.kind === "countdown"
              ? {
                  _tag: "countdown",
                  at: source.dueAt === null ? null : iso(source.dueAt),
                  allDay: source.dueAllDay === 1,
                  closed: isClosed(source.state),
                }
              : widget.kind === "progress"
                ? { _tag: "progress", done: counts?.done ?? 0, total: counts?.total ?? 0 }
                : {
                    _tag: "facts",
                    open: counts?.open ?? 0,
                    doing: counts?.doing ?? 0,
                    waiting: counts?.waiting ?? 0,
                    late: counts?.late ?? 0,
                  },
        addedBy: actorOf(widget.addedByKind, widget.addedById),
        addedAt: iso(widget.addedAt),
      });
    }
    return out;
  });

  /** Stored places of entries this viewer may read and of the widgets they are shown. */
  const placesFor = Effect.fn("KinCanvas.placesFor")(function* (
    viewer: KinViewer,
    orgId: KinOrgId,
    places: ReadonlyArray<KinCanvasPlace>,
    widgets: ReadonlySet<string>,
  ) {
    const entries = places.filter((place) => !isWidgetId(place.key));
    const shown = new Set(
      (yield* shownEntries(viewer, orgId, { keys: entries.map((place) => place.key) })).map(
        (entry) => entry.key,
      ),
    );
    return places.filter((place) =>
      isWidgetId(place.key) ? widgets.has(place.key) : shown.has(place.key),
    );
  });

  const sinceFor = Effect.fn("KinCanvas.since")(function* (viewer: Viewer, orgId: KinOrgId) {
    const { personId } = viewer.person;
    const [row] = yield* sql<{ seenAt: number }>`SELECT seen_at AS "seenAt" FROM kin_canvas_seen
      WHERE org_id = ${orgId} AND person_id = ${personId}`.pipe(sqlFailure);
    if (row === undefined) return { seenAt: null, changes: [], more: 0 };
    const led = viewer.teammate
      ? new Set<string>(
          (yield* ledProjects(orgId, personId).pipe(sqlFailure)).map((project) => project.recordId),
        )
      : new Set<string>();
    const rows = yield* changesSince(viewOf(viewer), orgId, personId, row.seenAt, led);
    const folded = new Map<string, KinCanvasChange & { readonly actors: Set<string> }>();
    for (const change of rows) {
      const actor = `${change.actorKind}:${change.actorId ?? ""}`;
      const held = folded.get(change.key);
      if (held === undefined) {
        folded.set(change.key, {
          key: change.key,
          title: change.title,
          by: actorOf(change.actorKind, change.actorId),
          others: 0,
          count: 1,
          at: iso(change.at),
          created: change.createdAt > row.seenAt,
          actors: new Set([actor]),
        });
        continue;
      }
      held.actors.add(actor);
      folded.set(change.key, { ...held, count: held.count + 1, others: held.actors.size - 1 });
    }
    const all = [...folded.values()];
    return {
      seenAt: iso(row.seenAt),
      changes: all.slice(0, SINCE_MAX).map(({ actors: _actors, ...change }) => change),
      more: Math.max(0, all.length - SINCE_MAX),
    };
  });

  /** Agents' status lines in chats this person is in now, and what their wake-ups changed. */
  const activityFor = Effect.fn("KinCanvas.activity")(function* (viewer: Viewer, orgId: KinOrgId) {
    const lines = presence.orgLines(orgId).filter((line) => line.presence.state !== "seen");
    if (lines.length === 0) return [];
    const member = new Map<KinChatId, boolean>();
    for (const { chatId } of lines)
      if (!member.has(chatId))
        member.set(
          chatId,
          Option.isSome(
            yield* repo
              .activeMember({ orgId, chatId, principal: viewer.person })
              .pipe(Effect.mapError(() => unavailable)),
          ),
        );
    const shown = lines.filter((line) => member.get(line.chatId) === true);
    if (shown.length === 0) return [];
    const agentIds = [...new Set(shown.map((line) => line.presence.agentId))];
    const names = new Map(
      (yield* sql<{ agentId: string; name: string }>`SELECT agent_id AS "agentId",
          display_name AS name FROM kin_agents
        WHERE org_id = ${orgId} AND agent_id IN ${sql.in(agentIds)}
        ORDER BY agent_id`.pipe(sqlFailure)).map((row) => [row.agentId, row.name]),
    );
    const keys = yield* wakeupKeys(
      viewOf(viewer),
      orgId,
      shown.flatMap((line) => (line.presence.wakeupId === null ? [] : [line.presence.wakeupId])),
      ACTIVITY_KEYS,
    );
    return shown
      .map(({ chatId, presence: line }): KinCanvasActivity => ({
        agentId: KinAgentId.make(line.agentId),
        name: names.get(line.agentId) ?? line.agentId,
        chatId,
        state: line.state,
        label: line.label,
        startedAt: line.startedAt,
        keys: line.wakeupId === null ? [] : (keys.get(line.wakeupId) ?? []),
      }))
      .toSorted(
        (a, b) =>
          b.startedAt.localeCompare(a.startedAt) ||
          a.agentId.localeCompare(b.agentId) ||
          a.chatId.localeCompare(b.chatId),
      );
  });

  const readAs = Effect.fn("KinCanvas.readAs")(function* (viewer: Viewer, orgId: KinOrgId) {
    const view = viewOf(viewer);
    const widgets = yield* widgetsFor(view, orgId, yield* storedWidgets(orgId));
    const places = yield* placesFor(
      view,
      orgId,
      yield* storedPlaces(orgId),
      new Set(widgets.map((widget) => widget.id)),
    );
    return {
      places,
      widgets,
      since: yield* sinceFor(viewer, orgId),
      activity: yield* activityFor(viewer, orgId),
      canArrange: !viewer.teammate,
    } satisfies KinCanvasRead;
  });

  const arranger = Effect.fn("KinCanvas.arranger")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const viewer = yield* viewerOf(people, orgId);
    if (viewer.teammate) return yield* arrangeRefused;
    return viewer;
  });

  const read = Effect.fn("KinCanvas.read")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasInput,
  ) {
    return yield* readAs(yield* viewerOf(people, input.orgId), input.orgId);
  });

  const place = Effect.fn("KinCanvas.place")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasPlaceInput,
  ) {
    const { orgId } = input;
    const viewer = yield* arranger(people, orgId);
    const latest = new Map(input.places.map((one) => [one.key, one]));
    const places = [...latest.values()];
    const widgetIds = places.filter((one) => isWidgetId(one.key)).map((one) => one.key);
    const entryKeys = places.filter((one) => !isWidgetId(one.key)).map((one) => one.key);
    const widgets = new Set(
      (yield* storedWidgets(orgId, widgetIds)).map((widget) => widget.widgetId),
    );
    const entries = new Set(
      (yield* shownEntries(viewOf(viewer), orgId, { keys: entryKeys })).map((entry) => entry.key),
    );
    const missing = places.find((one) =>
      isWidgetId(one.key) ? !widgets.has(one.key) : !entries.has(one.key),
    );
    if (missing !== undefined) return yield* noItem(missing.key);
    const now = yield* Clock.currentTimeMillis;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const one of places)
            yield* sql`INSERT INTO kin_canvas_places (org_id, item_key, x, y, by_kind, by_id, at)
              VALUES (${orgId}, ${one.key}, ${one.x}, ${one.y}, 'person', ${viewer.person.personId},
                ${now})
              ON CONFLICT (org_id, item_key) DO UPDATE SET x = excluded.x, y = excluded.y,
                by_kind = excluded.by_kind, by_id = excluded.by_id, at = excluded.at`;
          yield* tell(orgId, { _tag: "placed", places });
        }),
      )
      .pipe(sqlFailure);
    return { places };
  });

  const unplace = Effect.fn("KinCanvas.unplace")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasUnplaceInput,
  ) {
    const { orgId } = input;
    yield* arranger(people, orgId);
    const keys = [...new Set(input.keys)];
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM kin_canvas_places
            WHERE org_id = ${orgId} AND item_key IN ${sql.in(keys)}`;
          yield* tell(orgId, { _tag: "unplaced", keys });
        }),
      )
      .pipe(sqlFailure);
    return { places: [] };
  });

  const widgetAdd = Effect.fn("KinCanvas.widgetAdd")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasWidgetAddInput,
  ) {
    const { orgId } = input;
    const viewer = yield* arranger(people, orgId);
    const view = viewOf(viewer);
    const [source] = yield* shownEntries(view, orgId, { keys: [input.source] });
    if (source === undefined) return yield* noItem(input.source);
    if (input.kind !== "countdown" && source.registerId !== "projects")
      return yield* notAProject(source.key);
    const id = yield* randomId();
    const now = yield* Clock.currentTimeMillis;
    const { personId } = viewer.person;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO kin_canvas_widgets (widget_id, org_id, kind, source_record_id,
              source_key, source_title, added_by_kind, added_by_id, added_at)
            VALUES (${id}, ${orgId}, ${input.kind}, ${source.recordId}, ${source.key},
              ${source.title}, 'person', ${personId}, ${now})`;
          yield* tell(orgId, { _tag: "widget", id });
          if (input.place === undefined) return;
          const { x, y } = input.place;
          yield* sql`INSERT INTO kin_canvas_places (org_id, item_key, x, y, by_kind, by_id, at)
            VALUES (${orgId}, ${id}, ${x}, ${y}, 'person', ${personId}, ${now})`;
          yield* tell(orgId, { _tag: "placed", places: [{ key: id, x, y }] });
        }),
      )
      .pipe(sqlFailure);
    const [widget] = yield* widgetsFor(view, orgId, yield* storedWidgets(orgId, [id]));
    if (widget === undefined) return yield* unavailable;
    return widget;
  });

  const widgetRemove = Effect.fn("KinCanvas.widgetRemove")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasWidgetRemoveInput,
  ) {
    const { orgId, id } = input;
    yield* arranger(people, orgId);
    const removed = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const gone = yield* sql`DELETE FROM kin_canvas_widgets
            WHERE org_id = ${orgId} AND widget_id = ${id} RETURNING widget_id`;
          if (gone.length === 0) return false;
          yield* sql`DELETE FROM kin_canvas_places WHERE org_id = ${orgId} AND item_key = ${id}`;
          yield* tell(orgId, { _tag: "widgetRemoved", id });
          return true;
        }),
      )
      .pipe(sqlFailure);
    if (!removed) return yield* noItem(id);
    return { id };
  });

  const seen = Effect.fn("KinCanvas.seen")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasInput,
  ) {
    const viewer = yield* viewerOf(people, input.orgId);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO kin_canvas_seen (org_id, person_id, seen_at)
      VALUES (${input.orgId}, ${viewer.person.personId}, ${now})
      ON CONFLICT (org_id, person_id) DO UPDATE SET seen_at = excluded.seen_at`.pipe(sqlFailure);
    return { seenAt: iso(now) };
  });

  /** Which projects these entries sit in, only to pick the widgets a change may move. */
  const ownerLevelProjectKeys = Effect.fn("KinCanvas.projectKeys")(function* (
    orgId: KinOrgId,
    keys: ReadonlyArray<string>,
  ) {
    if (keys.length === 0) return [];
    const rows = yield* sql<{ key: string }>`SELECT DISTINCT p.key FROM kin_records r
      JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      WHERE r.org_id = ${orgId} AND r.key IN ${sql.in([...new Set(keys)])}
      ORDER BY p.key`.pipe(sqlFailure);
    return rows.map((row) => row.key);
  });

  const session = Effect.fn("KinCanvas.session")(function* (
    people: ReadonlyArray<PersonIdentity>,
    input: KinCanvasInput,
  ) {
    const { orgId } = input;
    let viewer = yield* viewerOf(people, orgId);
    /** What this screen holds: only these are ever moved or taken away. */
    const sentPlaces = new Map<string, string>();
    const sentWidgets = new Map<string, string>();
    let sentActivity = "[]";
    let activityHeld = false;
    const at = (one: KinCanvasPlace) => `${one.x},${one.y}`;

    const start = Effect.fn("KinCanvas.session.start")(function* () {
      const read = yield* readAs(viewer, orgId);
      sentPlaces.clear();
      sentWidgets.clear();
      for (const one of read.places) sentPlaces.set(one.key, at(one));
      for (const widget of read.widgets) sentWidgets.set(widget.id, fingerprint(widget));
      sentActivity = fingerprint(read.activity);
      activityHeld = read.activity.length > 0;
      return [{ _tag: "snapshot", read } satisfies KinCanvasEvent];
    });

    /** These widgets as the viewer reads them now, against what the screen holds. */
    const widgetDiff = Effect.fn("KinCanvas.session.widgets")(function* (
      stored: ReadonlyArray<StoredWidget>,
      ids: ReadonlyArray<string>,
    ) {
      const now = new Map(
        (yield* widgetsFor(viewOf(viewer), orgId, stored)).map((widget) => [widget.id, widget]),
      );
      const out: Array<KinCanvasEvent> = [];
      const shownPlaces: Array<KinCanvasPlace> = [];
      for (const id of ids) {
        const widget = now.get(id);
        if (widget === undefined) {
          if (!sentWidgets.delete(id)) continue;
          sentPlaces.delete(id);
          out.push({ _tag: "widgetRemoved", id });
          continue;
        }
        const json = fingerprint(widget);
        const fresh = !sentWidgets.has(id);
        if (sentWidgets.get(id) === json) continue;
        sentWidgets.set(id, json);
        out.push({ _tag: "widget", widget });
        if (fresh) {
          const [stored] = yield* sql<KinCanvasPlace>`SELECT item_key AS key, x, y
            FROM kin_canvas_places WHERE org_id = ${orgId} AND item_key = ${id}`.pipe(sqlFailure);
          if (stored !== undefined) {
            sentPlaces.set(id, at(stored));
            shownPlaces.push(stored);
          }
        }
      }
      return shownPlaces.length === 0
        ? out
        : [...out, { _tag: "placed", places: shownPlaces } satisfies KinCanvasEvent];
    });

    /** Stored places of these keys as the viewer may read them now, against what they hold. */
    const placeDiff = Effect.fn("KinCanvas.session.places")(function* (
      candidates: ReadonlyArray<KinCanvasPlace>,
      gone: ReadonlyArray<string>,
    ) {
      const shown = yield* placesFor(
        viewOf(viewer),
        orgId,
        candidates,
        new Set(sentWidgets.keys()),
      );
      const visible = new Set(shown.map((one) => one.key));
      const placed = shown.filter((one) => sentPlaces.get(one.key) !== at(one));
      for (const one of placed) sentPlaces.set(one.key, at(one));
      const unplaced = [
        ...candidates.filter((one) => !visible.has(one.key)).map((one) => one.key),
        ...gone,
      ].filter((key) => sentPlaces.delete(key));
      return [
        ...(placed.length === 0 ? [] : [{ _tag: "placed", places: placed } as const]),
        ...(unplaced.length === 0 ? [] : [{ _tag: "unplaced", keys: unplaced } as const]),
      ] satisfies ReadonlyArray<KinCanvasEvent>;
    });

    const activityDiff = Effect.fn("KinCanvas.session.activity")(function* () {
      const activity = yield* activityFor(viewer, orgId);
      const json = fingerprint(activity);
      activityHeld = activity.length > 0;
      if (json === sentActivity) return [];
      sentActivity = json;
      return [{ _tag: "activity", activity } satisfies KinCanvasEvent];
    });

    // A co-owner made a member reads a different canvas: every input checks first, and starts over.
    const releveled = Effect.fn("KinCanvas.session.releveled")(function* () {
      const now = yield* viewerOf(people, orgId);
      if (now.teammate === viewer.teammate) return null;
      viewer = now;
      return yield* start();
    });

    const news = Effect.fn("KinCanvas.session.news")(function* (one: News) {
      const restarted = yield* releveled();
      if (restarted !== null) return restarted;
      switch (one._tag) {
        case "placed":
          return yield* placeDiff(one.places, []);
        case "unplaced":
          return yield* placeDiff([], one.keys);
        case "widget":
          return yield* widgetDiff(yield* storedWidgets(orgId, [one.id]), [one.id]);
        case "widgetRemoved":
          if (!sentWidgets.delete(one.id)) return [];
          sentPlaces.delete(one.id);
          return [{ _tag: "widgetRemoved", id: one.id } satisfies KinCanvasEvent];
      }
    });

    const ticks = Effect.fn("KinCanvas.session.ticks")(function* (burst: ReadonlyArray<Tick>) {
      const restarted = yield* releveled();
      if (restarted !== null) return restarted;
      const keys = burst.flatMap((tick) => (tick.key === undefined ? [] : [tick.key]));
      // A gap, an undo or someone's places moving may move anything.
      const everything = burst.some(
        (tick) =>
          tick.key === undefined ||
          tick.people !== undefined ||
          (viewer.teammate &&
            (tick.registerId === "clients" ||
              tick.registerId === "projects" ||
              (tick.projects ?? []).length > 0)),
      );
      const touched = new Set([
        ...keys,
        ...burst.flatMap((tick) => tick.projects ?? []),
        ...(yield* ownerLevelProjectKeys(orgId, keys)),
      ]);
      const stored = yield* storedWidgets(orgId);
      const moved = everything ? stored : stored.filter((widget) => touched.has(widget.sourceKey));
      const widgets = yield* widgetDiff(
        moved,
        moved.map((widget) => widget.widgetId),
      );
      const places = (yield* storedPlaces(orgId)).filter(
        (one) => !isWidgetId(one.key) && (everything || touched.has(one.key)),
      );
      const shownPlaces = viewer.teammate || everything ? yield* placeDiff(places, []) : [];
      const activity = activityHeld ? yield* activityDiff() : [];
      return [...widgets, ...shownPlaces, ...activity];
    });

    return {
      start: provided(start),
      news: provided(news),
      ticks: provided(ticks),
      presence: provided(
        Effect.fn("KinCanvas.session.presence")(function* () {
          return (yield* releveled()) ?? (yield* activityDiff());
        }),
      ),
    } satisfies CanvasSession;
  });

  const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinCanvasInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { orgId } = input;
        const one = yield* session(people, input);
        const viewer = yield* viewerOf(people, orgId);
        // Every source is listening before the snapshot is read, so nothing falls between.
        const news = yield* PubSub.subscribe(yield* hubOf(orgId));
        const lines = yield* chatHub.subscribeForViewer(viewer.person);
        const pull = yield* Stream.toPull(records.changes(orgId));
        yield* pull.pipe(Pull.catchDone(() => Effect.void));
        const opening = yield* one.start();
        type Input =
          | { readonly _tag: "news"; readonly news: News }
          | { readonly _tag: "ticks"; readonly ticks: ReadonlyArray<Tick> }
          | { readonly _tag: "presence" };
        // One input at a time: each diff reads and moves what the screen holds.
        const live = Stream.mergeAll(
          [
            Stream.fromSubscription(news).pipe(
              Stream.map((one): Input => ({ _tag: "news", news: one })),
            ),
            Stream.fromPull<Tick, KinChatError, never, never, never>(Effect.succeed(pull)).pipe(
              Stream.groupedWithin(512, SETTLE),
              Stream.map((burst): Input => ({ _tag: "ticks", ticks: burst })),
            ),
            lines.pipe(
              Stream.filter((event) => event.type === "presence.updated"),
              Stream.mapError(() => unavailable),
              Stream.groupedWithin(64, SETTLE),
              Stream.map((): Input => ({ _tag: "presence" })),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Stream.mapEffect((input) =>
            input._tag === "news"
              ? one.news(input.news)
              : input._tag === "ticks"
                ? one.ticks(input.ticks)
                : one.presence(),
          ),
        );
        return Stream.concat(Stream.fromIterable(opening), live.pipe(Stream.flattenIterable));
      }),
    ).pipe(Stream.provideContext(services));

  return KinCanvas.of({
    read: provided(read),
    subscribe,
    session: provided(session),
    place: provided(place),
    unplace: provided(unplace),
    widgetAdd: provided(widgetAdd),
    widgetRemove: provided(widgetRemove),
    seen: provided(seen),
  });
});

export const layer = Layer.effect(KinCanvas, make);
