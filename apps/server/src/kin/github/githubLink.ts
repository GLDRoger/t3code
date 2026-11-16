import { KinChatError, KinRecordKey, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { TurnEvent } from "../lead/eventIds.ts";
import { KinRecords } from "../work/KinRecords.ts";
import type { Lead } from "../work/leadWork.ts";
import { writerFor } from "../work/leadWork.ts";

const githubItem = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/i;

const ReviewComment = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
});
export const ReviewInput = Schema.Struct({
  repo: Schema.String.annotate({ description: "owner/name." }),
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(30_000))),
  event: Schema.optional(Schema.Literals(["COMMENT", "REQUEST_CHANGES"])),
  comments: Schema.optional(Schema.Array(ReviewComment).check(Schema.isMaxLength(50))),
  sourceEventId: TurnEvent,
});
export const ReviewResult = Schema.Struct({
  status: Schema.Literal("posted"),
  url: Schema.optional(Schema.String),
  next: Schema.String,
});
export const LinkInput = Schema.Struct({
  entry: KinRecordKey,
  url: TrimmedNonEmptyString.annotate({ description: "A GitHub issue or pull request URL." }),
  sourceEventId: TurnEvent,
});
export const LinkResult = Schema.Struct({ entry: Schema.String, linked: Schema.String });

/** Links a GitHub issue or PR to a Work entry; the merge or close then closes the entry. */
export const linkGithubItem = Effect.fn("KinGitHubLink.link")(function* (
  lead: Lead,
  input: typeof LinkInput.Type,
) {
  const match = githubItem.exec(input.url.trim());
  if (match === null)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That isn't a GitHub issue or pull request URL.",
    });
  const issue = match[2]!.toLowerCase() === "issues";
  const number = Number(match[3]);
  const url = `https://github.com/${match[1]!}/${issue ? "issues" : "pull"}/${number}`;
  const sql = yield* SqlClient.SqlClient;
  const [entry] = yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId",
      key FROM kin_records WHERE org_id = ${lead.orgId} AND key = ${input.entry}
    ORDER BY record_id`.pipe(Effect.orDie);
  if (entry === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
  const writer = yield* writerFor(lead).pipe(Effect.orDie);
  yield* (yield* KinRecords).link(lead.orgId, writer, entry.recordId, {
    kind: issue ? "url" : "pull_request",
    target: url,
    relation: "relates",
    label: issue ? `Issue #${number}` : `PR #${number}`,
  });
  return { entry: entry.key, linked: url };
});
