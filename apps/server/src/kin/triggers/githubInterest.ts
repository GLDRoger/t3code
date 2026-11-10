import type { KinGithubEvent, MemoryItemHead } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const InterestFields = Schema.Struct({
  pull_request: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.NullOr(Schema.String)),
      head: Schema.optional(
        Schema.Struct({
          ref: Schema.optional(Schema.String),
          repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
        }),
      ),
    }),
  ),
  issue: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  comment: Schema.optional(Schema.Struct({ body: Schema.optional(Schema.String) })),
  review: Schema.optional(Schema.Struct({ body: Schema.optional(Schema.NullOr(Schema.String)) })),
  check_suite: Schema.optional(
    Schema.Struct({
      pull_requests: Schema.optional(Schema.Array(Schema.Struct({ number: Schema.Int }))),
    }),
  ),
  workflow_run: Schema.optional(
    Schema.Struct({
      pull_requests: Schema.optional(Schema.Array(Schema.Struct({ number: Schema.Int }))),
    }),
  ),
});
const interestFields = Schema.decodeUnknownOption(InterestFields);

const linkedNumber = (url: string, repo: string) => {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#]|$)/i.exec(url);
  return match?.[1]?.toLowerCase() === repo.toLowerCase() ? Number(match[2]) : undefined;
};

export const relevant = (
  event: KinGithubEvent,
  botLogin: string,
  items: ReadonlyArray<MemoryItemHead>,
  workers: ReadonlyArray<{
    readonly url: string | null;
    readonly branch: string;
    readonly repositoryKey: string | null;
  }>,
) => {
  const fields = Option.getOrUndefined(interestFields(event.payload));
  const numbers = [
    event.number,
    ...(fields?.check_suite?.pull_requests ?? fields?.workflow_run?.pull_requests ?? []).map(
      (pr) => pr.number,
    ),
  ];
  if (
    workers.some((worker) => {
      const number = worker.url === null ? undefined : linkedNumber(worker.url, event.repo);
      return (
        (number !== undefined && numbers.includes(number)) ||
        (worker.repositoryKey?.toLowerCase() === `github.com/${event.repo.toLowerCase()}` &&
          fields?.pull_request?.head?.ref === worker.branch &&
          fields.pull_request.head.repo?.full_name.toLowerCase() === event.repo.toLowerCase())
      );
    })
  )
    return true;
  if (
    items.some(
      (item) =>
        item.orgId === event.orgId &&
        item.status === "open" &&
        item.invalid_at === null &&
        item.superseded_by === null &&
        ((item.on !== undefined &&
          numbers.includes(item.on.number) &&
          (item.on.repo === undefined ||
            item.on.repo.toLowerCase() === event.repo.toLowerCase())) ||
          item.links.some((url) => {
            const number = linkedNumber(url, event.repo);
            return number !== undefined && numbers.includes(number);
          })),
    )
  )
    return true;
  const texts = [
    fields?.pull_request?.title,
    fields?.pull_request?.body,
    fields?.issue?.title,
    fields?.issue?.body,
    fields?.comment?.body,
    fields?.review?.body,
  ];
  return texts.some((text) =>
    text
      ?.toLowerCase()
      .split(`@${botLogin.toLowerCase()}`)
      .slice(1)
      .some((tail) => !/^[a-z0-9_-]/i.test(tail)),
  );
};
