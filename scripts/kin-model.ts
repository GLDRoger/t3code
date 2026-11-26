// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - a plain CLI around the TLC model checker.
// Checks one of Kin's TLA+ models in verification/kin/<name>/ with TLC and tells the result in
// the owner's words, through the model's view.ts.
//
//   node scripts/kin-model.ts <name>                      check every rule; exit 1 if one breaks
//   node scripts/kin-model.ts <name> --chart <file.md>    also draw the statechart to <file.md>
//   node scripts/kin-model.ts <name> --broken <variant>   check a deliberately broken variant
//   node scripts/kin-model.ts <name> --variants           every broken variant must break its rule
//   node scripts/kin-model.ts <name> --if-java            skip, and pass, when no Java is installed
//
// TLC is the pinned tla2tools.jar, fetched once into ~/.cache/kin-model (or $KIN_MODEL_CACHE) and
// checked against its sha256. It needs Java 11 or newer on PATH, or mise to run Temurin 21.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const MISE_JAVA = "java@temurin-21";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/** The files each model stands for (its README's Covers), so `check:changed` runs it on a change. */
export const MODEL_COVERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  send: [
    "apps/server/src/kin/connections/ConnectionsService.ts",
    "apps/server/src/kin/connections/Sending.ts",
    "apps/server/src/kin/work/cardAnswers.ts",
    "apps/server/src/kin/layer.ts",
  ],
  reply: [
    "apps/server/src/kin/reply/KinReplyBridge.ts",
    "apps/server/src/kin/reply/promises.ts",
    "apps/server/src/kin/lead/WakeupRunner.ts",
    "apps/server/src/kin/lead/KinEventQueue.ts",
    "apps/server/src/kin/floor/KinFloor.ts",
    "apps/server/src/kin/lead/Handoff.ts",
    "apps/server/src/kin/lead/LevelGate.ts",
    "apps/server/src/kin/reply/classify.ts",
    "apps/server/src/kin/pulse/nudge.ts",
    "apps/server/src/kin/lead/ChatSharing.ts",
    "apps/server/src/kin/lead/Audience.ts",
    "apps/server/src/kin/chat/KinGroups.ts",
  ],
  checkin: [
    "apps/server/src/scheduledTasks/Schedule.ts",
    "apps/server/src/scheduledTasks/ScheduledTaskService.ts",
    "apps/server/src/kin/pulse/checkIn.ts",
    "apps/server/src/kin/pulse/checkIns.ts",
    "apps/server/src/kin/pulse/checkInSeeds.ts",
    "apps/server/src/kin/pulse/checkInCatchUp.ts",
    "apps/server/src/kin/pulse/KinPulse.ts",
    "apps/server/src/kin/triggers/scheduledTasks.ts",
    "apps/server/src/kin/triggers/KinTriggerSink.ts",
    "apps/server/src/kin/triggers/kinSchedules.ts",
    "apps/server/src/kin/lead/KinEventQueue.ts",
    "apps/server/src/kin/pulse/told.ts",
    "apps/server/src/kin/triggers/quietHold.ts",
    "apps/server/src/kin/triggers/quietHours.ts",
    "apps/server/src/kin/triggers/heldDelivery.ts",
    "apps/server/src/kin/push/KinPushSender.ts",
    "apps/server/src/kin/lead/LevelGate.ts",
    "apps/server/src/kin/lead/Handoff.ts",
    "apps/server/src/kin/work/assignNotices.ts",
    "apps/server/src/kin/pulse/nudge.ts",
    "apps/server/src/kin/pulse/factCards.ts",
    "apps/server/src/kin/pulse/factCardTaps.ts",
  ],
  money: [
    "apps/server/src/kin/gendocs/receiptProposals.ts",
    "apps/server/src/kin/gendocs/receipts.ts",
    "apps/server/src/kin/work/cardAnswers.ts",
    "apps/server/src/kin/work/KinRecords.ts",
    "apps/server/src/kin/work/statements/statementApply.ts",
    "apps/server/src/kin/work/statements/statementReview.ts",
    "apps/server/src/kin/work/statements/statementMatch.ts",
  ],
  people: [
    "apps/server/src/kin/people/KinPeople.ts",
    "apps/server/src/kin/people/KinAccess.ts",
    "apps/server/src/kin/people/personNamed.ts",
    "apps/server/src/kin/work/teamView.ts",
    "apps/server/src/kin/lead/Audience.ts",
    "apps/server/src/kin/lead/ChatSharing.ts",
    "apps/server/src/kin/pulse/senses/work.ts",
  ],
  stream: [
    "apps/server/src/kin/shell/KinShell.ts",
    "apps/server/src/kin/work/workStream.ts",
    "apps/server/src/kin/work/KinRecords.ts",
    "apps/server/src/kin/work/teamView.ts",
    "packages/contracts/src/kinWorkRows.ts",
    "packages/client-runtime/src/kin/kinWorkStream.ts",
  ],
  tasks: [
    "apps/server/src/kin/work/KinRecords.ts",
    "apps/server/src/kin/work/leadWork.ts",
    "apps/server/src/kin/work/recordRows.ts",
    "apps/server/src/kin/work/ownerWork.ts",
    "apps/server/src/kin/work/assignNotices.ts",
    "apps/server/src/kin/work/teamView.ts",
    "apps/server/src/kin/pulse/senses/work.ts",
  ],
  questions: [
    "apps/server/src/kin/questions/openQuestions.ts",
    "apps/server/src/kin/questions/askPerson.ts",
    "apps/server/src/kin/questions/rules.ts",
    "apps/server/src/kin/widgets/choiceCard.ts",
    "apps/server/src/kin/work/cardAnswers.ts",
    "apps/server/src/kin/lead/mcp/handlers.ts",
    "apps/server/src/kin/triggers/deferralFlow.ts",
  ],
  discussion: [
    "apps/server/src/kin/team/turns.ts",
    "apps/server/src/kin/team/KinTeam.ts",
    "apps/server/src/kin/team/stakes.ts",
    "apps/server/src/kin/chat/KinChatService.ts",
    "apps/server/src/kin/chat/KinGroups.ts",
    "apps/server/src/kin/lead/Handoff.ts",
    "apps/server/src/kin/lead/WakeupRunner.ts",
    "apps/server/src/kin/lead/ChatWake.ts",
  ],
  "github-events": [
    "apps/server/src/kin/github/GitHubWatch.ts",
    "apps/server/src/kin/github/githubTriggers.ts",
    "apps/server/src/kin/github/agentMark.ts",
    "apps/server/src/kin/github/ghSign.ts",
  ],
  social: [
    "apps/server/src/kin/social/SocialService.ts",
    "apps/server/src/kin/social/cards.ts",
    "apps/server/src/kin/social/rows.ts",
  ],
};
/** The models a change touches: a covered file, the model's own folder, or this runner. */
export const modelsFor = (files: ReadonlyArray<string>) =>
  Object.keys(MODEL_COVERS).filter((name) =>
    files.some(
      (file) =>
        MODEL_COVERS[name]!.includes(file) ||
        file.startsWith(`verification/kin/${name}/`) ||
        file === "scripts/kin-model.ts",
    ),
  );
