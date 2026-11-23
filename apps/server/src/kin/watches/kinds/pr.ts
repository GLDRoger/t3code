import { KinAgentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { githubRef } from "../../triggers/deferralGithub.ts";
import { KinWatchdogGithubReader } from "../../triggers/watchdogs.ts";
import type { Found, WatchKind } from "./kind.ts";
import { openTaskCards } from "./taskOut.ts";

const READ_TIMEOUT = "30 seconds";
const decodeLinks = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ url: Schema.String }))),
);

/**
 * A pull request a delegated task opened: closed when GitHub says it merged or closed. Read through
 * the watchdogs' GitHub reader, as the owner's login; with no reader none is found.
 */
export const pr: WatchKind = {
  kind: "pr",
  source: "task",
  reach: "work",
  checksWork: true,
  find: Effect.fn("KinWatch.pr.find")(function* (ctx) {
    if ((yield* KinWatchdogGithubReader) === null) return [];
    const links = new Map<string, Found>();
    for (const card of yield* openTaskCards(ctx.orgId)) {
      const agent =
        card.agentId !== null && ctx.liveAgents.has(card.agentId) ? card.agentId : ctx.chief;
      for (const { url } of Option.getOrElse(decodeLinks(card.pullRequests ?? "[]"), () => [])) {
        const ref = githubRef(url);
        const key = ref === undefined ? undefined : `${ref.repo.toLowerCase()}#${ref.number}`;
        if (ref === undefined || key === undefined || links.has(key)) continue;
        links.set(key, {
          sourceKey: key,
          recordId: null,
          subjectRef: url,
          about: `PR #${ref.number} for ${card.title}`.slice(0, 200),
          closesWhen: "it is merged or closed",
          agentId: agent === undefined ? null : KinAgentId.make(agent),
          why: "a task Kin handed out opened it",
        });
      }
    }
    return [...links.values()];
  }),
  check: Effect.fn("KinWatch.pr.check")(function* (ctx, watch) {
    const reader = yield* KinWatchdogGithubReader;
    const ref = watch.subjectRef === null ? undefined : githubRef(watch.subjectRef);
    if (ref === undefined) return { _tag: "closed", how: "no longer applies", evidence: [] };
    if (reader === null) return { _tag: "cant_tell", line: "GitHub isn't connected" };
    const read = yield* reader.readRepo(ctx.orgId, ref.repo, [ref.number]).pipe(
      Effect.timeoutOrElse({
        duration: READ_TIMEOUT,
        orElse: () => Effect.fail("timeout" as const),
      }),
      Effect.result,
    );
    if (Result.isFailure(read)) return { _tag: "cant_tell", line: "GitHub didn't answer" };
    const state = read.success.find((one) => one.number === ref.number);
    const evidence = [{ kind: "pr", id: watch.subjectRef! }];
    if (state === undefined) return { _tag: "cant_tell", line: "GitHub doesn't show it" };
    if (state.state === "merged")
      return { _tag: "closed", how: `PR #${ref.number} was merged`, evidence };
    if (state.state === "closed")
      return { _tag: "closed", how: `PR #${ref.number} was closed without merging`, evidence };
    return { _tag: "nothing_new", evidence };
  }),
};
