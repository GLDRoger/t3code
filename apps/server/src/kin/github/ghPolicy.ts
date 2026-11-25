// @effect-diagnostics globalJsonInEffect:off - JSON string literals embed paths safely into generated JavaScript.
import { signed } from "./agentMark.ts";
import { GRAPHQL_READER } from "./ghPolicyGraphql.ts";

/**
 * The program behind a Kin agent's `gh` (`ghSign.ts` runs it with the server's own Node). It reads
 * the whole request each command would send and lets a GitHub write through only when it is one
 * Kin agents make (comments, reviews that aren't approvals, issues and PRs, labels, reactions,
 * re-runs), signed, recorded, and sent exactly as read. Reads pass. Anything else is refused.
 */

export interface GhPolicyPaths {
  /** The pinned gh this runs. */
  readonly realGh: string;
  /** The `gh-app` folder, where `postsFile` lives. */
  readonly app: string;
  /** Where each text an agent sends is recorded, as a hash, for the watch (`agentMark.ts`). */
  readonly postsFile: string;
}

/** What `gh` 2.103.3 accepts, by group and command; aliases included. */
const READ = "read";
const COMMANDS: Record<string, Record<string, string>> = {
  "agent-task": { list: READ, ls: READ, view: READ },
  alias: { list: READ, ls: READ, set: "login", delete: "login", import: "login" },
  attestation: { download: READ, verify: READ, "trusted-root": READ },
  auth: { status: READ },
  cache: { list: READ, ls: READ },
  codespace: { list: READ, ls: READ, view: READ, logs: READ },
  config: { get: READ, list: READ, ls: READ, "clear-cache": READ, set: "login" },
  discussion: { list: READ, ls: READ, view: READ },
  extension: { list: READ, ls: READ, search: READ, browse: READ },
  gist: { list: READ, ls: READ, view: READ, clone: READ },
  "gpg-key": { list: READ, ls: READ, add: "settings", delete: "settings" },
  issue: {
    list: READ,
    ls: READ,
    view: READ,
    status: READ,
    create: "issue create",
    new: "issue create",
    comment: "issue comment",
    edit: "issue edit",
    close: "issue close",
    reopen: "issue reopen",
    delete: "delete",
    transfer: "settings",
  },
  label: { list: READ, ls: READ, create: "label create", edit: "label edit", delete: "delete" },
  org: { list: READ, ls: READ },
  pr: {
    list: READ,
    ls: READ,
    view: READ,
    diff: READ,
    checks: READ,
    status: READ,
    checkout: READ,
    co: READ,
    create: "pr create",
    new: "pr create",
    comment: "pr comment",
    edit: "pr edit",
    review: "pr review",
    close: "pr close",
    reopen: "pr reopen",
    ready: "pr ready",
    merge: "merge",
  },
  preview: { prompter: READ },
  project: { list: READ, ls: READ, view: READ, "field-list": READ, "item-list": READ },
  release: {
    list: READ,
    ls: READ,
    view: READ,
    download: READ,
    verify: READ,
    "verify-asset": READ,
    delete: "delete",
    "delete-asset": "delete",
  },
  repo: {
    view: READ,
    list: READ,
    ls: READ,
    clone: READ,
    "read-dir": READ,
    "read-file": READ,
    "set-default": READ,
    gitignore: READ,
    license: READ,
    edit: "settings",
    rename: "settings",
    archive: "settings",
    unarchive: "settings",
    "deploy-key": "settings",
    autolink: "settings",
    delete: "delete",
  },
  ruleset: { list: READ, ls: READ, view: READ, check: READ },
  run: { list: READ, ls: READ, view: READ, watch: READ, download: READ, rerun: "run rerun" },
  search: { code: READ, commits: READ, issues: READ, prs: READ, repos: READ },
  secret: { list: READ, ls: READ, set: "settings", delete: "settings", remove: "settings" },
  skill: { list: READ, ls: READ, search: READ, preview: READ, show: READ },
  "ssh-key": { list: READ, ls: READ, add: "settings", delete: "settings" },
  variable: {
    list: READ,
    ls: READ,
    get: READ,
    set: "settings",
    delete: "settings",
    remove: "settings",
  },
  workflow: { list: READ, ls: READ, view: READ },
};
const GROUP_ALIASES: Record<string, string> = {
  "agent-tasks": "agent-task",
  agent: "agent-task",
  agents: "agent-task",
  at: "attestation",
  cs: "codespace",
  ext: "extension",
  extensions: "extension",
  rs: "ruleset",
  skills: "skill",
};
/** Commands with no subcommand that only read or print. */
const READ_LEAVES = ["browse", "status", "completion", "licenses", "help", "version"];
/** Subcommands whose own subcommands only read (`repo gitignore list`); writes among them refuse. */
const NESTED_READS: Record<string, ReadonlyArray<string>> = {
  "issue artifact": ["list", "ls", "view", "download"],
  "repo autolink": ["list", "ls", "view"],
  "repo deploy-key": ["list", "ls"],
};