/**
 * Models a change selects through their covered code while their own folder is untouched. TLC
 * reads only the spec, so their pass says nothing about the change until someone re-confirms it.
 */
export const modelsToReconfirm = (files: ReadonlyArray<string>) =>
  Object.keys(MODEL_COVERS).filter(
    (name) =>
      files.some((file) => MODEL_COVERS[name]!.includes(file)) &&
      !files.some((file) => file.startsWith(`verification/kin/${name}/`)),
  );
const MODELS = NodePath.join(ROOT, "verification", "kin");

export type Value = string | number | boolean | Value[] | { [key: string]: Value };
export type Vars = Record<string, Value>;

export interface View {
  readonly title: string;
  readonly guide: string;
  readonly rules: Readonly<Record<string, string>>;
  readonly variants: ReadonlyArray<{
    readonly name: string;
    readonly breaks: string;
    readonly what: string;
  }>;
  readonly state: (vars: Vars) => string;
  readonly step: (action: string, from: Vars, to: Vars) => string | null;
  /** Smaller constants for drawing a chart whose full graph is too large to draw. */
  readonly chartConstants?: Readonly<Record<string, string>>;
  /** Several smaller charts in place of one, each its own lens on the same graph. */
  readonly charts?: ReadonlyArray<Pick<View, "title" | "guide" | "state" | "step">>;
}

