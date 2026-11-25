import { type KinAgentId, KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { effectiveAudience, SHARED_REFUSAL } from "../lead/Audience.ts";
import { markOutside } from "../lead/OutsideContent.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { isOwnerHimself } from "../people/KinAccess.ts";
import { type ApiAnswer, DIFF_CAP, KinGitHubApi, pieceEnd, refusedFor } from "./GitHubWatch.ts";
import { isMemoryRepo, repoList } from "./githubWatchStore.ts";
import { askerOf, maySee } from "./reviewAsk.ts";

/**
 * `kin_github_read`: a folder, a file or a code search in one of the company's repos, read through
 * Kin's GitHub connection with GET calls only. In a turn someone besides the owner reads, a
 * private repo opens only for the person asking, by the review ask's own check (`maySee`).
 */

export const ReadInput = Schema.Struct({
  repo: Schema.String.annotate({ description: "owner/name." }),
  path: Schema.optional(
    Schema.String.annotate({
      description:
        "A folder to list or a file to read, from the repo's top; leave out for the top.",
    }),
  ),
  search: Schema.optional(
    Schema.String.annotate({
      description: "Words to find in the repo's code, in place of a path.",
    }),
  ),
  ref: Schema.optional(
    Schema.String.annotate({
      description:
        "A branch, tag or commit, or pull/<number> for a pull request's head; the default branch when left out.",
    }),
  ),
  line: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description: "The line to read a long file on from, as the last answer names it.",
    }),
  ),
});
export const ReadResult = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  path: Schema.optional(Schema.String),
  entries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        type: Schema.String,
        size: Schema.optional(Schema.Int),
      }),
    ),
  ),
  text: Schema.optional(Schema.String),
  lines: Schema.optional(Schema.Struct({ from: Schema.Int, to: Schema.Int, of: Schema.Int })),
  matches: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, fragments: Schema.Array(Schema.String) })),
  ),
  next: Schema.String,
});

const NOTHING = "Nothing was read.";
export const READ_REFUSAL = {
  disconnected: `GitHub isn't connected to Kin. The owner or a co-owner connects it in Settings, Connections, GitHub. ${NOTHING}`,
  memory: (repo: string) =>
    `${repo} is Kin's memory repo, which this tool doesn't read. ${NOTHING}`,
  unreached: (repo: string) =>
    `${repo} isn't a repo Kin's GitHub connection reaches, so nothing was read. Only the owner can add it, in Settings, Connections.`,
  notHere: (repo: string) =>
    `${repo} is private, and Kin opens a private repo only in a person's own chat with you, for that person. ${NOTHING} Tell them that in one line.`,
  noLogin: (repo: string, name: string) =>
    `${repo} is private, and Kin has no GitHub username on file for ${name}, so it can't open it for them. That changes when they add theirs under You → GitHub username and GitHub lets them see ${repo}. ${NOTHING} Tell them that in one line; send the owner nothing unless they ask you to get them access.`,
  notCollaborator: (repo: string, name: string) =>
    `${repo} is private and GitHub doesn't let ${name} see it, so Kin can't open it for them. That changes when the owner gives them access to ${repo} on GitHub. ${NOTHING} Tell them that in one line; send the owner nothing unless they ask you to get them access.`,
  path: `A path names folders and a file inside the repo, such as src/alerts.ts, with no "." or ".." in it. ${NOTHING}`,
  refused: (minutes: number | undefined) =>
    `GitHub refused Kin's requests for now${minutes === undefined ? "" : `; it takes them again in about ${minutes} minutes`}: tell them so, and to ask again then. ${NOTHING}`,
  unreachable: `Kin couldn't reach GitHub just now. ${NOTHING}`,
  missing: (repo: string, path: string, ref: string) =>
    `${repo} has nothing at ${path === "" ? "its top" : path} on ${ref}: list the folder above it, or check the ref. ${NOTHING}`,
  noPull: (repo: string, number: number) => `${repo} has no pull request #${number}. ${NOTHING}`,
  binary: (path: string, size: number) =>
    `${path} is a binary file (${size} bytes), not text, so Kin shows none of it.`,
  other: (path: string, type: string) =>
    `${path} is a ${type}, not a file or folder of this repo, so Kin shows none of it.`,
} as const;
export const READ_NEXT = {
  listed: "Read a file with its path, or list a folder the same way.",
  end: "That is the end of the file.",
  more: (line: number, of: number) => `More follows: call again with line ${line} (of ${of}).`,
  past: (of: number) => `The file has ${of} lines; ask from a line inside it.`,
  partial: (read: number) =>
    `Kin could read only its first ${read} lines: GitHub's answer stopped there, so the rest of the file stays unread.`,
  found: "Read a file a match is in for the whole of it.",
  defaultOnly: " Code search reads only the default branch.",
  none: (repo: string, words: string) =>
    `GitHub's code search found nothing for "${words}" in ${repo}. It searches only the default branch, and only once GitHub has indexed the repo, which it may not have yet: list folders and read files instead.`,
} as const;
const DEFAULT_REF = "the default branch";
const SEARCH_PAGE = 20;
/** A long line cut at a page's edge. */
const LINE_CUT = "…[this line goes on past what one answer holds]";