/**
 * Flags of each write Kin lets through, as gh 2.103.3 defines them: `long:s` has shorthand `s`,
 * a trailing `=` takes a value. `-R/--repo` and `--help` come with every one.
 */
const WRITE_FLAGS: Record<string, string> = {
  "pr create":
    "assignee:a= attach= base:B= body:b= body-file:F= draft:d dry-run editor:e fill:f fill-first fill-verbose head:H= label:l= milestone:m= no-maintainer-edit project:p= recover= reviewer:r= template:T= title:t= web:w",
  "issue create":
    "assignee:a= attach= blocked-by= blocking= body:b= body-file:F= editor:e label:l= milestone:m= parent= project:p= recover= template:T= title:t= type= web:w",
  "pr comment":
    "attach= body:b= body-file:F= create-if-none delete-last edit-last editor:e web:w yes",
  "issue comment":
    "attach= body:b= body-file:F= create-if-none delete-last edit-last editor:e web:w yes",
  "pr edit":
    "add-assignee= add-label= add-project= add-reviewer= attach= base:B= body:b= body-file:F= milestone:m= remove-assignee= remove-label= remove-milestone remove-project= remove-reviewer= title:t=",
  "issue edit":
    "add-assignee= add-blocked-by= add-blocking= add-label= add-project= add-sub-issue= attach= body:b= body-file:F= milestone:m= parent= remove-assignee= remove-blocked-by= remove-blocking= remove-label= remove-milestone remove-parent remove-project= remove-sub-issue= remove-type title:t= type=",
  "pr review": "approve:a body:b= body-file:F= comment:c request-changes:r",
  "pr close": "comment:c=",
  "pr reopen": "comment:c=",
  "issue close": "comment:c= duplicate-of= reason:r=",
  "issue reopen": "comment:c=",
  "pr ready": "undo",
  "label create": "color:c= description:d= force:f",
  "label edit": "color:c= description:d= name:n=",
  "run rerun": "debug:d failed job:j=",
};
const API_FLAGS =
  "method:X= field:F= raw-field:f= header:H= hostname= input= jq:q= template:t= cache= preview:p= include:i paginate silent slurp verbose allow-escape-sequences";

/**
 * REST writes Kin lets through: method, path (`O`/`R` owner and repo, `N` a number, `S` any
 * segment), and what the payload is. Every `body` in one is signed.
 */
const REST_WRITES: ReadonlyArray<
  readonly [string, string, "create" | "review" | "submit" | "any"]