export const parseValue = (text: string): Value => {
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at] ?? "")) at++;
  };
  const eat = (token: string) => {
    space();
    if (!text.startsWith(token, at)) throw new Error(`expected ${token} at ${at} in ${text}`);
    at += token.length;
  };
  const peek = (token: string) => {
    space();
    return text.startsWith(token, at);
  };
  const list = (close: string): Value[] => {
    const items: Value[] = [];
    if (peek(close)) {
      eat(close);
      return items;
    }
    for (;;) {
      items.push(value());
      if (peek(",")) eat(",");
      else break;
    }
    eat(close);
    return items;
  };
  const value = (): Value => {
    space();
    if (peek("<<")) {
      eat("<<");
      return list(">>");
    }
    if (peek("{")) {
      eat("{");
      return list("}");
    }
    if (peek("[")) {
      eat("[");
      const record: Record<string, Value> = {};
      if (peek("]")) {
        eat("]");
        return record;
      }
      for (;;) {
        space();
        const key = /^[A-Za-z_]\w*/.exec(text.slice(at))?.[0];
        if (key === undefined) throw new Error(`expected a field at ${at} in ${text}`);
        at += key.length;
        eat("|->");
        record[key] = value();
        if (peek(",")) eat(",");
        else break;
      }
      eat("]");
      return record;
    }
    if (peek("(")) {
      eat("(");
      const fn: Record<string, Value> = {};
      for (;;) {
        const key = value();
        eat(":>");
        fn[typeof key === "string" ? key : JSON.stringify(key)] = value();
        if (peek("@@")) eat("@@");
        else break;
      }
      eat(")");
      return fn;
    }
    if (text[at] === '"') {
      let out = "";
      at++;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === "\\") at++;
        out += text[at] ?? "";
        at++;
      }
      at++;
      return out;
    }
    const word = /^-?\w+/.exec(text.slice(at))?.[0];
    if (word === undefined) throw new Error(`cannot read a value at ${at} in ${text}`);
    at += word.length;
    if (word === "TRUE") return true;
    if (word === "FALSE") return false;
    return /^-?\d+$/.test(word) ? Number(word) : word;
  };
  const result = value();
  space();
  if (at !== text.length) throw new Error(`unread text after ${at} in ${text}`);
  return result;
};

/** `/\ a = 1` lines (a state as TLC prints it) to variables. */
export const parseState = (text: string): Vars => {
  const vars: Vars = {};
  const body = text.trim().replace(/^\/\\ /, "");
  for (const part of body.split(/\n\/\\ /)) {
    const match = /^(\w+) = ([\s\S]*)$/.exec(part.trim());
    if (match?.[1] === undefined || match[2] === undefined)
      throw new Error(`cannot read the state line ${part}`);
    vars[match[1]] = parseValue(match[2]);
  }
  return vars;
};

export interface TraceStep {
  readonly action: string;
  readonly vars: Vars;
}
export type Verdict =
  | { readonly _tag: "pass"; readonly distinct: number; readonly generated: number }
  | {
      readonly _tag: "invariant" | "property" | "deadlock";
      readonly rule: string | null;
      readonly trace: ReadonlyArray<TraceStep>;
      /** Where a lasso loops back to, or "stutter" when the run stops there for good. */
      readonly loop: number | "stutter" | null;
      readonly distinct: number;
      readonly generated: number;
    }
  | { readonly _tag: "error"; readonly message: string };

