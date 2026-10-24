import {
  CommandId,
  EEVEE_LANE_LABEL,
  KIN_WILL_CHAR_LIMIT,
  KinHouseLineRole,
  KinHouseLineRpcError,
  KinLaneState,
  ProjectId,
  ThreadId,
  KinHouseLineSnapshot,
  laneProcessEnv,
  lineagesForReader,
  resolveKinHouseLineAccess,
  type KinLaneState as KinLaneStateValue,
  type KinLineageLineagesResult,
  type ProjectId as ProjectIdValue,
  type ThreadId as ThreadIdValue,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { assembleHouseLineBrief, type KinBriefWill } from "./brief.ts";
import { crowningIdFromCommand } from "./commandEvents.ts";
import {
  houseForLaneLabel,
  parseHousesTsv,
  parseLineagesTsv,
  patternMatches,
  type KinHouseCatalog,
} from "./housesTsv.ts";
import { regnalLabel } from "./roman.ts";
import { firstReadsMatchLog, parseLaneReport, type KinReadRef } from "./report.ts";

export { laneProcessEnv };

export class HouseLineError extends Schema.TaggedError<HouseLineError>()("HouseLineError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface KinLaneFinish {
  readonly state: KinLaneStateValue | null;
  readonly prompt: boolean;
}

export interface KinOpenLaneInput {
  readonly projectId: ProjectIdValue;
  readonly threadId: ThreadIdValue;
  readonly label?: string;
  readonly house?: string;
  readonly lineId?: string;
  readonly profile?: string;
  readonly role?: typeof KinHouseLineRole.Type | null;
  readonly crownable?: boolean;
  readonly seesWills?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly touchedPaths?: ReadonlyArray<string>;
}

export class HouseLineService extends Context.Service<
  HouseLineService,
  {
    readonly importCatalog: (input: {
      readonly projectId: ProjectIdValue;
      readonly text: string;
      readonly source: "houses" | "lineages";
    }) => Effect.Effect<void, HouseLineError>;
    readonly reloadHouses: (input: {
      readonly projectId: ProjectIdValue;
      readonly workspaceRoot: string;
    }) => Effect.Effect<void, HouseLineError>;
    readonly openLane: (
      input: KinOpenLaneInput,
    ) => Effect.Effect<{ readonly laneId: string; readonly houseName: string }, HouseLineError>;
    readonly addNote: (input: {
      readonly threadId: ThreadIdValue;
      readonly body: string;
      readonly houseNames?: ReadonlyArray<string>;
    }) => Effect.Effect<{ readonly noteId: string }, HouseLineError>;
    readonly read: (input: {
      readonly threadId: ThreadIdValue;
      readonly subject?: "notes" | "wills" | "all";
      readonly houseName?: string;
      readonly since?: string;
      readonly authorLaneId?: string;
    }) => Effect.Effect<
      {
        readonly notes: ReadonlyArray<{
          readonly id: string;
          readonly body: string;
          readonly at: string;
          readonly authorLaneId: string | null;
        }>;
        readonly wills: ReadonlyArray<{
          readonly id: string;
          readonly body: string;
          readonly regnalLabel: string;
          readonly at: string;
        }>;
      },
      HouseLineError
    >;
    readonly areas: (
      projectId: ProjectIdValue,
    ) => Effect.Effect<KinHouseLineSnapshot["houses"], HouseLineError>;
    readonly crown: (threadId: ThreadIdValue) => Effect.Effect<
      {
        readonly houseName: string;
        readonly regnalNumber: number;
        readonly regnalLabel: string;
        readonly crowningId: string;
      },
      HouseLineError
    >;
    readonly will: (input: {
      readonly threadId: ThreadIdValue;
      readonly body: string;
    }) => Effect.Effect<{ readonly willId: string; readonly crowningId: string }, HouseLineError>;
    readonly lineages: (
      threadId: ThreadIdValue,
    ) => Effect.Effect<KinLineageLineagesResult, HouseLineError>;
    readonly seesWills: (threadId: ThreadIdValue) => Effect.Effect<boolean, HouseLineError>;
    readonly crownable: (threadId: ThreadIdValue) => Effect.Effect<boolean, HouseLineError>;
    readonly recordReport: (input: {
      readonly threadId: ThreadIdValue;
      readonly body: string;
    }) => Effect.Effect<{ readonly mismatch: boolean }, HouseLineError>;
    readonly finishLane: (threadId: ThreadIdValue) => Effect.Effect<KinLaneFinish, HouseLineError>;
    readonly snapshot: (
      projectId: ProjectIdValue,
    ) => Effect.Effect<KinHouseLineSnapshot, HouseLineError>;
    readonly briefFor: (laneId: string) => Effect.Effect<string, HouseLineError>;
  }
>()("t3/kin/houseLine/HouseLineService") {}

const HouseRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agentMapPath: Schema.NullOr(Schema.String),
});
const PatternRow = Schema.Struct({ houseId: Schema.String, pattern: Schema.String });
const ReignRow = Schema.Struct({
  crowningId: Schema.String,
  laneId: Schema.String,
  lineId: Schema.String,
  label: Schema.String,
  threadId: Schema.String,
  regnalNumber: Schema.Number,
  provider: Schema.String,
  model: Schema.String,
  profile: Schema.String,
  at: Schema.String,
  houseId: Schema.String,
  willId: Schema.NullOr(Schema.String),
  willBody: Schema.NullOr(Schema.String),
});
const LaneViewRow = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  houseName: Schema.String,
  label: Schema.String,
  state: Schema.String,
  reportMismatch: Schema.Number,
});
const LaneRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  houseId: Schema.String,
  houseName: Schema.String,
  label: Schema.String,
  threadId: Schema.String,
  lineId: Schema.String,
  profile: Schema.String,
  role: Schema.String,
  crownable: Schema.Number,
  seesWills: Schema.Number,
  provider: Schema.String,
  model: Schema.String,
  state: Schema.String,
  touchedPathsJson: Schema.String,
  agentMapPath: Schema.NullOr(Schema.String),
});
const MaxRow = Schema.Struct({ maxRegnal: Schema.Number });
const CrowningRow = Schema.Struct({
  id: Schema.String,
  regnalNumber: Schema.Number,
  houseName: Schema.String,
});
const NoteRow = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  at: Schema.String,
  authorLaneId: Schema.NullOr(Schema.String),
  flaggedJson: Schema.String,
});
const WillRow = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  at: Schema.String,
  regnalNumber: Schema.Number,
  houseName: Schema.String,
  crowningId: Schema.String,
});
const ReadRow = Schema.Struct({ kind: Schema.String, targetId: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();

  const failed = (detail: string, cause?: unknown) =>
    new HouseLineError({ detail, ...(cause === undefined ? {} : { cause }) });

  const query = <A>(
    schema: Schema.Codec<A>,
    effect: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError((cause) => failed("Could not read house line rows.", cause)),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
          Effect.mapError((cause) => failed("Could not read house line rows.", cause)),
        ),
      ),
    );

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  const writeSql =
    (detail: string) =>
    <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) => failed(detail, cause)),
        Effect.asVoid,
      );

  const loadSnapshot = Effect.fn("HouseLineService.snapshot")(function* (
    projectId: ProjectIdValue,
  ) {
    const houses = yield* query(
      HouseRow,
      sql`
        SELECT id, name, agent_map_path AS agentMapPath
        FROM kin_house
        WHERE project_id = ${projectId}
        ORDER BY name ASC, id ASC
      `,
    );
    const patterns = yield* query(
      PatternRow,
      sql`
        SELECT house_id AS houseId, pattern
        FROM kin_house_pattern
        WHERE project_id = ${projectId}
        ORDER BY position ASC
      `,
    );
    const reigns = yield* query(
      ReignRow,
      sql`
        SELECT
          c.id AS crowningId,
          c.lane_id AS laneId,
          l.line_id AS lineId,
          l.label AS label,
          l.thread_id AS threadId,
          c.regnal_number AS regnalNumber,
          c.provider AS provider,
          c.model AS model,
          c.agent_profile AS profile,
          c.crowned_at AS at,
          c.house_id AS houseId,
          w.id AS willId,
          w.body AS willBody
        FROM kin_crowning c
        JOIN kin_lane l ON l.id = c.lane_id
        LEFT JOIN kin_will w ON w.crowning_id = c.id
        WHERE l.project_id = ${projectId}
        ORDER BY c.house_id ASC, c.regnal_number ASC, c.id ASC
      `,
    );
    const lanes = yield* query(
      LaneViewRow,
      sql`
        SELECT
          l.id AS id,
          l.thread_id AS threadId,
          h.name AS houseName,
          l.label AS label,
          l.state AS state,
          COALESCE(r.mismatch, 0) AS reportMismatch
        FROM kin_lane l
        JOIN kin_house h ON h.id = l.house_id
        LEFT JOIN kin_lane_report r ON r.lane_id = l.id
        WHERE l.project_id = ${projectId}
        ORDER BY h.name ASC, l.id ASC
      `,
    );
    const patternsByHouse = new Map<string, Array<string>>();
    for (const pattern of patterns) {
      const list = patternsByHouse.get(pattern.houseId) ?? [];
      list.push(pattern.pattern);
      patternsByHouse.set(pattern.houseId, list);
    }
    const snapshot = {
      houses: houses.map((house) => ({
        id: house.id,
        name: house.name,
        patterns: patternsByHouse.get(house.id) ?? [],
        agentMapPath: house.agentMapPath,
        reigns: reigns
          .filter((reign) => reign.houseId === house.id)
          .map((reign) => ({
            crowningId: reign.crowningId,
            laneId: reign.laneId,
            lineId: reign.lineId,
            label: reign.label,
            threadId: ThreadId.make(reign.threadId),
            regnalNumber: reign.regnalNumber,
            regnalLabel: regnalLabel(house.name, reign.regnalNumber),
            provider: reign.provider,
            model: reign.model,
            profile: reign.profile,
            at: reign.at,
            willId: reign.willId,
            willBody: reign.willBody,
          })),
      })),
      lanes: lanes.map((lane) => ({
        id: lane.id,
        threadId: ThreadId.make(lane.threadId),
        houseName: lane.houseName,
        label: lane.label,
        state: yieldState(lane.state),
        reportMismatch: lane.reportMismatch !== 0,
      })),
    };
    return yield* Schema.decodeUnknownEffect(KinHouseLineSnapshot)(snapshot).pipe(
      Effect.mapError((cause) => failed("Could not read house line rows.", cause)),
    );
  });

  const findLane = (threadId: ThreadIdValue) =>
    query(
      LaneRow,
      sql`
        SELECT
          l.id AS id,
          l.project_id AS projectId,
          l.house_id AS houseId,
          h.name AS houseName,
          l.label AS label,
          l.thread_id AS threadId,
          l.line_id AS lineId,
          l.profile AS profile,
          l.role AS role,
          l.crownable AS crownable,
          l.sees_wills AS seesWills,
          l.provider AS provider,
          l.model AS model,
          l.state AS state,
          l.touched_paths_json AS touchedPathsJson,
          h.agent_map_path AS agentMapPath
        FROM kin_lane l
        JOIN kin_house h ON h.id = l.house_id
        WHERE l.thread_id = ${threadId}
      `,
    ).pipe(Effect.map((rows) => rows[0]));

  const requireLane = (threadId: ThreadIdValue) =>
    findLane(threadId).pipe(
      Effect.flatMap((lane) =>
        lane === undefined
          ? Effect.fail(failed("This thread has no house lane."))
          : Effect.succeed(lane),
      ),
    );

  const accessFor = (lane: typeof LaneRow.Type) => {
    const role = Schema.decodeUnknownOption(KinHouseLineRole)(lane.role);
    return resolveKinHouseLineAccess({
      role: Option.getOrNull(role),
      crownable: lane.crownable !== 0,
      seesWills: lane.seesWills !== 0,
    });
  };

  const importCatalog = Effect.fn("HouseLineService.importCatalog")(function* (input: {
    readonly projectId: ProjectIdValue;
    readonly text: string;
    readonly source: "houses" | "lineages";
  }) {
    const catalog = yield* Effect.try({
      try: () =>
        input.source === "lineages" ? parseLineagesTsv(input.text) : parseHousesTsv(input.text),
      catch: (cause) =>
        failed(cause instanceof Error ? cause.message : "Could not read houses.tsv.", cause),
    });
    yield* storeCatalog(input.projectId, catalog);
  });

  const storeCatalog = (projectId: ProjectIdValue, catalog: KinHouseCatalog) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM kin_house_pattern WHERE project_id = ${projectId}`;
          for (const house of catalog.houses) {
            const id = houseKey(projectId, house.name);
            yield* sql`
              INSERT INTO kin_house (id, project_id, name, agent_map_path)
              VALUES (${id}, ${projectId}, ${house.name}, ${house.agentMapPath})
              ON CONFLICT (project_id, name) DO UPDATE SET
                agent_map_path = COALESCE(excluded.agent_map_path, kin_house.agent_map_path)
            `;
          }
          let position = 0;
          for (const rule of catalog.rules) {
            yield* sql`
              INSERT INTO kin_house_pattern (project_id, position, pattern, house_id)
              VALUES (${projectId}, ${position}, ${rule.pattern}, ${houseKey(projectId, rule.houseName)})
            `;
            position += 1;
          }
        }),
      )
      .pipe(writeSql("Could not store houses."));

  const ensureHouse = (projectId: ProjectIdValue, name: string) =>
    writeSql("Could not store a house.")(sql`
      INSERT INTO kin_house (id, project_id, name, agent_map_path)
      VALUES (${houseKey(projectId, name)}, ${projectId}, ${name}, NULL)
      ON CONFLICT (project_id, name) DO NOTHING
    `);

  const reloadHouses = Effect.fn("HouseLineService.reloadHouses")(function* (input: {
    readonly projectId: ProjectIdValue;
    readonly workspaceRoot: string;
  }) {
    const housesPath = path.join(input.workspaceRoot, ".kin", "houses.tsv");
    const lineagesPath = path.join(input.workspaceRoot, ".kin", "lineages.tsv");
    const housesText = yield* fileSystem.readFileString(housesPath).pipe(Effect.option);
    if (Option.isSome(housesText)) {
      yield* importCatalog({
        projectId: input.projectId,
        text: housesText.value,
        source: "houses",
      });
      return;
    }
    const lineagesText = yield* fileSystem.readFileString(lineagesPath).pipe(Effect.option);
    if (Option.isSome(lineagesText)) {
      yield* importCatalog({
        projectId: input.projectId,
        text: lineagesText.value,
        source: "lineages",
      });
      return;
    }
    return yield* failed(`No .kin/houses.tsv or .kin/lineages.tsv in ${input.workspaceRoot}.`);
  });

  const openLane = Effect.fn("HouseLineService.openLane")(function* (input: KinOpenLaneInput) {
    const fromEnv = yield* Config.String(EEVEE_LANE_LABEL).pipe(
      Config.option,
      Effect.mapError((cause) => failed("Could not read EEVEE_LANE_LABEL.", cause)),
    );
    const label = input.label ?? (Option.isSome(fromEnv) ? fromEnv.value : undefined);
    if (label === undefined || label.length === 0) {
      return yield* failed("A lane needs a label.");
    }
    const access = resolveKinHouseLineAccess({
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.crownable === undefined ? {} : { crownable: input.crownable }),
      ...(input.seesWills === undefined ? {} : { seesWills: input.seesWills }),
    });
    let houseName = input.house;
    if (houseName === undefined) {
      const rules = yield* query(
        Schema.Struct({
          pattern: Schema.String,
          houseName: Schema.String,
          agentMapPath: Schema.NullOr(Schema.String),
        }),
        sql`
          SELECT p.pattern AS pattern, h.name AS houseName, h.agent_map_path AS agentMapPath
          FROM kin_house_pattern p
          JOIN kin_house h ON h.id = p.house_id
          WHERE p.project_id = ${input.projectId}
          ORDER BY p.position ASC
        `,
      );
      houseName = houseForLaneLabel(rules, label)?.houseName;
    }
    if (houseName === undefined) {
      return yield* failed(`No house pattern matches lane '${label}'.`);
    }
    yield* ensureHouse(input.projectId, houseName);
    const laneId = laneKey(input.threadId);
    const lineId = input.lineId ?? `kin-line:${laneId}`;
    const at = yield* nowIso;
    const touched = yield* encodeStringArray([...(input.touchedPaths ?? [])]).pipe(
      Effect.mapError((cause) => failed("Could not open the lane.", cause)),
    );
    yield* writeSql("Could not open the lane.")(sql`
      INSERT INTO kin_line (id, house_id, root_lane_id)
      VALUES (${lineId}, ${houseKey(input.projectId, houseName)}, ${laneId})
      ON CONFLICT (id) DO NOTHING
    `);
    yield* writeSql("Could not open the lane.")(sql`
      INSERT INTO kin_lane (
        id, project_id, house_id, label, thread_id, line_id, profile, role,
        crownable, sees_wills, provider, model, state, touched_paths_json, created_at, updated_at
      )
      VALUES (
        ${laneId},
        ${input.projectId},
        ${houseKey(input.projectId, houseName)},
        ${label},
        ${input.threadId},
        ${lineId},
        ${input.profile ?? ""},
        ${input.role ?? ""},
        ${access.crownable ? 1 : 0},
        ${access.seesWills ? 1 : 0},
        ${input.provider ?? ""},
        ${input.model ?? ""},
        'running',
        ${touched},
        ${at},
        ${at}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        label = excluded.label,
        house_id = excluded.house_id,
        line_id = excluded.line_id,
        profile = excluded.profile,
        role = excluded.role,
        crownable = excluded.crownable,
        sees_wills = excluded.sees_wills,
        provider = excluded.provider,
        model = excluded.model,
        touched_paths_json = excluded.touched_paths_json,
        updated_at = excluded.updated_at
    `);
    return { laneId, houseName };
  });

  const addNote = Effect.fn("HouseLineService.addNote")(function* (input: {
    readonly threadId: ThreadIdValue;
    readonly body: string;
    readonly houseNames?: ReadonlyArray<string>;
  }) {
    const body = input.body.trim();
    if (body.length === 0) return yield* failed("A note needs text.");
    const lane = yield* requireLane(input.threadId);
    const names = [...(input.houseNames ?? [lane.houseName])].sort((left, right) =>
      compareByte(left, right),
    );
    const houseIds: string[] = [];
    for (const name of names) {
      const rows = yield* query(
        Schema.Struct({ id: Schema.String }),
        sql`SELECT id FROM kin_house WHERE project_id = ${lane.projectId} AND name = ${name}`,
      );
      const house = rows[0];
      if (house === undefined) return yield* failed(`Unknown house '${name}'.`);
      houseIds.push(house.id);
    }
    const noteId = `kin-note:${yield* uuid}`;
    const at = yield* nowIso;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO kin_note (id, project_id, author_lane_id, body, created_at, flagged_misleading_by_json)
            VALUES (${noteId}, ${ProjectId.make(lane.projectId)}, ${lane.id}, ${body}, ${at}, '[]')
          `;
          for (const houseId of houseIds) {
            yield* sql`INSERT INTO kin_note_house (note_id, house_id) VALUES (${noteId}, ${houseId})`;
          }
        }),
      )
      .pipe(writeSql("Could not add the note."));
    return { noteId };
  });

  const read = Effect.fn("HouseLineService.read")(function* (input: {
    readonly threadId: ThreadIdValue;
    readonly subject?: "notes" | "wills" | "all";
    readonly houseName?: string;
    readonly since?: string;
    readonly authorLaneId?: string;
  }) {
    const lane = yield* requireLane(input.threadId);
    const subject = input.subject ?? "notes";
    const access = accessFor(lane);
    if (!access.seesWills && (subject === "wills" || subject === "all")) {
      return yield* failed("Reviewers do not read wills.");
    }
    const houseName = input.houseName ?? lane.houseName;
    const notes =
      subject === "wills"
        ? []
        : yield* query(
            NoteRow,
            sql`
              SELECT DISTINCT n.id AS id, n.body AS body, n.created_at AS at,
                n.author_lane_id AS authorLaneId, n.flagged_misleading_by_json AS flaggedJson
              FROM kin_note n
              JOIN kin_note_house nh ON nh.note_id = n.id
              JOIN kin_house h ON h.id = nh.house_id
              WHERE n.project_id = ${lane.projectId}
                AND h.name = ${houseName}
                AND (${input.since ?? ""} = '' OR n.created_at >= ${input.since ?? ""})
                AND (${input.authorLaneId ?? ""} = '' OR n.author_lane_id = ${input.authorLaneId ?? ""})
              ORDER BY n.created_at ASC, n.id ASC
            `,
          );
    const wills =
      subject === "notes"
        ? []
        : yield* query(
            WillRow,
            sql`
              SELECT w.id AS id, w.body AS body, w.written_at AS at, c.regnal_number AS regnalNumber,
                h.name AS houseName, c.id AS crowningId
              FROM kin_will w
              JOIN kin_crowning c ON c.id = w.crowning_id
              JOIN kin_lane l ON l.id = c.lane_id
              JOIN kin_house h ON h.id = l.house_id
              WHERE l.project_id = ${lane.projectId}
                AND h.name = ${houseName}
                AND (${input.since ?? ""} = '' OR w.written_at >= ${input.since ?? ""})
              ORDER BY c.regnal_number ASC, w.id ASC
            `,
          );
    const refs: KinReadRef[] = [
      ...notes.map((note) => ({ kind: "note" as const, id: note.id })),
      ...wills.map((will) => ({ kind: "will" as const, id: will.id })),
    ];
    const at = yield* nowIso;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const ref of refs) {
            yield* sql`
              INSERT INTO kin_read_log (id, lane_id, thread_id, kind, target_id, read_at)
              VALUES (${`kin-read:${ref.kind}:${ref.id}:${yield* uuid}`}, ${lane.id}, ${input.threadId}, ${ref.kind}, ${ref.id}, ${at})
            `;
          }
        }),
      )
      .pipe(writeSql("Could not record the read."));
    return {
      notes: notes.map((note) => ({
        id: note.id,
        body: note.body,
        at: note.at,
        authorLaneId: note.authorLaneId,
      })),
      wills: wills.map((will) => ({
        id: will.id,
        body: will.body,
        regnalLabel: regnalLabel(will.houseName, will.regnalNumber),
        at: will.at,
      })),
    };
  });

  const crown = Effect.fn("HouseLineService.crown")(function* (threadId: ThreadIdValue) {
    const lane = yield* requireLane(threadId);
    const access = accessFor(lane);
    if (!access.crownable) return yield* failed("Reviewers are not crowned.");
    const existing = yield* query(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM kin_crowning WHERE lane_id = ${lane.id}`,
    );
    if (existing.length > 0) return yield* failed("This lane is already crowned.");
    return yield* locks.withLock(
      lane.houseId,
      Effect.gen(function* () {
        const maxRows = yield* query(
          MaxRow,
          sql`SELECT COALESCE(MAX(regnal_number), 0) AS maxRegnal FROM kin_crowning WHERE house_id = ${lane.houseId}`,
        );
        const regnalNumber = (maxRows[0]?.maxRegnal ?? 0) + 1;
        const commandId = CommandId.make(`kin-crown:${yield* uuid}`);
        const crowningId = crowningIdFromCommand({ commandId, laneId: lane.id });
        yield* orchestrator
          .dispatch({
            type: "kin.houseLine.crown",
            commandId,
            threadId,
            projectId: ProjectId.make(lane.projectId),
            houseId: lane.houseId,
            houseName: lane.houseName,
            laneId: lane.id,
            lineId: lane.lineId,
            label: lane.label,
            profile: lane.profile,
            role: lane.role,
            crownable: true,
            provider: lane.provider,
            model: lane.model,
            regnalNumber,
          })
          .pipe(Effect.mapError((cause) => failed(dispatchDetail(cause), cause)));
        return {
          houseName: lane.houseName,
          regnalNumber,
          regnalLabel: regnalLabel(lane.houseName, regnalNumber),
          crowningId,
        };
      }),
    );
  });

  const will = Effect.fn("HouseLineService.will")(function* (input: {
    readonly threadId: ThreadIdValue;
    readonly body: string;
  }) {
    const body = input.body.trim();
    if (body.length === 0) return yield* failed("A will needs text.");
    if (body.length > KIN_WILL_CHAR_LIMIT) {
      return yield* failed(`A will is at most ${KIN_WILL_CHAR_LIMIT} characters.`);
    }
    const lane = yield* requireLane(input.threadId);
    const access = accessFor(lane);
    if (!access.crownable) return yield* failed("Reviewers do not leave wills.");
    const crownings = yield* query(
      CrowningRow,
      sql`
        SELECT c.id AS id, c.regnal_number AS regnalNumber, h.name AS houseName
        FROM kin_crowning c
        JOIN kin_house h ON h.id = c.house_id
        WHERE c.lane_id = ${lane.id}
      `,
    );
    const crowning = crownings[0];
    if (crowning === undefined) return yield* failed("Crown the lane before writing a will.");
    const existing = yield* query(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM kin_will WHERE crowning_id = ${crowning.id}`,
    );
    if (existing.length > 0) return yield* failed("This lane already has a will.");
    const willId = `kin-will:${yield* uuid}`;
    yield* orchestrator
      .dispatch({
        type: "kin.houseLine.will",
        commandId: CommandId.make(`kin-will:${yield* uuid}`),
        threadId: input.threadId,
        laneId: lane.id,
        crowningId: crowning.id,
        willId,
        body,
        role: lane.role,
        crownable: true,
      })
      .pipe(Effect.mapError((cause) => failed(dispatchDetail(cause), cause)));
    yield* fileReportIfPresent(lane.id, body).pipe(Effect.ignore);
    return { willId, crowningId: crowning.id };
  });

  const fileReportIfPresent = Effect.fn("HouseLineService.fileReportIfPresent")(function* (
    laneId: string,
    body: string,
  ) {
    const parsed = yield* Effect.try({
      try: () => parseLaneReport(body),
      catch: (cause) =>
        failed(cause instanceof Error ? cause.message : "The report is missing its lines.", cause),
    });
    yield* storeReport(laneId, body, parsed);
  });

  const recordReport = Effect.fn("HouseLineService.recordReport")(function* (input: {
    readonly threadId: ThreadIdValue;
    readonly body: string;
  }) {
    const lane = yield* requireLane(input.threadId);
    const parsed = yield* Effect.try({
      try: () => parseLaneReport(input.body),
      catch: (cause) =>
        failed(cause instanceof Error ? cause.message : "The report is missing its lines.", cause),
    });
    return yield* storeReport(lane.id, input.body, parsed);
  });

  const storeReport = Effect.fn("HouseLineService.storeReport")(function* (
    laneId: string,
    body: string,
    parsed: {
      readonly firstReads: ReadonlyArray<KinReadRef>;
      readonly misleading: ReadonlyArray<KinReadRef>;
    },
  ) {
    const logged = yield* query(
      ReadRow,
      sql`
          SELECT kind, target_id AS targetId
          FROM kin_read_log
          WHERE lane_id = ${laneId}
          ORDER BY kind ASC, target_id ASC, id ASC
        `,
    );
    const verified = uniqueReads(
      logged.flatMap((row) =>
        row.kind === "note" || row.kind === "will" ? [{ kind: row.kind, id: row.targetId }] : [],
      ),
    );
    const mismatch = !firstReadsMatchLog(parsed.firstReads, verified);
    const at = yield* nowIso;
    const misleadingNotes = parsed.misleading
      .filter((ref) => ref.kind === "note")
      .map((ref) => ref.id);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const firstReadsJson = yield* encodeStringArray(
            parsed.firstReads.map(readKey).sort(compareByte),
          );
          const misleadingJson = yield* encodeStringArray(
            parsed.misleading.map(readKey).sort(compareByte),
          );
          const verifiedJson = yield* encodeStringArray(verified.map(readKey).sort(compareByte));
          yield* sql`
              INSERT INTO kin_lane_report (
                lane_id, first_reads_json, misleading_notes_json, verified_reads_json, mismatch, body, created_at
              )
              VALUES (
                ${laneId},
                ${firstReadsJson},
                ${misleadingJson},
                ${verifiedJson},
                ${mismatch ? 1 : 0},
                ${body},
                ${at}
              )
              ON CONFLICT (lane_id) DO UPDATE SET
                first_reads_json = excluded.first_reads_json,
                misleading_notes_json = excluded.misleading_notes_json,
                verified_reads_json = excluded.verified_reads_json,
                mismatch = excluded.mismatch,
                body = excluded.body,
                created_at = excluded.created_at
            `;
          for (const noteId of misleadingNotes) {
            const rows = yield* sql<{ flagged_misleading_by_json: string }>`
                SELECT flagged_misleading_by_json FROM kin_note WHERE id = ${noteId}
              `;
            const current = rows[0]?.flagged_misleading_by_json;
            if (current === undefined) continue;
            const flags = readStringArray(current);
            if (!flags.includes(laneId)) flags.push(laneId);
            flags.sort(compareByte);
            const flaggedJson = yield* encodeStringArray(flags);
            yield* sql`
                UPDATE kin_note SET flagged_misleading_by_json = ${flaggedJson} WHERE id = ${noteId}
              `;
          }
        }),
      )
      .pipe(writeSql("Could not store the lane report."));
    return { mismatch };
  });

  const finishLane = Effect.fn("HouseLineService.finishLane")(function* (threadId: ThreadIdValue) {
    const lane = yield* findLane(threadId);
    if (lane === undefined) return { state: null, prompt: false };
    const access = accessFor(lane);
    if (!access.crownable) return { state: yieldState(lane.state), prompt: false };
    const wills = yield* query(
      Schema.Struct({ id: Schema.String }),
      sql`
        SELECT w.id AS id
        FROM kin_will w
        JOIN kin_crowning c ON c.id = w.crowning_id
        WHERE c.lane_id = ${lane.id}
      `,
    );
    if (wills.length > 0) {
      if (lane.state !== "crowned") yield* setState(lane.id, "crowned");
      return { state: "crowned" as const, prompt: false };
    }
    if (lane.state === "awaiting_will" || lane.state === "will_missing") {
      if (lane.state !== "will_missing") yield* setState(lane.id, "will_missing");
      return { state: "will_missing" as const, prompt: false };
    }
    yield* setState(lane.id, "awaiting_will");
    return { state: "awaiting_will" as const, prompt: true };
  });

  const setState = Effect.fn("HouseLineService.setState")(function* (
    laneId: string,
    state: KinLaneStateValue,
  ) {
    const at = yield* nowIso;
    yield* writeSql("Could not update the lane.")(sql`
      UPDATE kin_lane SET state = ${state}, updated_at = ${at} WHERE id = ${laneId}
    `);
  });

  const briefFor = Effect.fn("HouseLineService.briefFor")(function* (laneId: string) {
    const lanes = yield* query(
      LaneRow,
      sql`
        SELECT
          l.id AS id,
          l.project_id AS projectId,
          l.house_id AS houseId,
          h.name AS houseName,
          l.label AS label,
          l.thread_id AS threadId,
          l.line_id AS lineId,
          l.profile AS profile,
          l.role AS role,
          l.crownable AS crownable,
          l.sees_wills AS seesWills,
          l.provider AS provider,
          l.model AS model,
          l.state AS state,
          l.touched_paths_json AS touchedPathsJson,
          h.agent_map_path AS agentMapPath
        FROM kin_lane l
        JOIN kin_house h ON h.id = l.house_id
        WHERE l.id = ${laneId}
      `,
    );
    const lane = lanes[0];
    if (lane === undefined) return yield* failed("The lane does not exist.");
    const snapshot = yield* loadSnapshot(ProjectId.make(lane.projectId));
    const touched = readStringArray(lane.touchedPathsJson);
    const toWill = (
      reign: KinHouseLineSnapshot["houses"][number]["reigns"][number],
      houseName: string,
    ): KinBriefWill | null =>
      reign.willId === null || reign.willBody === null
        ? null
        : {
            willId: reign.willId,
            crowningId: reign.crowningId,
            houseName,
            regnalNumber: reign.regnalNumber,
            body: reign.willBody,
          };
    const family: KinBriefWill[] = [];
    const houseWills: KinBriefWill[] = [];
    const court: KinBriefWill[] = [];
    for (const house of snapshot.houses) {
      const wills = house.reigns.flatMap((reign) => {
        const will = toWill(reign, house.name);
        return will === null ? [] : [will];
      });
      if (house.name === lane.houseName) {
        for (const reign of house.reigns) {
          const will = toWill(reign, house.name);
          if (will === null) continue;
          if (reign.lineId === lane.lineId) family.push(will);
          else houseWills.push(will);
        }
        continue;
      }
      const touches = house.patterns.some((pattern) =>
        touched.some((file) => patternMatches(pattern, file)),
      );
      if (!touches) continue;
      const latest = wills.reduce<KinBriefWill | null>(
        (current, will) =>
          current === null || will.regnalNumber >= current.regnalNumber ? will : current,
        null,
      );
      if (latest !== null) court.push(latest);
    }
    const notes = yield* query(
      NoteRow,
      sql`
        SELECT DISTINCT n.id AS id, n.body AS body, n.created_at AS at,
          n.author_lane_id AS authorLaneId, n.flagged_misleading_by_json AS flaggedJson
        FROM kin_note n
        JOIN kin_note_house nh ON nh.note_id = n.id
        WHERE nh.house_id = ${lane.houseId}
        ORDER BY n.created_at ASC, n.id ASC
      `,
    );
    return assembleHouseLineBrief({
      houseName: lane.houseName,
      agentMapPath: lane.agentMapPath,
      family,
      court,
      houseWills,
      notes: notes.map((note) => ({ id: note.id, body: note.body, at: note.at })),
    });
  });

  const lineages = Effect.fn("HouseLineService.lineages")(function* (threadId: ThreadIdValue) {
    const lane = yield* requireLane(threadId);
    const snapshot = yield* loadSnapshot(ProjectId.make(lane.projectId));
    return lineagesForReader(snapshot, accessFor(lane).seesWills);
  });

  const seesWills = Effect.fn("HouseLineService.seesWills")(function* (threadId: ThreadIdValue) {
    const lane = yield* findLane(threadId);
    return lane === undefined ? false : accessFor(lane).seesWills;
  });

  const crownable = Effect.fn("HouseLineService.crownable")(function* (threadId: ThreadIdValue) {
    const lane = yield* findLane(threadId);
    return lane === undefined ? false : accessFor(lane).crownable;
  });

  return HouseLineService.of({
    importCatalog,
    reloadHouses,
    openLane,
    addNote,
    read,
    areas: (projectId) => Effect.map(loadSnapshot(projectId), (snapshot) => snapshot.houses),
    crown,
    will,
    lineages,
    seesWills,
    crownable,
    recordReport,
    finishLane,
    snapshot: loadSnapshot,
    briefFor,
  });
});

