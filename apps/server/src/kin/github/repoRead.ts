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
import { type ApiAnswer, DIFF_CAP, pieceEnd, refusedFor } from "./GitHubWatch.ts";
import { isMemoryRepo, memoryRepos } from "./githubWatchStore.ts";
import { gitHubApp, type KinGitHubAppRead } from "./KinGitHubApp.ts";
import * as Reach from "../lead/Reach.ts";
import { boundIssue } from "./boundIssue.ts";
import { boundReview } from "./boundReview.ts";
import { askerOf, maySee } from "./reviewAsk.ts";

/**
 * `kin_github_read`: a folder, a file or a code search in a repo Kin's GitHub App is installed on,
 * read as the App with GET calls only, never as the owner's login. In a turn someone besides the
 * owner reads, a private repo opens only for the person asking, by the review ask's check (`maySee`).
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

// Words under eval: change them only with the triage cases.
const issueOnly = (repo: string) =>
  `This turn answers an issue in ${repo}, so it reads only ${repo}.`;
const NOTHING = "Nothing was read.";
export const READ_REFUSAL = {
  noApp: `Reading a repo needs Kin's GitHub App: the owner connects it in Settings, Connections, GitHub. ${NOTHING}`,
  memory: (repo: string) =>
    `${repo} is Kin's memory repo, which this tool doesn't read. ${NOTHING}`,
  unreached: (repo: string) =>
    `Kin's GitHub App isn't installed on ${repo}, so nothing was read. Only the owner can add it, in Settings, Connections, GitHub.`,
  moved: (repo: string) =>
    `GitHub says ${repo} has moved or been renamed, and Kin reads a repo only by its current name: ask for that one. ${NOTHING}`,
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
  ended: `This turn ended before the read finished. ${NOTHING}`,
  gone: (name: string) =>
    `${name} is no longer someone Kin reads for in this chat, so nothing was read. That changes only when an owner adds ${name} back in Settings, Team.`,
  restricted: (name: string) =>
    `${name} and this agent can't message each other, so Kin reads nothing for ${name}. The owner can lift that in Settings, Team. ${NOTHING}`,
  reviewOnly: (repo: string) =>
    `This turn reviews a pull request in ${repo}, so it reads only ${repo}. ${NOTHING}`,
  noPull: (repo: string, number: number) => `${repo} has no pull request #${number}. ${NOTHING}`,
  binary: (path: string, size: number) =>
    `${path} is a binary file (${size} bytes), not text, so Kin shows none of it.`,
  link: (path: string, target: string) =>
    `${path} is a link to ${target}, which Kin doesn't follow: read ${target} by its own path.`,
  tooLarge: (path: string) =>
    `GitHub's answer for ${path === "" ? "the repo's top" : path} is larger than Kin reads at once, so nothing was read: list a folder inside it, or read one file by its path.`,
  searchRef: `Search only reads the default branch, so nothing was searched: search without a ref, or read files at that ref by their paths.`,
  badSearch: `GitHub couldn't take those words as a code search, so nothing was searched: try plain words from the code.`,
  malformed: `That repo, path, ref or search has characters GitHub can't take, so nothing was read: ask again in plain text.`,
  tooLong: `That repo, path, ref or search is longer than Kin sends GitHub, so nothing was read: ask with a shorter one.`,
  other: (path: string, type: string) =>
    `${path} is a ${type}, not a file or folder of this repo, so Kin shows none of it.`,
} as const;
export const READ_NEXT = {
  listed: "Read a file with its path, or list a folder the same way.",
  end: "That is the end of the file.",
  more: (line: number, of: number) => `More follows: call again with line ${line} (of ${of}).`,
  past: (of: number) => `The file has ${of} lines; ask from a line inside it.`,
  tail: (line: number) =>
    `Line ${line} is longer than one answer holds, so the rest of that line can't be read here.`,
  partial: (read: number) =>
    `Kin reads at most a file's first 1 MB, so only its first ${read} lines are here; the rest of the file can't be read with this tool.`,
  found: "Read a file a match is in for the whole of it.",
  untrusted: (repo: string) =>
    `GitHub's search answered with code from outside ${repo} too, which Kin left out, so this search can't be trusted: list folders and read files instead.`,
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
  const next = to < of ? READ_NEXT.more(to + 1, of) : READ_NEXT.end;
  return page.length > DIFF_CAP
    ? {
        text: `${page.slice(0, pieceEnd(page, DIFF_CAP))}${LINE_CUT}`,
        lines: { from, to, of },
        next: `${READ_NEXT.tail(to)} ${next}`,
      }
    : { text: page, lines: { from, to, of }, next };
};

const Entry = Schema.Struct({
  type: Schema.String,
  path: Schema.String,
  size: Schema.optional(Schema.Number),
  download_url: Schema.optional(Schema.NullOr(Schema.String)),
});
/** GitHub lists a submodule as a file with nothing to download. */
const entryType = (entry: typeof Entry.Type) =>
  entry.type === "file" && entry.download_url === null ? "submodule" : entry.type;