export const readVerdict = (output: string): Verdict => {
  const counts = /(\d+) states generated, (\d+) distinct states found/.exec(output);
  const generated = Number(counts?.[1] ?? 0);
  const distinct = Number(counts?.[2] ?? 0);
  if (/Model checking completed\. No error has been found\./.test(output))
    return { _tag: "pass", distinct, generated };
  const invariant = /Error: Invariant (\w+) is violated/.exec(output);
  const property = /Error: Temporal properties were violated\./.test(output);
  const deadlock = /Error: Deadlock reached\./.test(output);
  if (!invariant && !property && !deadlock)
    return { _tag: "error", message: output.split("\n").slice(-40).join("\n") };
  const trace: TraceStep[] = [];
  let loop: number | "stutter" | null = null;
  const blocks = output.split(/\n(?=State \d+: |Back to state \d+)/);
  for (const block of blocks) {
    if (/^State \d+: Stuttering/.test(block)) {
      loop = "stutter";
      continue;
    }
    const head = /^State (\d+): <?([^\n>]*)>?\n([\s\S]*)$/.exec(block);
    if (head?.[2] !== undefined && head[3] !== undefined) {
      const action = /^(\w+)/.exec(head[2])?.[1] ?? "";
      const stateText = head[3].split(/\n(?!\/\\ | )/)[0] ?? "";
      trace.push({ action: action === "Initial" ? "" : action, vars: parseState(stateText) });
      continue;
    }
    const back = /^Back to state (\d+)/.exec(block);
    if (back?.[1] !== undefined) loop = Number(back[1]) - 1;
  }
  return {
    _tag: invariant ? "invariant" : property ? "property" : "deadlock",
    rule: invariant?.[1] ?? null,
    trace,
    loop,
    distinct,
    generated,
  };
};

export interface Graph {
  readonly states: Map<string, { readonly vars: Vars; readonly start: boolean }>;
  readonly steps: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly action: string;
  }>;
}

const unescapeDot = (text: string) => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      const next = text[++i];
      out += next === "n" ? "\n" : next;
    } else out += c;
  }
  return out;
};

export const parseDot = (dot: string): Graph => {
  const states = new Map<string, { vars: Vars; start: boolean }>();
  const steps: Array<{ from: string; to: string; action: string }> = [];
  for (const line of dot.split("\n")) {
    const edge = /^(-?\d+) -> (-?\d+) \[label="([^"]*)"/.exec(line);
    if (edge?.[1] !== undefined && edge[2] !== undefined && edge[3] !== undefined) {
      steps.push({ from: edge[1], to: edge[2], action: edge[3] });
      continue;
    }
    const node = /^(-?\d+) \[label="((?:[^"\\]|\\.)*)"(,style = filled)?/.exec(line);
    if (node?.[1] !== undefined && node[2] !== undefined)
      states.set(node[1], { vars: parseState(unescapeDot(node[2])), start: node[3] !== undefined });
  }
  return { states, steps };
};

const cacheDir = () =>
  process.env["KIN_MODEL_CACHE"] ?? NodePath.join(NodeOS.homedir(), ".cache", "kin-model");