export const layer = Layer.effect(HouseLineService, make);

export function houseLineRpcError(cause: HouseLineError): KinHouseLineRpcError {
  return new KinHouseLineRpcError({ detail: cause.detail });
}

function dispatchDetail(cause: { readonly message: string; readonly cause?: unknown }): string {
  const nested = cause.cause;
  return nested instanceof Error && nested.message.length > 0 ? nested.message : cause.message;
}

function houseKey(projectId: string, name: string): string {
  return `kin-house:${encodeURIComponent(projectId)}:${encodeURIComponent(name)}`;
}

function laneKey(threadId: string): string {
  return `kin-lane:${encodeURIComponent(threadId)}`;
}

function yieldState(state: string): KinLaneStateValue {
  const decoded = Schema.decodeUnknownOption(KinLaneState)(state);
  if (Option.isNone(decoded)) return "failed";
  return decoded.value;
}

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStringArray = Schema.encodeEffect(StringArrayJson);

function readStringArray(json: string): Array<string> {
  const decoded = Schema.decodeUnknownOption(StringArrayJson)(json);
  return Option.isSome(decoded) ? [...decoded.value] : [];
}

function readKey(ref: KinReadRef): string {
  return `${ref.kind}:${ref.id}`;
}

function uniqueReads(refs: ReadonlyArray<KinReadRef>): KinReadRef[] {
  const seen = new Set<string>();
  const out: KinReadRef[] = [];
  for (const ref of refs) {
    const key = readKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function compareByte(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