const decodeRepo = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.Int, full_name: Schema.String, private: Schema.Boolean }),
);
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
        repository: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.Number) })),
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

/** Answers here are small JSON: anything cut is not one Kin reads. */
const META_LIMIT = 256 * 1024;
/** A folder's listing, or a file under 1 MB, base64 in JSON. */
const CONTENTS_LIMIT = 2 * 1024 * 1024;
/** The most of a larger file, raw, that one read takes in. */
const RAW_LIMIT = 1024 * 1024;
const parsed = (answer: KinGitHubAppRead): unknown => {
  if (answer.cut) return null;
  try {
    const text = new TextDecoder().decode(answer.bytes);
    return text.trim() === "" ? null : JSON.parse(text);
  } catch {
    return null;
  }
};
/** As the watch's own answers read, for `maySee` and `refusedFor`. */
const asApi = (answer: KinGitHubAppRead): ApiAnswer => ({
  status: answer.status,
  headers: answer.headers,
  body: parsed(answer),
  text: "",
  ...(answer.cut ? { truncated: true as const } : {}),
});
const moved = (status: number) => status >= 300 && status < 400;

/**
 * The provider query: each word quoted, so nothing in it is read as a qualifier (`repo:`, `OR`,
 * a leading `-`) while `foo:bar` and `Promise<void>` stay words; the repo's scope is Kin's alone.
 */
const searchQuery = (words: string, repo: string) =>
  `${words
    .split(" ")
    .map((word) => word.replace(/["\\]/g, ""))
    .filter((word) => word !== "")
    .map((word) => `"${word}"`)
    .join(" ")} repo:${repo}`;