> = [
  ["POST", "repos/O/R/issues", "create"],
  ["PATCH", "repos/O/R/issues/N", "any"],
  ["POST", "repos/O/R/issues/N/comments", "any"],
  ["PATCH", "repos/O/R/issues/comments/N", "any"],
  ["POST|PUT|DELETE", "repos/O/R/issues/N/labels", "any"],
  ["DELETE", "repos/O/R/issues/N/labels/S", "any"],
  ["POST", "repos/O/R/labels", "any"],
  ["PATCH", "repos/O/R/labels/S", "any"],
  ["POST|DELETE", "repos/O/R/issues/N/assignees", "any"],
  ["POST", "repos/O/R/pulls", "create"],
  ["PATCH", "repos/O/R/pulls/N", "any"],
  ["POST", "repos/O/R/pulls/N/reviews", "review"],
  ["PUT", "repos/O/R/pulls/N/reviews/N", "any"],
  ["POST", "repos/O/R/pulls/N/reviews/N/events", "submit"],
  ["POST", "repos/O/R/pulls/N/comments", "any"],
  ["POST", "repos/O/R/pulls/N/comments/N/replies", "any"],
  ["PATCH", "repos/O/R/pulls/comments/N", "any"],
  ["POST|DELETE", "repos/O/R/pulls/N/requested_reviewers", "any"],
  ["POST", "repos/O/R/issues/N/reactions", "any"],
  ["POST", "repos/O/R/issues/comments/N/reactions", "any"],
  ["POST", "repos/O/R/pulls/comments/N/reactions", "any"],
  ["DELETE", "repos/O/R/issues/N/reactions/N", "any"],
  ["DELETE", "repos/O/R/issues/comments/N/reactions/N", "any"],
  ["DELETE", "repos/O/R/pulls/comments/N/reactions/N", "any"],
  ["POST", "repos/O/R/actions/runs/N/rerun", "any"],
  ["POST", "repos/O/R/actions/runs/N/rerun-failed-jobs", "any"],
  ["POST", "repos/O/R/actions/jobs/N/rerun", "any"],
  ["POST", "repos/O/R/check-suites/N/rerequest", "any"],
  ["POST", "repos/O/R/check-runs/N/rerequest", "any"],
];

/** GraphQL mutations Kin lets through; every `body` in their arguments is signed. */
const GRAPHQL_WRITES = [
  "addComment",
  "updateIssueComment",
  "addPullRequestReview",
  "submitPullRequestReview",
  "updatePullRequestReview",
  "addPullRequestReviewComment",
  "addPullRequestReviewThread",
  "addPullRequestReviewThreadReply",
  "updatePullRequestReviewComment",
  "createIssue",
  "updateIssue",
  "closeIssue",
  "reopenIssue",
  "createPullRequest",
  "updatePullRequest",
  "closePullRequest",
  "reopenPullRequest",
  "markPullRequestReadyForReview",
  "convertPullRequestToDraft",
  "addLabelsToLabelable",
  "removeLabelsFromLabelable",
  "addAssigneesToAssignable",
  "removeAssigneesFromAssignable",
  "requestReviews",
  "addReaction",
  "removeReaction",
  "resolveReviewThread",
  "unresolveReviewThread",
];