const tlcJar = async () => {
  const jar = NodePath.join(cacheDir(), `tla2tools-${TLC_VERSION}.jar`);
  if (NodeFS.existsSync(jar)) return jar;
  NodeFS.mkdirSync(cacheDir(), { recursive: true });
  console.error(`Fetching TLC ${TLC_VERSION} into ${cacheDir()}…`);
  const response = await fetch(TLC_URL);
  if (!response.ok) throw new Error(`Could not fetch ${TLC_URL}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (sha !== TLC_SHA256) throw new Error(`${TLC_URL} has sha256 ${sha}, expected ${TLC_SHA256}.`);
  NodeFS.writeFileSync(`${jar}.part`, bytes);
  NodeFS.renameSync(`${jar}.part`, jar);
  return jar;
};

const javaMajor = (command: ReadonlyArray<string>) => {
  const [file, ...args] = command;
  if (file === undefined) return 0;
  const run = NodeChildProcess.spawnSync(file, [...args, "-version"], { encoding: "utf8" });
  const version = /version "(\d+)(?:\.(\d+))?/.exec(`${run.stderr}${run.stdout}`);
  if (version?.[1] === undefined) return 0;
  return version[1] === "1" ? Number(version[2] ?? 0) : Number(version[1]);
};

// Only a Java already there: `mise exec` would otherwise download one mid-check.
const miseJavaInstalled = () =>
  NodeChildProcess.spawnSync("mise", ["where", MISE_JAVA], { encoding: "utf8" }).status === 0;
let javaCommand: ReadonlyArray<string> | undefined;
const java = () => {
  if (javaCommand !== undefined) return javaCommand;
  if (javaMajor(["java"]) >= 11) return (javaCommand = ["java"]);
  const mise = ["mise", "exec", MISE_JAVA, "--", "java"];
  if (miseJavaInstalled() && javaMajor(mise) >= 11) return (javaCommand = mise);
  throw new Error(
    `TLC needs Java 11 or newer. Install one with: mise use -g ${MISE_JAVA}  (or brew install --cask temurin)`,
  );
};

interface Model {
  readonly name: string;
  readonly dir: string;
  readonly module: string;
  readonly spec: string;
  readonly config: string;
  readonly view: View;
}

const isView = (value: unknown): value is View =>
  typeof value === "object" &&
  value !== null &&
  "state" in value &&
  typeof value.state === "function" &&
  "step" in value &&
  typeof value.step === "function" &&
  "rules" in value &&
  "variants" in value;

const loadModel = async (name: string): Promise<Model> => {
  const dir = NodePath.join(MODELS, name);
  const tla = NodeFS.existsSync(dir)
    ? NodeFS.readdirSync(dir).filter((file) => file.endsWith(".tla"))
    : [];
  if (tla.length !== 1 || tla[0] === undefined) {
    const known = NodeFS.existsSync(MODELS) ? NodeFS.readdirSync(MODELS).join(", ") : "none";
    throw new Error(`No model ${name} in verification/kin (models: ${known}).`);
  }
  const module = tla[0].slice(0, -4);
  const view: unknown = await import(NodeURL.pathToFileURL(NodePath.join(dir, "view.ts")).href);
  if (!isView(view))
    throw new Error(`${name}/view.ts must export title, rules, variants, state and step.`);
  return {
    name,
    dir,
    module,
    spec: NodeFS.readFileSync(NodePath.join(dir, `${module}.tla`), "utf8"),
    config: NodeFS.readFileSync(NodePath.join(dir, `${module}.cfg`), "utf8"),
    view,
  };
};

const configRules = (config: string) => ({
  invariants: [...config.matchAll(/^INVARIANTS?\s+(\w+)/gm)].map((m) => m[1] ?? ""),
  properties: [...config.matchAll(/^PROPERTY\s+(\w+)/gm)].map((m) => m[1] ?? ""),
});

/** The config as written, with only `keep` of its rules and `Broken` set to `broken`. */
const configWith = (config: string, keep: ReadonlyArray<string>, broken: string) =>
  config
    .split("\n")
    .filter((line) => {
      const rule = /^(?:INVARIANTS?|PROPERTY)\s+(\w+)/.exec(line)?.[1];
      return rule === undefined || keep.includes(rule);
    })
    .map((line) => line.replace(/^(\s*Broken\s*=\s*)"[^"]*"/, `$1"${broken}"`))
    .join("\n");

const runTlc = async (
  model: Model,
  config: string,
  dumpDot: boolean,
): Promise<{ verdict: Verdict; dot: string | null; ms: number }> => {
  const jar = await tlcJar();
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `kin-model-${model.name}-`));
  try {
    NodeFS.writeFileSync(NodePath.join(work, `${model.module}.tla`), model.spec);
    NodeFS.writeFileSync(NodePath.join(work, `${model.module}.cfg`), config);
    const [file, ...prefix] = java();
    if (file === undefined) throw new Error("No Java command.");
    const started = performance.now();
    const run = NodeChildProcess.spawnSync(
      file,
      [
        ...prefix,
        // TLC unpacks Naturals.tla and friends into java.io.tmpdir; a shared one races between runs.
        `-Djava.io.tmpdir=${work}`,
        "-XX:+UseParallelGC",
        // The default MSBDiskFPSet can report a duplicate fingerprint and crash dividing by zero
        // in reportSuccess after a clean search (seen on macOS, JBR 21); this set does not.
        "-Dtlc2.tool.fp.FPSet.impl=tlc2.tool.fp.OffHeapDiskFPSet",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-cleanup",
        "-metadir",
        NodePath.join(work, "states"),
        ...(dumpDot ? ["-dump", "dot,actionlabels", NodePath.join(work, "graph")] : []),
        "-config",
        `${model.module}.cfg`,
        `${model.module}.tla`,
      ],
      { cwd: work, encoding: "utf8", maxBuffer: 1 << 28 },
    );
    const ms = Math.round(performance.now() - started);
    const output = `${run.stdout}\n${run.stderr}`;
    const dotFile = NodePath.join(work, "graph.dot");
    return {
      verdict: readVerdict(output),
      dot: dumpDot && NodeFS.existsSync(dotFile) ? NodeFS.readFileSync(dotFile, "utf8") : null,
      ms,
    };
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
};

interface RuleResult {
  readonly rule: string;
  readonly verdict: Verdict;
  readonly ms: number;
}

/**
 * Each invariant in one run (TLC names the one that breaks; a broken one is dropped and the rest
 * rerun), then each property alone, since TLC does not say which property a lasso breaks.
 */
const checkRules = async (model: Model, broken: string): Promise<RuleResult[]> => {
  const { invariants, properties } = configRules(model.config);
  const results: RuleResult[] = [];
  let left = [...invariants];
  while (left.length > 0) {
    const { verdict, ms } = await runTlc(model, configWith(model.config, left, broken), false);
    if (verdict._tag === "invariant" && verdict.rule !== null && left.includes(verdict.rule)) {
      results.push({ rule: verdict.rule, verdict, ms });
      left = left.filter((rule) => rule !== verdict.rule);
      continue;
    }
    for (const rule of left) results.push({ rule, verdict, ms });
    break;
  }
  for (const rule of properties) {
    const { verdict, ms } = await runTlc(model, configWith(model.config, [rule], broken), false);
    results.push({ rule, verdict, ms });
  }
  return results;
};

const storyOf = (view: View, verdict: Extract<Verdict, { trace: unknown }>) => {
  const lines: string[] = [];
  const first = verdict.trace[0];
  if (first !== undefined) lines.push(`Start: ${view.state(first.vars)}.`);
  verdict.trace.slice(1).forEach((step, index) => {
    const before = verdict.trace[index];
    const label =
      before === undefined
        ? step.action
        : (view.step(step.action, before.vars, step.vars) ?? step.action);
    lines.push(`${index + 1}. ${label}. Now: ${view.state(step.vars)}.`);
  });
  if (verdict.loop === "stutter") lines.push("…and then nothing else ever happens.");
  else if (typeof verdict.loop === "number")
    lines.push(`…and from here it repeats from step ${verdict.loop} forever.`);
  return lines;
};

const say = (view: View, result: RuleResult) => {
  const sentence = view.rules[result.rule] ?? result.rule;
  const { verdict } = result;
  if (verdict._tag === "pass")
    return [`PASS  ${result.rule}: ${sentence}  (${verdict.distinct} states, ${result.ms} ms)`];
  if (verdict._tag === "error")
    return [`ERROR ${result.rule}: TLC could not check it.`, verdict.message];
  return [
    `FAIL  ${result.rule}: ${sentence}  (${verdict.distinct} states, ${result.ms} ms)`,
    ...(verdict._tag === "deadlock" ? ["  (TLC reached a state with no step out.)"] : []),
    ...storyOf(view, verdict).map((line) => `      ${line}`),
  ];
};

const mermaidText = (text: string) =>
  text
    .replace(/[:;]/g, ",")
    .replace(/["#{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const chartOf = (
  view: View,
  graph: Graph,
  breaking: ReadonlyArray<{ readonly rule: string; readonly trace: ReadonlyArray<TraceStep> }>,
) => {
  const labelOf = new Map<string, string>();
  for (const [id, state] of graph.states) labelOf.set(id, view.state(state.vars));
  const ids = new Map<string, string>();
  const idOf = (label: string) => {
    let id = ids.get(label);
    if (id === undefined) ids.set(label, (id = `s${ids.size}`));
    return id;
  };
  const startLabels = new Set<string>();
  for (const [id, state] of graph.states) if (state.start) startLabels.add(labelOf.get(id) ?? "");
  const drawn: Array<{ readonly a: string; readonly b: string; readonly label: string }> = [];
  for (const step of graph.steps) {
    const from = graph.states.get(step.from);
    const to = graph.states.get(step.to);
    if (from === undefined || to === undefined) continue;
    const a = labelOf.get(step.from) ?? "";
    const b = labelOf.get(step.to) ?? "";
    if (a === b) continue;
    const label = view.step(step.action, from.vars, to.vars);
    if (label !== null) drawn.push({ a, b, label });
  }
  // A start is s0; one a lens gives no step of its own is left out, unless nothing moves at all.
  const used = new Set(drawn.flatMap((one) => [one.a, one.b]));
  const starts = [...startLabels]
    .filter((label) => used.has(label) || drawn.length === 0)
    .map(idOf);
  const arrows = new Map<string, Set<string>>();
  for (const { a, b, label } of drawn) {
    const key = `${idOf(a)} ${idOf(b)}`;
    const set = arrows.get(key) ?? new Set<string>();
    set.add(label);
    arrows.set(key, set);
  }
  const marked = new Map<string, Set<string>>();
  for (const { rule, trace } of breaking) {
    const last = trace.at(-1);
    if (last === undefined) continue;
    const label = view.state(last.vars);
    if (!ids.has(label)) continue;
    const id = idOf(label);
    const rules = marked.get(id) ?? new Set<string>();
    rules.add(rule);
    marked.set(id, rules);
  }
  const lines = ["stateDiagram-v2", "  direction LR"];
  if (view.title) lines.unshift("---", `title: ${mermaidText(view.title)}`, "---");
  for (const [label, id] of ids) lines.push(`  state "${mermaidText(label)}" as ${id}`);
  for (const id of starts) lines.push(`  [*] --> ${id}`);
  for (const [key, labels] of arrows) {
    const [a, b] = key.split(" ");
    lines.push(`  ${a} --> ${b}: ${mermaidText([...labels].join(" / "))}`);
  }
  if (marked.size > 0) {
    lines.push("  classDef breaks fill:#fde2e2,stroke:#b91c1c,stroke-width:2px");
    for (const id of marked.keys()) lines.push(`  class ${id} breaks`);
  }
  return { mermaid: lines.join("\n"), states: ids.size, arrows: arrows.size, marked };
};

const argValue = (args: ReadonlyArray<string>, flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const main = async (args: ReadonlyArray<string>) => {
  const name = args[0];
  if (name === undefined || name.startsWith("-")) {
    console.error(
      "Usage: node scripts/kin-model.ts <name> [--chart <file.md>] [--broken <variant>] [--variants]",
    );
    return 2;
  }
  if (args.includes("--if-java")) {
    try {
      java();
    } catch {
      console.log(`${name}: skipped: Java not found (install Java 11+ to check this model).`);
      return 0;
    }
  }
  const model = await loadModel(name);
  const { view } = model;
  const started = performance.now();

  if (args.includes("--variants")) {
    let missed = 0;
    for (const variant of view.variants) {
      const { verdict, ms } = await runTlc(
        model,
        configWith(model.config, [variant.breaks], variant.name),
        false,
      );
      const caught: RuleResult = { rule: variant.breaks, verdict, ms };
      const ok =
        caught !== undefined && caught.verdict._tag !== "pass" && caught.verdict._tag !== "error";
      if (!ok) missed++;
      console.log(
        `${ok ? "caught" : "MISSED"}  ${variant.name}: ${variant.what} → ${variant.breaks}`,
      );
      if (ok && caught !== undefined)
        for (const line of say(view, caught).slice(1)) console.log(line);
    }
    console.log(
      `\n${view.variants.length - missed}/${view.variants.length} broken variants caught in ${Math.round(performance.now() - started)} ms.`,
    );
    return missed === 0 ? 0 : 1;
  }

  const broken = argValue(args, "--broken") ?? "none";
  if (broken !== "none" && !view.variants.some((one) => one.name === broken))
    throw new Error(
      `No variant ${broken}; variants: ${view.variants.map((one) => one.name).join(", ")}.`,
    );
  console.log(`${view.title}${broken === "none" ? "" : `  [broken: ${broken}]`}\n`);
  const results = await checkRules(model, broken);
  for (const result of results) for (const line of say(view, result)) console.log(line);
  const failed = results.filter((one) => one.verdict._tag !== "pass");

  const chartPath = argValue(args, "--chart");
  if (chartPath !== undefined) {
    const drawn = Object.entries(view.chartConstants ?? {}).reduce(
      (config, [name, value]) =>
        config.replace(new RegExp(`^(\\s*${name}\\s*=\\s*).*$`, "m"), `$1${value}`),
      configWith(model.config, [], broken),
    );
    const { verdict, dot } = await runTlc(model, drawn, true);
    if (dot === null) throw new Error(`TLC drew no state graph: ${JSON.stringify(verdict)}`);
    const breaking = failed.flatMap((one) =>
      "trace" in one.verdict ? [{ rule: one.rule, trace: one.verdict.trace }] : [],
    );
    const graph = parseDot(dot);
    const charts = (view.charts ?? [view]).map((lens) => ({
      lens,
      chart: chartOf({ ...view, ...lens }, graph, breaking),
    }));
    const findings = failed.flatMap((one) => [
      "",
      `**${view.rules[one.rule] ?? one.rule}** does not hold:`,
      "",
      ...("trace" in one.verdict ? storyOf(view, one.verdict) : ["TLC could not check it."]),
    ]);
    NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(chartPath)), { recursive: true });
    NodeFS.writeFileSync(
      chartPath,
      [
        `# ${view.title}`,
        "",
        ...(view.charts === undefined ? [] : [view.guide, ""]),
        ...charts.flatMap(({ lens, chart }) => [
          ...(view.charts === undefined ? [] : [`## ${lens.title}`, ""]),
          lens.guide,
          "",
          "```mermaid",
          chart.mermaid,
          "```",
          "",
        ]),
        "## Rules",
        "",
        ...results.map(
          (one) =>
            `- ${one.verdict._tag === "pass" ? "Holds" : "**Breaks**"}: ${view.rules[one.rule] ?? one.rule}`,
        ),
        ...findings,
        "",
        `Checked by \`node scripts/kin-model.ts ${name}\` with TLC ${TLC_VERSION}: ${
          results[0]?.verdict._tag === "pass" ? results[0].verdict.distinct : "?"
        } model states, drawn as ${charts
          .map(({ chart }) => `${chart.states} chart states and ${chart.arrows} arrows`)
          .join(", then ")}${
          view.chartConstants === undefined
            ? ""
            : ` (drawn with ${Object.entries(view.chartConstants)
                .map(([name, value]) => `${name} = ${value}`)
                .join(", ")})`
        }.`,
        "",
      ].join("\n"),
    );
    for (const { lens, chart } of charts)
      console.log(
        `\nChart: ${chartPath}: ${lens.title} (${chart.states} states, ${chart.arrows} arrows)`,
      );
  }
  console.log(
    `\n${failed.length === 0 ? "All rules hold" : `${failed.length} rule(s) break`} (${Math.round(performance.now() - started)} ms).`,
  );
  return failed.length === 0 ? 0 : 1;
};

if (import.meta.main)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