/** Half of a UTF-16 pair with no other half: no URL or JSON GitHub takes can carry it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const refuse = (
  message: string,
  reason: "not_allowed" | "not_found" | "unavailable" = "not_allowed",
) => Effect.fail(new KinChatError({ reason, message }));

export const readRepo = Effect.fn("KinGitHubRepoRead.read")(function* (
  lead: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
  input: typeof ReadInput.Type,
) {
  if (!(yield* toolAdmitted(lead, "kin_github_read", input))) return yield* refuse(SHARED_REFUSAL);
  const given = [
    [input.repo, 200],
    [input.path, 1_000],
    [input.ref, 250],
    [input.search, 256],
  ] as const;
  if (given.some(([value]) => value !== undefined && LONE_SURROGATE.test(value)))
    return yield* refuse(READ_REFUSAL.malformed);
  if (given.some(([value, most]) => value !== undefined && value.length > most))
    return yield* refuse(READ_REFUSAL.tooLong);
  const searching = input.search !== undefined && input.search.trim() !== "";
  if (searching && input.ref !== undefined && input.ref.trim() !== "")
    return yield* refuse(READ_REFUSAL.searchRef);
  const named = input.repo.trim();
  const issue = yield* boundIssue(lead);
  if (issue !== undefined && issue.repo.toLowerCase() !== named.toLowerCase())
    return yield* refuse(issueOnly(issue.repo));
  const app = Option.getOrUndefined(yield* gitHubApp);
  if (app?.reader === undefined || (yield* app.state())._tag !== "ok")
    return yield* refuse(READ_REFUSAL.noApp);
  if (yield* isMemoryRepo(named)) return yield* refuse(READ_REFUSAL.memory(named));
  // A review someone asked for reads its pull request's repo, and no other, before it posts.
  const review = yield* boundReview(lead);
  if (review !== undefined && review.repo.toLowerCase() !== named.toLowerCase())
    return yield* refuse(READ_REFUSAL.reviewOnly(review.repo));
  const segments = (input.path ?? "").split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return yield* refuse(READ_REFUSAL.path);
  const path = segments.join("/");
  const reader = yield* app.reader(named);
  if (reader === undefined) return yield* refuse(READ_REFUSAL.unreached(named));

  const get = (target: string, headers?: Record<string, string>, limit = META_LIMIT) =>
    reader
      .get(target, { limit, ...(headers?.Accept === undefined ? {} : { accept: headers.Accept }) })
      .pipe(Effect.map(asApi));
  const failed = Effect.fn("KinGitHubRepoRead.failed")(function* (answer: ApiAnswer) {
    if (moved(answer.status)) return yield* refuse(READ_REFUSAL.moved(named));
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

  // The repo as the App sees it now: a repo taken off the App is gone at once, whatever the
  // owner's own login sees, and it is held by its id from here on.
  const about = yield* get(`repos/${named}`);
  if (about.status === 404) return yield* refuse(READ_REFUSAL.unreached(named));
  const found = about.status === 200 ? decodeRepo(about.body) : Option.none();
  if (Option.isNone(found)) return yield* failed(about);
  if (found.value.full_name.toLowerCase() !== named.toLowerCase())
    return yield* refuse(READ_REFUSAL.moved(named));
  const repo = found.value.full_name;
  const repoId = found.value.id;
  // Kin's memory repo by its id too, under whatever name it is asked for.
  for (const memory of yield* memoryRepos) {
    const own = yield* app.reader(memory);
    const id =
      own === undefined
        ? Option.none()
        : decodeRepo(parsed(yield* own.get(`repos/${memory}`, { limit: META_LIMIT })));
    if (Option.isSome(id) && id.value.id === repoId)
      return yield* refuse(READ_REFUSAL.memory(named));
  }

  // A turn someone besides the owner reads opens a private repo only for its one asker.
  const shared = (yield* effectiveAudience(lead)) !== "owner_only";
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
    WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`;
  const triageOutside = issue?.outside === true;
  const first = shared && !triageOutside ? yield* askerOf(lead) : undefined;
  const readFor = first?.name;
  /**
   * Whether this turn may still be given the repo: run once before reading and again just before
   * the text is released, so access lost mid-read releases nothing.
   */
  const entitled = Effect.fn("KinGitHubRepoRead.entitled")(function* () {
    const [running] = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${lead.orgId}
      AND wakeup_id = ${lead.wakeupId} AND status = 'running'`;
    if (running === undefined) return yield* refuse(READ_REFUSAL.ended);
    const asker = triageOutside ? undefined : yield* askerOf(lead);
    if (first !== undefined) {
      if (asker?.personId !== first.personId) return yield* refuse(READ_REFUSAL.gone(first.name));
      if (
        (yield* Reach.mayReach(
          lead.orgId,
          Reach.person(asker.personId),
          Reach.agent(lead.agentId),
        )) !== "allowed"
      )
        return yield* refuse(READ_REFUSAL.restricted(asker.name));
    }
    const now = yield* get(`repos/${repo}`);
    if (now.status === 404) return yield* refuse(READ_REFUSAL.unreached(repo));
    const still = now.status === 200 ? decodeRepo(now.body) : Option.none();
    if (Option.isNone(still)) return yield* failed(now);
    if (still.value.id !== repoId) return yield* refuse(READ_REFUSAL.moved(repo));
    if (triageOutside) return;
    const himself =
      asker !== undefined && isOwnerHimself({ personId: agent?.owner ?? "" }, asker.personId);
    const may = yield* maySee(get, repo, { himself, login: asker?.login ?? null });
    if (typeof may !== "string") return yield* failed(may);
    if (may === "no")
      return yield* refuse(
        asker === undefined
          ? READ_REFUSAL.notHere(repo)
          : asker.login === null
            ? READ_REFUSAL.noLogin(repo, asker.name)
            : READ_REFUSAL.notCollaborator(repo, asker.name),
      );
  });
  const checkEntitlement = shared || triageOutside;
  if (checkEntitlement) yield* entitled();
  // GitHub text is outside content for the rest of the turn, as a pull request's diff is; in a
  // shared turn, the turn then only reads and answers there (`REPO_READ_TOOLS`).
  const shown = <A>(result: A) =>
    (checkEntitlement ? entitled() : Effect.void).pipe(
      Effect.andThen(
        markOutside(
          lead,
          "github",
          shared
            ? [{ k: "repo", name: repo, ...(readFor === undefined ? {} : { for: readFor }) }]
            : undefined,
        ),
      ),
      Effect.as(result),
    );

  if (searching) {
    const words = (input.search ?? "").replace(/\s+/g, " ").trim();
    const answer = yield* get(
      `search/code?q=${encodeURIComponent(searchQuery(words, repo))}&per_page=${SEARCH_PAGE}`,
      { Accept: "application/vnd.github.text-match+json" },
    );
    // GitHub's 422 is words it can't take as a search; a repo it hasn't indexed finds nothing.
    if (answer.status === 422) return yield* refuse(READ_REFUSAL.badSearch);
    const found = answer.status === 200 ? decodeSearch(answer.body) : Option.none();
    if (Option.isNone(found)) return yield* failed(answer);
    // Only the admitted repo's own hits, by its id: whatever else GitHub sent stays unread.
    const own = found.value.items.filter((item) => item.repository?.id === repoId);
    const matches = own.map((item) => ({
      path: item.path,
      fragments: (item.text_matches ?? []).flatMap((match) =>
        match.fragment === undefined ? [] : [match.fragment],
      ),
    }));
    return yield* shown({
      repo,
      ref: DEFAULT_REF,
      matches,
      next:
        own.length < found.value.items.length
          ? READ_NEXT.untrusted(repo)
          : matches.length === 0
            ? READ_NEXT.none(repo, words)
            : READ_NEXT.found,
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
  const answer = yield* get(contents, undefined, CONTENTS_LIMIT);
  // A 404 is a missing path only while the App still reaches the repo.
  if (answer.status === 404)
    return yield* (yield* get(`repos/${repo}`)).status === 404
      ? refuse(READ_REFUSAL.unreached(repo))
      : refuse(READ_REFUSAL.missing(repo, path, at), "not_found");
  if (answer.status !== 200) return yield* failed(answer);
  if (answer.truncated === true) return yield* refuse(READ_REFUSAL.tooLarge(path), "unavailable");
  const listed = decodeEntries(answer.body);
  if (Option.isSome(listed))
    return yield* shown({
      repo,
      ref: at,
      path,
      entries: listed.value.map((one) => ({
        path: one.path,
        type: entryType(one),
        ...(entryType(one) === "file" && one.size !== undefined
          ? { size: Math.round(one.size) }
          : {}),
      })),
      next: READ_NEXT.listed,
    });
  const file = decodeFile(answer.body);
  if (Option.isNone(file)) return yield* failed(answer);
  if (file.value.type !== "file")
    return { repo, ref: at, path, next: READ_REFUSAL.other(path, file.value.type) };
  // GitHub answers a symlink to a file with that file: named, and not followed.
  if (file.value.path !== path)
    return { repo, ref: at, path, next: READ_REFUSAL.link(path, file.value.path) };
  const size = Math.round(file.value.size);
  let text: string | undefined;
  let partial = false;
  if (file.value.encoding === "base64") {
    text = textOf(Buffer.from(file.value.content ?? "", "base64"));
  } else {
    // GitHub sends a file over 1 MB only raw.
    const raw = yield* reader.get(contents, {
      accept: "application/vnd.github.raw",
      limit: RAW_LIMIT,
    });
    if (raw.status !== 200) return yield* failed(asApi(raw));
    partial = raw.cut;
    // A cut answer's last line may be cut too: only whole lines are shown.
    text = textOf(partial ? raw.bytes.subarray(0, raw.bytes.lastIndexOf(10) + 1) : raw.bytes);
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