/** One page of a file's text from `from`: whole when it fits one answer, else whole lines. */
export const filePage = (text: string, from = 1) => {
  const all = text.split("\n");
  const of = text.endsWith("\n") ? all.length - 1 : all.length;
  if (from <= 1 && text.length <= DIFF_CAP)
    return { text, lines: { from: 1, to: of, of }, next: READ_NEXT.end };
  if (from > of) return { text: "", lines: { from, to: of, of }, next: READ_NEXT.past(of) };
  let to = from - 1;
  let size = 0;
  while (to < of && (to === from - 1 || size + all[to]!.length + 1 <= DIFF_CAP)) {
    size += all[to]!.length + 1;
    to += 1;
  }
  const page = all.slice(from - 1, to).join("\n");
  return {
    text: page.length > DIFF_CAP ? `${page.slice(0, pieceEnd(page, DIFF_CAP))}${LINE_CUT}` : page,
    lines: { from, to, of },
    next: to < of ? READ_NEXT.more(to + 1, of) : READ_NEXT.end,
  };
};

const Entry = Schema.Struct({
  type: Schema.String,
  path: Schema.String,
  size: Schema.optional(Schema.Number),
});
const decodeEntries = Schema.decodeUnknownOption(Schema.Array(Entry));
const decodeFile = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    path: Schema.String,
    size: Schema.Number,
    encoding: Schema.optional(Schema.String),
    content: Schema.optional(Schema.String),
  }),
);
const decodePull = Schema.decodeUnknownOption(
  Schema.Struct({ head: Schema.Struct({ sha: Schema.String }) }),
);
const decodeSearch = Schema.decodeUnknownOption(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        text_matches: Schema.optional(
          Schema.Array(Schema.Struct({ fragment: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  }),
);

/** The text of a file's bytes, or undefined for bytes that aren't UTF-8 text. */
const textOf = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const refuse = (
  message: string,
  reason: "not_allowed" | "not_found" | "unavailable" = "not_allowed",
) => Effect.fail(new KinChatError({ reason, message }));

export const readRepo = Effect.fn("KinGitHubRepoRead.read")(function* (
  lead: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
  input: typeof ReadInput.Type,
) {
  if (!(yield* toolAdmitted(lead, "kin_github_read", input))) return yield* refuse(SHARED_REFUSAL);
  const api = yield* KinGitHubApi;
  const account = yield* api.connected();
  if (account === null) return yield* refuse(READ_REFUSAL.disconnected);
  const named = input.repo.trim();
  if (yield* isMemoryRepo(named)) return yield* refuse(READ_REFUSAL.memory(named));
  const entry = (yield* repoList(lead.orgId)).find(
    (one) => one.repo.toLowerCase() === named.toLowerCase(),
  );
  if (entry === undefined) return yield* refuse(READ_REFUSAL.unreached(named));
  const repo = entry.repo;
  const segments = (input.path ?? "").split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return yield* refuse(READ_REFUSAL.path);
  const path = segments.join("/");

  const get = (target: string, headers?: Record<string, string>) =>
    api.call({ method: "GET", path: target, ...(headers === undefined ? {} : { headers }) });
  const failed = Effect.fn("KinGitHubRepoRead.failed")(function* (answer: ApiAnswer) {
    const refused = refusedFor(answer, yield* Clock.currentTimeMillis);
    if (refused === undefined) return yield* refuse(READ_REFUSAL.unreachable, "unavailable");
    const now = yield* Clock.currentTimeMillis;
    return yield* refuse(
      READ_REFUSAL.refused(
        refused.until === undefined
          ? undefined
          : Math.max(1, Math.ceil((refused.until - now) / 60_000)),
      ),
      "unavailable",
    );
  });

  // A turn someone besides the owner reads opens a private repo only for its one asker.
  if ((yield* effectiveAudience(lead)) !== "owner_only") {
    const asker = yield* askerOf(lead);
    const sql = yield* SqlClient.SqlClient;
    const [agent] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
      WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`;
    const himself =
      asker !== undefined && isOwnerHimself({ personId: agent?.owner ?? "" }, asker.personId);
    const may = yield* maySee(get, repo, {
      himself,
      login: asker === undefined ? null : (asker.login ?? (himself ? account.login : null)),
    });
    if (typeof may !== "string") return yield* failed(may);
    if (may === "no")
      return yield* refuse(
        asker === undefined
          ? READ_REFUSAL.notHere(repo)
          : asker.login === null
            ? READ_REFUSAL.noLogin(repo, asker.name)
            : READ_REFUSAL.notCollaborator(repo, asker.name),
      );
  }
  // GitHub text is outside content for the rest of the turn, as a pull request's diff is.
  const shown = <A>(result: A) => markOutside(lead, "github").pipe(Effect.as(result));

  if (input.search !== undefined && input.search.trim() !== "") {
    const words = input.search.replace(/\s+/g, " ").trim();
    const answer = yield* get(
      `search/code?q=${encodeURIComponent(`${words} repo:${repo}`)}&per_page=${SEARCH_PAGE}`,
      { Accept: "application/vnd.github.text-match+json" },
    );
    if (answer.status === 422)
      return yield* shown({
        repo,
        ref: DEFAULT_REF,
        matches: [],
        next: READ_NEXT.none(repo, words),
      });
    const found = answer.status === 200 ? decodeSearch(answer.body) : Option.none();
    if (Option.isNone(found)) return yield* failed(answer);
    const matches = found.value.items.map((item) => ({
      path: item.path,
      fragments: (item.text_matches ?? []).flatMap((match) =>
        match.fragment === undefined ? [] : [match.fragment],
      ),
    }));
    const ref = input.ref === undefined ? "" : READ_NEXT.defaultOnly;
    return yield* shown({
      repo,
      ref: DEFAULT_REF,
      matches,
      next: (matches.length === 0 ? READ_NEXT.none(repo, words) : READ_NEXT.found) + ref,
    });
  }

  const at = input.ref?.trim() || DEFAULT_REF;
  let ref = at === DEFAULT_REF ? undefined : at;
  const pull = ref === undefined ? null : /^(?:pull\/|#)(\d+)$/.exec(ref);
  if (pull !== null) {
    const answer = yield* get(`repos/${repo}/pulls/${pull[1]}`);
    if (answer.status === 404)
      return yield* refuse(READ_REFUSAL.noPull(repo, Number(pull[1])), "not_found");
    const read = answer.status === 200 ? decodePull(answer.body) : Option.none();
    if (Option.isNone(read)) return yield* failed(answer);
    ref = read.value.head.sha;
  }
  const contents = `repos/${repo}/contents${path === "" ? "" : `/${segments.map(encodeURIComponent).join("/")}`}${ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`}`;
  const answer = yield* get(contents);
  if (answer.status === 404)
    return yield* refuse(READ_REFUSAL.missing(repo, path, at), "not_found");
  if (answer.status !== 200) return yield* failed(answer);
  const listed = decodeEntries(answer.body);
  if (Option.isSome(listed))
    return yield* shown({
      repo,
      ref: at,
      path,
      entries: listed.value.map((one) => ({
        path: one.path,
        type: one.type,
        ...(one.type === "file" && one.size !== undefined ? { size: Math.round(one.size) } : {}),
      })),
      next: READ_NEXT.listed,
    });
  const file = decodeFile(answer.body);
  if (Option.isNone(file)) return yield* failed(answer);
  if (file.value.type !== "file")
    return { repo, ref: at, path, next: READ_REFUSAL.other(path, file.value.type) };
  const size = Math.round(file.value.size);
  let text: string | undefined;
  let partial = false;
  if (file.value.encoding === "base64") {
    text = textOf(Buffer.from(file.value.content ?? "", "base64"));
  } else {
    // GitHub sends a file over 1 MB only raw.
    const raw = yield* get(contents, { Accept: "application/vnd.github.raw" });
    if (raw.status !== 200) return yield* failed(raw);
    partial = raw.truncated === true;
    // A cut answer's last line may be cut too: only whole lines are shown.
    const whole = partial ? raw.text.slice(0, raw.text.lastIndexOf("\n") + 1) : raw.text;
    text = whole.includes("\u0000") ? undefined : whole;
  }
  if (text === undefined) return { repo, ref: at, path, next: READ_REFUSAL.binary(path, size) };
  const page = filePage(text, input.line);
  return yield* shown({
    repo,
    ref: at,
    path,
    text: page.text,
    lines: page.lines,
    next: !partial
      ? page.next
      : page.lines.to < page.lines.of
        ? `${page.next} ${READ_NEXT.partial(page.lines.of)}`
        : READ_NEXT.partial(page.lines.of),
  });
});
