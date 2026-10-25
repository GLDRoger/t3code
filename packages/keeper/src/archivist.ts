import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  countNew,
  deterministicDigest,
  epochMillis,
  fitChronicle,
  formatChronicle,
  parseAsOf,
  passNumber,
  planSession,
  shouldRunPass,
  validEntries,
  type KeeperEntry,
  type KeeperModelConfig,
  type KeeperScope,
} from "./chronicle.ts";

/**
 * Lane 2's LineageService satisfies this. The keeper only reads.
 * `entries` is the Effect form of `KeeperScope.sources()`.
 */
export class KeeperSource extends Context.Service<
  KeeperSource,
  {
    readonly entries: (input: {
      readonly scopeId: string;
    }) => Effect.Effect<readonly KeeperEntry[], KeeperSourceError>;
  }
>()("@t3tools/keeper/archivist/KeeperSource") {}

export class KeeperSourceError extends Schema.TaggedError<KeeperSourceError>()(
  "KeeperSourceError",
  {
    scopeId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read keeper sources for ${this.scopeId}.`;
  }
}

export interface SummarizeInput {
  readonly scopeId: string;
  readonly sessionId: string;
  readonly sessionReused: boolean;
  readonly rebuilt: boolean;
  readonly model: KeeperModelConfig;
  readonly entries: readonly KeeperEntry[];
}

/**
 * Model port. The default layer writes a deterministic digest and does not
 * call a provider. A host adapter should call a cheap model with
 * `renderSummarizerPrompt` and the session id from the tick result.
 */
export class KeeperSummarizer extends Context.Service<
  KeeperSummarizer,
  {
    readonly summarize: (input: SummarizeInput) => Effect.Effect<string, KeeperSummarizeError>;
  }
>()("@t3tools/keeper/archivist/KeeperSummarizer") {}

export class KeeperSummarizeError extends Schema.TaggedError<KeeperSummarizeError>()(
  "KeeperSummarizeError",
  {
    scopeId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Keeper summary failed for ${this.scopeId}.`;
  }
}

export class KeeperStateError extends Schema.TaggedError<KeeperStateError>()("KeeperStateError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read keeper state at ${this.path}.`;
  }
}

export class KeeperWriteError extends Schema.TaggedError<KeeperWriteError>()("KeeperWriteError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to write keeper output at ${this.path}.`;
  }
}

export class KeeperPathError extends Schema.TaggedError<KeeperPathError>()("KeeperPathError", {
  path: Schema.String,
}) {
  override get message(): string {
    return `Keeper path escapes the project root: ${this.path}.`;
  }
}

export const KeeperPassError = Schema.Union([
  KeeperSourceError,
  KeeperSummarizeError,
  KeeperStateError,
  KeeperWriteError,
  KeeperPathError,
]);
export type KeeperPassError = typeof KeeperPassError.Type;

const KeeperState = Schema.Struct({
  pass: Schema.Number,
  asOf: Schema.String,
  sessionId: Schema.String,
  rebuilt: Schema.Boolean,
});
type KeeperState = typeof KeeperState.Type;

