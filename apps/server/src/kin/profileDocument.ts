import {
  KinAgentProfile,
  KinInlineProfile,
  type KinAgentProfile as KinAgentProfileType,
  type KinInlineProfile as KinInlineProfileType,
  type KinProfileSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const decodeInlineProfile = Schema.decodeUnknownSync(KinInlineProfile);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

const decodeProfileFields = Schema.decodeUnknownSync(
  Schema.Struct({
    name: KinAgentProfile.fields.name,
    role: KinAgentProfile.fields.role,
    provider: Schema.optional(KinAgentProfile.fields.provider),
    model: Schema.optional(KinAgentProfile.fields.model),
    reasoningEffort: Schema.optional(KinAgentProfile.fields.reasoningEffort),
    userMd: Schema.optional(KinAgentProfile.fields.userMd),
    tools: Schema.optional(KinAgentProfile.fields.tools),
    crownable: Schema.optional(KinAgentProfile.fields.crownable),
    seesWills: Schema.optional(KinAgentProfile.fields.seesWills),
  }),
);

export interface ParsedProfileDocument {
  readonly profile: KinAgentProfileType;
  readonly text: string;
}

export function profileDocumentError(detail: string): Error {
  return new Error(detail);
}

export function parseProfileDocument(
  text: string,
  source: KinProfileSource,
  path?: string,
): ParsedProfileDocument {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    throw profileDocumentError("Profile is missing frontmatter. Start the file with a --- block.");
  }
  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? "");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid YAML";
    throw profileDocumentError(`Profile frontmatter is invalid YAML: ${message}`);
  }
  let fields: ReturnType<typeof decodeProfileFields>;
  try {
    fields = decodeProfileFields(raw);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid profile";
    throw profileDocumentError(`Profile frontmatter is invalid: ${message}`);
  }
  const body = (match[2] ?? "").replace(/^\n/, "").trim();
  if (body.length === 0) {
    throw profileDocumentError("Profile body is empty. The body is the system prompt.");
  }
  const role = fields.role;
  const profile: KinAgentProfileType = {
    name: fields.name,
    role,
    provider: fields.provider ?? "inherit",
    model: fields.model ?? "inherit",
    reasoningEffort: fields.reasoningEffort ?? "inherit",
    userMd: fields.userMd ?? [],
    tools: fields.tools ?? {},
    crownable: fields.crownable ?? role !== "reviewer",
    seesWills: fields.seesWills ?? role !== "reviewer",
    body,
    source,
    ...(path === undefined ? {} : { path }),
  };
  return { profile, text: serializeProfileDocument(profile) };
}

export function serializeProfileDocument(
  profile: Pick<
    KinAgentProfileType,
    | "name"
    | "role"
    | "provider"
    | "model"
    | "reasoningEffort"
    | "userMd"
    | "tools"
    | "crownable"
    | "seesWills"
    | "body"
  >,
): string {
  const frontmatter = stringifyYaml({
    name: profile.name,
    role: profile.role,
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    userMd: profile.userMd,
    tools: profile.tools,
    crownable: profile.crownable,
    seesWills: profile.seesWills,
  }).trimEnd();
  return `---\n${frontmatter}\n---\n${profile.body.trim()}\n`;
}

export function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function profileFromInline(inline: KinInlineProfileType): {
  readonly profile: KinAgentProfileType;
  readonly fileName: string;
} {
  const decoded = decodeInlineProfile(inline);
  const body = decoded.prompt.trim();
  if (body.length === 0) {
    throw profileDocumentError("Inline profile prompt is empty.");
  }
  const role = decoded.role ?? "custom";
  const draft = {
    name: decoded.name ?? "adhoc",
    role,
    provider: decoded.provider ?? "inherit",
    model: decoded.model ?? "inherit",
    reasoningEffort: decoded.reasoningEffort ?? "inherit",
    userMd: decoded.userMd ?? [],
    tools: decoded.tools ?? {},
    crownable: decoded.crownable ?? role !== "reviewer",
    seesWills: decoded.seesWills ?? role !== "reviewer",
    body,
    source: "adhoc" as const,
  };
  const base = draft.name.slice(0, 55);
  const fileName = `${base}-${shortHash(serializeProfileDocument(draft))}`;
  return {
    profile: { ...draft, name: fileName as KinAgentProfileType["name"] },
    fileName,
  };
}