/** The program's logic: plain JavaScript, no template interpolation, so regexes read as written. */
const POLICY_BODY = String.raw`
const NO_MERGE = "Kin agents don't merge pull requests: tell the owner it is ready and the owner merges it.";
const NO_APPROVE = "Kin agents don't approve pull requests: review with --comment or --request-changes instead.";
const NO_DISMISS = "Kin agents don't dismiss reviews: ask the owner.";
const NO_SETTINGS = "Kin agents don't change a repository's settings, access, secrets, keys, hooks or Apps: ask the owner to.";
const NO_DELETE = "Kin agents don't delete repositories, releases, issues or labels: ask the owner to.";
const NO_LOGIN = "Kin agents don't change the owner's gh login or setup: ask the owner to.";
const unknown = (what) => "Kin agents' gh makes only the GitHub writes Kin knows, and " + what + " isn't one: comment, review (--comment or --request-changes), open or edit PRs and issues, labels, reactions and re-runs, with gh pr, issue, label and run, or gh api fields. Ask the owner for anything else.";
const unreadable = (what) => "Kin can't read this GitHub write in full (" + what + "), so it didn't run. Use gh pr, issue, label or run, or gh api with -f fields or --input JSON.";

const refuse = (message) => {
  process.stderr.write("kin: " + message + "\n");
  // kin-as-owner leaves out of its record what didn't run.
  if (process.env.KIN_REFUSED) {
    try {
      appendFileSync(process.env.KIN_REFUSED, message + "\n");
    } catch {}
  }
  process.exit(1);
};

const posted = [];
const sign = (text) => {
  const out = signed(text, process.env.KIN_AGENT_NAME || "");
  posted.push(text, out);
  return out;
};
// Kin's watch ignores a comment whose text an agent sent, signed or not (agentMark.ts postKey).
const record = () => {
  const keys = new Set(
    posted
      .map((text) => text.replace(/\r\n?/g, "\n").trim())
      .filter((text) => text !== "")
      .map((text) => createHash("sha256").update(text).digest("hex")),
  );
  if (keys.size === 0) return;
  const at = Math.floor(Date.now() / 1000);
  try {
    mkdirSync(APP, { recursive: true });
    appendFileSync(POSTS, [...keys].map((key) => at + "\t" + key + "\n").join(""));
  } catch {
    refuse("Kin couldn't record what this posts, so it didn't run.");
  }
};

let stdinRead = false;
const readText = (file) => {
  if (file === "-") {
    if (stdinRead) refuse(unreadable("standard input is read twice"));
    stdinRead = true;
  }
  try {
    return readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (error) {
    return refuse("can't read " + file + ": " + error.message);
  }
};

const run = (args, input) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(REAL, args, { stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"], env });
  if (input !== undefined) {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => refuse(error.message));
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 1)));
};

// A flag table from "long:s long= ...": value flags end with "=".
const flagSpec = (text) => {
  const long = { repo: "value", help: "bool" };
  const short = { R: "repo", h: "help" };
  for (const entry of text.split(" ")) {
    const takes = entry.endsWith("=");
    const [name, letter] = (takes ? entry.slice(0, -1) : entry).split(":");
    long[name] = takes ? "value" : "bool";
    if (letter) short[letter] = name;
  }
  return { long, short };
};

// pflag's ParseBool.
const boolOf = (text) =>
  ["1", "t", "T", "TRUE", "true", "True"].includes(text) ? true : ["0", "f", "F", "FALSE", "false", "False"].includes(text) ? false : undefined;

// Arguments as pflag reads them: --name value, --name=value, -s value, -svalue, -s=value, -abc.
const parseFlags = (tokens, spec) => {
  const flags = [];
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      const kind = spec.long[name];
      if (kind === undefined) return { error: token };
      if (kind === "value") {
        if (eq >= 0) flags.push([name, token.slice(eq + 1)]);
        else if (i + 1 < tokens.length) flags.push([name, tokens[++i]]);
        else return { error: token };
      } else {
        const on = eq < 0 ? true : boolOf(token.slice(eq + 1));
        if (on === undefined) return { error: token };
        flags.push([name, on]);
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      for (let j = 1; j < token.length; j++) {
        const name = spec.short[token[j]];
        if (name === undefined) return { error: token };
        if (spec.long[name] === "value") {
          let rest = token.slice(j + 1);
          if (rest.length > 1 && rest[0] === "=") rest = rest.slice(1);
          if (rest !== "") flags.push([name, rest]);
          else if (i + 1 < tokens.length) flags.push([name, tokens[++i]]);
          else return { error: token };
          break;
        }
        if (token[j + 1] === "=" && token.length > j + 2) {
          const on = boolOf(token.slice(j + 2));
          if (on === undefined) return { error: token };
          flags.push([name, on]);
          break;
        }
        flags.push([name, true]);
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
};
const valuesOf = (flags, name) => flags.filter((flag) => flag[0] === name).map((flag) => flag[1]);
// A repeated bool flag is what its last occurrence says, as in pflag.
const isOn = (flags, name) => valuesOf(flags, name).at(-1) === true;
// Value flags as two arguments, which pflag reads the same whatever the value starts with.
const flagArgs = (flags) =>
  flags.flatMap(([name, value]) => (value === true ? ["--" + name] : value === false ? ["--" + name + "=false"] : ["--" + name, value]));

// gh pr/issue/label/run writes: read every flag, sign the text, send exactly what was read.
const subcommand = (command, tokens) => {
  const parsed = parseFlags(tokens, flagSpec(WRITE_FLAGS[command]));
  if (parsed.error) refuse(unreadable("gh " + command + " " + parsed.error));
  if (parsed.positionals.some((arg) => arg.startsWith("-"))) refuse(unreadable("an argument starting with -"));
  if (isOn(parsed.flags, "help")) return run([...command.split(" "), ...tokens]);
  for (const name of ["editor", "web", "recover", "template"])
    if (valuesOf(parsed.flags, name).length > 0)
      refuse(unreadable("--" + name + " writes text Kin can't sign; pass it with --body or --body-file"));
  if (command === "pr review") {
    if (valuesOf(parsed.flags, "approve").length > 0) refuse(NO_APPROVE);
    const modes = ["comment", "request-changes"].filter((name) => isOn(parsed.flags, name));
    if (modes.length !== 1) refuse(unknown("a review without exactly one of --comment or --request-changes"));
  }
  const textFlag = ["pr close", "pr reopen", "issue close", "issue reopen"].includes(command) ? "comment" : "body";
  let text;
  const flags = [];
  for (const [name, value] of parsed.flags) {
    if (name === textFlag && value !== true) text = value;
    else if (name === "body-file") text = readText(value);
    else flags.push([name, value]);
  }
  const needsText =
    ["pr comment", "issue comment", "pr review"].includes(command) && !isOn(parsed.flags, "delete-last");
  if (text === undefined && needsText) refuse(unreadable("no --body or --body-file; Kin signs only text it is given"));
  if (text === undefined && (command === "pr create" || command === "issue create")) {
    const fill = ["fill", "fill-first", "fill-verbose"].some((name) => isOn(parsed.flags, name));
    text = "";
    if (fill) text = spawnSync("git", ["log", "-1", "--format=%b"], { encoding: "utf8" }).stdout?.trim() ?? "";
  }
  if (text !== undefined) flags.push([textFlag, sign(text)]);
  record();
  run([...command.split(" "), ...parsed.positionals, ...flagArgs(flags)]);
};

// gh api fields, built as gh builds them: key[sub]=v nests, key[]=v appends, -F converts.
const buildFields = (raw, typed) => {
  const params = {};
  const childOf = (map, key) => {
    if (map[key] === undefined) map[key] = {};
    const child = map[key];
    if (child === null || typeof child !== "object" || Array.isArray(child)) refuse(unreadable("field " + key));
    return child;
  };
  const itemOf = (map, key, next) => {
    if (map[key] === undefined) map[key] = [];
    const list = map[key];
    if (!Array.isArray(list)) refuse(unreadable("field " + key));
    const last = list[list.length - 1];
    if (last !== null && typeof last === "object" && !Array.isArray(last) && !Object.hasOwn(last, next)) return last;
    const item = {};
    list.push(item);
    return item;
  };
  const add = (field, typedValue) => {
    const eq = field.indexOf("=");
    const keyText = eq < 0 ? field : field.slice(0, eq);
    const match = /^([^\[\]=]+)((?:\[[^\[\]]*\])*)$/.exec(keyText);
    if (!match) refuse(unreadable("field " + keyText));
    const keys = [match[1], ...[...match[2].matchAll(/\[([^\[\]]*)\]/g)].map((part) => part[1])];
    let value = eq < 0 ? undefined : field.slice(eq + 1);
    if (value === undefined && keys[keys.length - 1] !== "") refuse(unreadable("field " + keyText + " without a value"));
    if (typedValue && value !== undefined) value = magic(value);
    let map = params;
    let list = false;
    let key = "";
    for (const part of keys) {
      if (part === "") {
        list = true;
        continue;
      }
      if (key !== "") map = list ? itemOf(map, key, part) : childOf(map, key);
      list = false;
      key = part;
    }
    if (list) {
      if (map[key] === undefined) map[key] = [];
      if (!Array.isArray(map[key])) refuse(unreadable("field " + keyText));
      if (value !== undefined) map[key].push(value);
    } else {
      if (Object.hasOwn(map, key)) refuse(unreadable("field " + keyText + " given twice"));
      map[key] = value;
    }
  };
  for (const field of raw) add(field, false);
  for (const field of typed) add(field, true);
  return params;
};
const magic = (value) => {
  if (value.startsWith("@")) return readText(value.slice(1));
  if (/^[+-]?\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    refuse(unreadable("a number too large"));
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/\{(owner|repo|branch)\}/.test(value)) refuse(unreadable("a {owner}, {repo} or {branch} placeholder in a field; write it out"));
  return value;
};

// Signs every string "body" at any depth of a JSON value; collects each "event" it passes.
const signJson = (holder, slot, key, events) => {
  const value = holder[slot];
  if (Array.isArray(value)) value.forEach((_, index) => signJson(value, index, key, events));
  else if (value !== null && typeof value === "object") for (const name of Object.keys(value)) signJson(value, name, name, events);
  else if (key === "body") {
    if (typeof value === "string") holder[slot] = sign(value);
    else if (value !== null && value !== undefined) refuse(unreadable("a body that isn't text"));
  } else if (key === "event") events.push(typeof value === "string" ? value : "?");
};

// Signs each body in a mutation field's arguments, inline or through variables; returns events.
const signGraphql = (fieldArgs, variables, edits) => {
  const events = [];
  const walk = (node, key) => {
    if (node.kind === "var") {
      if (variables !== null && typeof variables === "object" && variables[node.name] !== undefined)
        signJson(variables, node.name, key, events);
    } else if (node.kind === "obj") for (const [name, child] of node.fields) walk(child, name);
    else if (node.kind === "list") for (const item of node.items) walk(item, key);
    else if (key === "body") {
      if (node.kind === "str") edits.push([node.token.start, node.token.end, JSON.stringify(sign(node.value))]);
      else if (node.kind !== "null") refuse(unreadable("a body that isn't text"));
    } else if (key === "event") events.push(node.kind === "enum" || node.kind === "str" ? node.value : "?");
  };
  for (const [name, node] of fieldArgs) walk(node, name);
  return events;
};
const REVIEW_EVENTS = ["COMMENT", "REQUEST_CHANGES"];
const checkEvents = (events, required) => {
  if (events.some((event) => String(event).toUpperCase() === "APPROVE")) refuse(NO_APPROVE);
  if (events.some((event) => !REVIEW_EVENTS.includes(event))) refuse(unknown("a review event other than COMMENT or REQUEST_CHANGES"));
  if (required && events.length === 0) refuse(unknown("a review submitted without an event"));
};
const refusalFor = (method, path) => {
  if (/(^|\/)repos$/.test(path)) return unknown("making a repository");
  if (/(^|\/)(merges?|merge-upstream|auto-merge|merge-queue)(\/|$)/.test(path)) return NO_MERGE;
  if (/\/dismissals$/.test(path)) return NO_DISMISS;
  if (method === "DELETE" && (/^repos\/[^/]+\/[^/]+$/.test(path) || /\/(releases|labels)(\/|$)/.test(path))) return NO_DELETE;
  if (
    /^repos\/[^/]+\/[^/]+$/.test(path) ||
    /^(orgs|user|users|app|applications|installation|teams|enterprises|admin)(\/|$)/.test(path) ||
    /(^|\/)(collaborators|invitations|teams|members|memberships|protection|rulesets|rules|hooks|keys|environments|secrets|variables|permissions|installations?|pages|transfer|topics|vulnerability-alerts|automated-security-fixes|properties|interaction-limits|autolinks)(\/|$)/.test(path)
  )
    return NO_SETTINGS;
  return unknown(method + " " + path);
};
const restKind = (method, path) => {
  for (const [methods, pattern, kind] of REST_WRITES) {
    if (!methods.split("|").includes(method)) continue;
    const source = pattern
      .split("/")
      .map((part) => (part === "N" ? "\\d+" : part === "O" || part === "R" || part === "S" ? "[^/]+" : part))
      .join("/");
    if (new RegExp("^" + source + "$").test(path)) return kind;
  }
  return undefined;
};
const graphqlRefusal = (name) => {
  if (/merge|enqueue/i.test(name)) return NO_MERGE;
  if (name === "dismissPullRequestReview") return NO_DISMISS;
  if (/BranchProtection|Ruleset|Repository|Collaborator|Team|Secret|Variable|DeployKey|Webhook|Installation|Environment|Member|Permission|Enterprise|Organization/.test(name)) return NO_SETTINGS;
  if (/^(delete|archive|transfer)/.test(name)) return NO_DELETE;
  return unknown("the GraphQL mutation " + name);
};

const api = (tokens) => {
  const parsed = parseFlags(tokens, flagSpec(API_FLAGS));
  if (parsed.error) refuse(unreadable("gh api " + parsed.error));
  const { flags } = parsed;
  if (isOn(flags, "help")) return run(["api", ...tokens]);
  if (parsed.positionals.length !== 1 || parsed.positionals[0].startsWith("-")) refuse(unreadable("gh api takes one endpoint"));
  const endpoint = parsed.positionals[0];
  const raw = valuesOf(flags, "raw-field");
  const typed = valuesOf(flags, "field");
  const input = valuesOf(flags, "input").at(-1);
  const given = valuesOf(flags, "method").at(-1);
  const method = (given ?? (raw.length + typed.length > 0 || input !== undefined ? "POST" : "GET")).toUpperCase();
  let path = endpoint;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      refuse(unreadable("its endpoint"));
    }
    path = path.replace(/^\/api\/v3\//, "/").replace(/^\/api\/graphql$/, "graphql");
  }
  path = path.replace(/^\/+/, "").split("?")[0].replace(/\/+$/, "");
  const passthrough = flags.filter(([name]) => !["method", "field", "raw-field", "input"].includes(name));
  if (valuesOf(flags, "header").some((header) => /^\s*x-http-method/i.test(String(header))))
    refuse(unreadable("a method override header"));
  const graphql = path === "graphql";
  if (!graphql && (method === "GET" || method === "HEAD"))
    return run(["api", endpoint, "--method", method, ...flagArgs(flags.filter(([name]) => name !== "method"))]);

  let payload;
  let query;
  if (input !== undefined) {
    if (raw.length + typed.length > 0) refuse(unreadable("fields with --input"));
    const text = readText(input);
    try {
      payload = JSON.parse(text);
    } catch {
      refuse(unreadable("--input that isn't JSON"));
    }
    if (payload === null || typeof payload !== "object") refuse(unreadable("--input that isn't a JSON object"));
    if (graphql) query = payload.query;
  } else if (graphql) {
    // Read only the query to tell a read; a read keeps its other fields as gh would build them.
    const fieldOf = (list, typedValue) =>
      list.filter((field) => field.startsWith("query=")).map((field) => (typedValue ? magic(field.slice(6)) : field.slice(6)));
    const queries = [...fieldOf(raw, false), ...fieldOf(typed, true)];
    if (queries.length !== 1) refuse(unreadable("a GraphQL request needs exactly one query"));
    query = queries[0];
  }
  if (graphql) {
    if (typeof query !== "string") refuse(unreadable("a GraphQL request without a query"));
    let operations;
    try {
      operations = parseGraphql(query);
    } catch (error) {
      refuse(unreadable("its GraphQL: " + error.message));
    }
    if (operations.some((operation) => operation.type === "subscription")) refuse(unknown("a GraphQL subscription"));
    const mutations = operations.filter((operation) => operation.type === "mutation");
    if (mutations.length === 0) {
      if (input !== undefined) return run(["api", "graphql", "--method", "POST", "--input", "-", ...flagArgs(passthrough)], JSON.stringify(payload));
      const others = [
        ...raw.filter((field) => !field.startsWith("query=")).map((field) => ["raw-field", field]),
        ...typed.filter((field) => !field.startsWith("query=")).map((field) => ["field", field]),
      ];
      return run(["api", "graphql", "--method", "POST", "--raw-field", "query=" + query, ...flagArgs([...others, ...passthrough])]);
    }
    if (payload === undefined) {
      const fields = buildFields(raw, typed);
      payload = { query: fields.query };
      if (fields.operationName !== undefined) payload.operationName = fields.operationName;
      delete fields.query;
      delete fields.operationName;
      if (Object.keys(fields).length > 0) payload.variables = fields;
    }
    const edits = [];
    for (const operation of mutations) {
      if (operation.defaults) refuse(unreadable("a GraphQL variable with a default value"));
      for (const field of operation.fields) {
        if (!GRAPHQL_WRITES.has(field.name)) refuse(graphqlRefusal(field.name));
        const events = signGraphql(field.args, payload.variables, edits);
        if (field.name === "addPullRequestReview") checkEvents(events, false);
        else if (field.name === "submitPullRequestReview") checkEvents(events, true);
        else if (events.length > 0) refuse(unknown("an event on " + field.name));
      }
    }
    let rewritten = query;
    for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0]))
      rewritten = rewritten.slice(0, start) + text + rewritten.slice(end);
    payload.query = rewritten;
  } else {
    const kind = restKind(method, path);
    if (kind === undefined) refuse(refusalFor(method, path));
    if (payload === undefined) payload = buildFields(raw, typed);
    if (kind === "review" || kind === "submit") {
      const event = Array.isArray(payload) ? undefined : payload.event;
      checkEvents(event === undefined ? [] : [typeof event === "string" ? event : "?"], kind === "submit");
    }
    if (kind === "create" && !Array.isArray(payload) && payload.body === undefined) payload.body = "";
    signJson({ root: payload }, "root", "", []);
  }
  for (const [name, value] of passthrough)
    if (name === "header" && !/^\s*(accept|x-github-api-version|content-type)\s*:/i.test(String(value)))
      refuse(unreadable("the header " + String(value).split(":")[0]));
  record();
  run(["api", graphql ? "graphql" : endpoint, "--method", graphql ? "POST" : method, "--input", "-", ...flagArgs(passthrough)], JSON.stringify(payload));
};

const main = (args) => {
  const [first, second, third] = args;
  if (first === undefined || ["--help", "-h", "--version"].includes(first)) return run(args);
  if (first.startsWith("-")) refuse(unreadable("a flag before the command; write gh <command> first"));
  if (first === "api") return api(args.slice(1));
  if (first === "co") return run(args);
  if (READ_LEAVES.includes(first)) return run(args);
  if (first === "auth" && second !== undefined && second !== "status" && !second.startsWith("-")) refuse(NO_LOGIN);
  const group = GROUP_ALIASES[first] ?? first;
  const commands = COMMANDS[group];
  if (commands === undefined) refuse(unknown("gh " + first));
  if (second === undefined || second === "--help" || second === "-h" || second === "help") return run(args);
  if (second.startsWith("-")) refuse(unreadable("a flag before the subcommand; write gh " + first + " <command> first"));
  const nested = NESTED_READS[group + " " + second];
  if (nested !== undefined) {
    if (third === undefined || third === "--help" || third === "-h" || nested.includes(third)) return run(args);
    refuse(group === "issue" ? unknown("gh issue artifact " + third) : NO_SETTINGS);
  }
  const verdict = commands[second];
  if (verdict === "read") return run(args);
  if (verdict === "merge") refuse(NO_MERGE);
  if (verdict === "settings") refuse(NO_SETTINGS);
  if (verdict === "delete") refuse(NO_DELETE);
  if (verdict === "login") refuse(NO_LOGIN);
  if (verdict !== undefined && WRITE_FLAGS[verdict] !== undefined) return subcommand(verdict, args.slice(2));
  refuse(unknown("gh " + first + " " + second));
};

main(process.argv.slice(2));
`;

/** The policy program, an ES module for `node`. */
export const ghPolicyScript = (paths: GhPolicyPaths) =>
  `// Written by Kin. What a Kin agent's gh lets through; see ghPolicy.ts in Kin's source.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";

const REAL = ${JSON.stringify(paths.realGh)};
const APP = ${JSON.stringify(paths.app)};
const POSTS = ${JSON.stringify(paths.postsFile)};
const COMMANDS = ${JSON.stringify(COMMANDS)};
const GROUP_ALIASES = ${JSON.stringify(GROUP_ALIASES)};
const READ_LEAVES = ${JSON.stringify(READ_LEAVES)};
const NESTED_READS = ${JSON.stringify(NESTED_READS)};
const WRITE_FLAGS = ${JSON.stringify(WRITE_FLAGS)};
const API_FLAGS = ${JSON.stringify(API_FLAGS)};
const REST_WRITES = ${JSON.stringify(REST_WRITES)};
const GRAPHQL_WRITES = new Set(${JSON.stringify(GRAPHQL_WRITES)});
const signed = ${signed.toString()};
${GRAPHQL_READER}
${POLICY_BODY}`;