const decodeState = Schema.decodeEffect(Schema.fromJsonString(KeeperState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(KeeperState));

export interface ArchivistTickInput {
  readonly scope: KeeperScope;
  readonly projectRoot: string;
  /** Wall time for the chronicle's As-of line. Callers read it from `Clock`. */
  readonly nowMillis: number;
}

export type KeeperTickResult =
  | {
      readonly ran: false;
      readonly reason: "below-threshold";
      readonly newWills: number;
      readonly newNotes: number;
      readonly newEntries: number;
      readonly chroniclePath: string;
    }
  | {
      readonly ran: true;
      readonly reason: "wrote";
      readonly newWills: number;
      readonly newNotes: number;
      readonly newEntries: number;
      readonly chroniclePath: string;
      readonly pass: number;
      readonly asOf: string;
      readonly rebuilt: boolean;
      readonly sessionId: string;
      readonly sessionReused: boolean;
    };

/**
 * Repo-scope archivist. `tick` is what a scheduled task and `runDaemon` both call.
 * State (pass, session, watermark) lives beside the chronicle and is not injected
 * into briefs, so the chronicle bytes stay stable between passes.
 */
export class ArchivistKeeper extends Context.Service<
  ArchivistKeeper,
  {
    readonly tick: (input: ArchivistTickInput) => Effect.Effect<KeeperTickResult, KeeperPassError>;
  }
>()("@t3tools/keeper/archivist/ArchivistKeeper") {}

export const stateFileName = (scopeId: string): string => {
  const safe = scopeId.replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return `${safe}.state.json`;
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* KeeperSource;
  const summarizer = yield* KeeperSummarizer;

  const resolveInside = (root: string, relative: string) => {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relative);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
      return Effect.fail(new KeeperPathError({ path: relative }));
    }
    return Effect.succeed(resolved);
  };

  const writeString = Effect.fn("ArchivistKeeper.writeString")(
    function* (filePath: string, contents: string) {
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      yield* fs.writeFileString(temp, contents);
      yield* fs.rename(temp, filePath);
    },
    (effect, filePath) =>
      effect.pipe(Effect.mapError((cause) => new KeeperWriteError({ path: filePath, cause }))),
  );

  const readState = Effect.fn("ArchivistKeeper.readState")(function* (statePath: string) {
    const exists = yield* fs
      .exists(statePath)
      .pipe(Effect.mapError((cause) => new KeeperStateError({ path: statePath, cause })));
    if (!exists) return Option.none<KeeperState>();
    const text = yield* fs
      .readFileString(statePath)
      .pipe(Effect.mapError((cause) => new KeeperStateError({ path: statePath, cause })));
    return yield* decodeState(text).pipe(
      Effect.mapBoth({
        onFailure: (cause) => new KeeperStateError({ path: statePath, cause }),
        onSuccess: Option.some,
      }),
    );
  });

  const tick = Effect.fn("ArchivistKeeper.tick")(function* (
    input: ArchivistTickInput,
  ): Effect.fn.Return<KeeperTickResult, KeeperPassError> {
    const chroniclePath = yield* resolveInside(input.projectRoot, input.scope.output.path);
    const statePath = yield* resolveInside(
      input.projectRoot,
      path.join(".kin", "keeper", stateFileName(input.scope.id)),
    );
    const state = yield* readState(statePath);
    const previous = Option.getOrNull(state);

    // The watermark prefers the state file. A chronicle left behind without
    // state still anchors the count, and its body is never sent to the model.
    let sinceMillis = previous === null ? null : epochMillis(previous.asOf);
    const chronicleExists = yield* fs
      .exists(chroniclePath)
      .pipe(Effect.mapError((cause) => new KeeperWriteError({ path: chroniclePath, cause })));
    if (sinceMillis === null && chronicleExists) {
      const existing = yield* fs
        .readFileString(chroniclePath)
        .pipe(Effect.mapError((cause) => new KeeperWriteError({ path: chroniclePath, cause })));
      const asOf = parseAsOf(existing);
      sinceMillis = asOf === null ? null : epochMillis(asOf);
    }

    const entries = yield* source.entries({ scopeId: input.scope.id });
    const corpus = validEntries(entries);
    const counts = countNew(corpus, sinceMillis);
    if (!shouldRunPass(counts, input.scope.trigger)) {
      return {
        ran: false as const,
        reason: "below-threshold" as const,
        newWills: counts.wills,
        newNotes: counts.notes,
        newEntries: counts.entries,
        chroniclePath,
      };
    }

    const { pass, rebuilt } = passNumber(previous?.pass ?? null, input.scope.rebuildEvery);
    const session = planSession({
      scopeId: input.scope.id,
      pass,
      rebuilt,
      previousSessionId: previous?.sessionId ?? null,
      model: input.scope.model,
    });
    const asOf = DateTime.formatIso(DateTime.makeUnsafe(input.nowMillis));
    // Full raw corpus on every pass, including rebuilds. The previous chronicle
    // text is not an argument. Rebuilds additionally drop the provider session.
    const body = yield* summarizer.summarize({
      scopeId: input.scope.id,
      sessionId: session.sessionId,
      sessionReused: session.reused,
      rebuilt,
      model: input.scope.model,
      entries: corpus,
    });
    const chronicle = fitChronicle(formatChronicle(asOf, body), input.scope.output.maxBytes);
    const current = yield* fs.exists(chroniclePath).pipe(
      Effect.flatMap((exists) => (exists ? fs.readFileString(chroniclePath) : Effect.succeed(""))),
      Effect.mapError((cause) => new KeeperWriteError({ path: chroniclePath, cause })),
    );
    if (current !== chronicle) yield* writeString(chroniclePath, chronicle);
    yield* writeString(
      statePath,
      yield* encodeState({
        pass,
        asOf,
        sessionId: session.sessionId,
        rebuilt,
      }).pipe(Effect.mapError((cause) => new KeeperStateError({ path: statePath, cause }))),
    );

    return {
      ran: true as const,
      reason: "wrote" as const,
      newWills: counts.wills,
      newNotes: counts.notes,
      newEntries: counts.entries,
      chroniclePath,
      pass,
      asOf,
      rebuilt,
      sessionId: session.sessionId,
      sessionReused: session.reused,
    };
  });

  return ArchivistKeeper.of({ tick });
});

export const layer = Layer.effect(ArchivistKeeper, make);

export const deterministicSummarizerLayer = Layer.succeed(
  KeeperSummarizer,
  KeeperSummarizer.of({
    summarize: (input) => Effect.succeed(deterministicDigest(input.entries)),
  }),
);

/**
 * Effect-worker loop. The first tick runs immediately; later ticks wait
 * `interval` (default one hour). Failures are logged and the loop continues.
 * Scheduled tasks should call `ArchivistKeeper.tick` instead of starting a second loop.
 */
export const runDaemon = Effect.fn("ArchivistKeeper.runDaemon")(function* (input: {
  readonly scope: KeeperScope;
  readonly projectRoot: string;
  readonly interval?: Duration.Input;
  /**
   * Caps repeats for a caller that wants the loop to finish.
   * `0` runs a single tick. Omit it for the hourly loop.
   */
  readonly repeats?: number;
}) {
  const keeper = yield* ArchivistKeeper;
  const interval = input.interval ?? "1 hour";
  const schedule =
    input.repeats === undefined ? Schedule.spaced(interval) : Schedule.recurs(input.repeats);
  return yield* Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;
    return yield* keeper.tick({
      scope: input.scope,
      projectRoot: input.projectRoot,
      nowMillis,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("archivist pass failed", cause),
    ),
    Effect.repeat(schedule),
    Effect.forkScoped,
  );
});
