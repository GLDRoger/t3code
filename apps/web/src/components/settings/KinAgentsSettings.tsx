import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinProfileName, KinPromptProviderKind } from "@t3tools/contracts";
import { useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import {
  deleteKinMd,
  kinBasePrompt,
  kinMdFiles,
  kinMdSource,
  kinProfileSource,
  kinProfiles,
  kinPromptPreview,
  writeKinBasePrompt,
  writeKinMd,
  writeKinProfile,
} from "../../state/kin";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PREVIEW_PROVIDERS: ReadonlyArray<KinPromptProviderKind> = ["codex", "claudeAgent", "grok"];

function projectInput(projectRoot: string | undefined) {
  return projectRoot === undefined ? {} : { projectRoot };
}

export function KinAgentsSettings() {
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Connect an environment to edit Kin agents.
        </p>
      </SettingsPageContainer>
    );
  }
  const projectRoot =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.find((member) => member.environmentId === environmentId)?.workspaceRoot
      : undefined;
  return (
    <KinAgentsForm
      key={`${environmentId}:${projectRoot ?? ""}`}
      environmentId={environmentId}
      projectRoot={projectRoot}
    />
  );
}

function KinAgentsForm({
  environmentId,
  projectRoot,
}: {
  environmentId: EnvironmentId;
  projectRoot: string | undefined;
}) {
  const profiles = useEnvironmentQuery(
    kinProfiles({ environmentId, input: projectInput(projectRoot) }),
  );
  const [selected, setSelected] = useState<KinProfileName | null>(null);
  const name = selected ?? profiles.data?.profiles[0]?.name ?? null;
  const source = useEnvironmentQuery(
    name === null
      ? null
      : kinProfileSource({
          environmentId,
          input: { name, ...projectInput(projectRoot) },
        }),
  );
  const base = useEnvironmentQuery(kinBasePrompt({ environmentId, input: {} }));
  const files = useEnvironmentQuery(
    kinMdFiles({ environmentId, input: projectInput(projectRoot) }),
  );
  const canWrite = useAtomValue(writeKinProfile.permissionAtom(environmentId));
  const saveProfile = useAtomCommand(writeKinProfile);
  const saveBase = useAtomCommand(writeKinBasePrompt);
  const saveMd = useAtomCommand(writeKinMd);
  const removeMd = useAtomCommand(deleteKinMd);

  const [profileDraft, setProfileDraft] = useState<{
    readonly name: string;
    readonly text: string;
  } | null>(null);
  const [profileScope, setProfileScope] = useState<"project" | "user">("user");
  const [baseDraft, setBaseDraft] = useState<string | null>(null);
  const [mdKey, setMdKey] = useState<string | null>(null);
  const [mdDraft, setMdDraft] = useState<string | null>(null);
  const [mdName, setMdName] = useState("notes.md");
  const [mdScope, setMdScope] = useState<"project" | "user">("user");
  const [provider, setProvider] = useState<KinPromptProviderKind>("codex");
  const [message, setMessage] = useState<string | null>(null);

  const selectedFile =
    files.data?.files.find((file) => `${file.scope}:${file.name}` === mdKey) ??
    files.data?.files[0];
  const mdSource = useEnvironmentQuery(
    selectedFile === undefined
      ? null
      : kinMdSource({
          environmentId,
          input: {
            scope: selectedFile.scope,
            name: selectedFile.name,
            ...projectInput(projectRoot),
          },
        }),
  );
  const preview = useEnvironmentQuery(
    name === null
      ? null
      : kinPromptPreview({
          environmentId,
          input: { profile: name, provider, ...projectInput(projectRoot) },
        }),
  );

  const profileText =
    name !== null && profileDraft?.name === name ? profileDraft.text : (source.data?.text ?? "");
  const baseText = baseDraft ?? base.data?.text ?? "";
  const mdText = mdDraft ?? mdSource.data?.text ?? "";

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("kin-agents")}>
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <p className="text-sm text-muted-foreground">
            Profiles live in <span className="font-mono">.kin/agents</span> for this project and{" "}
            <span className="font-mono">~/.kin/agents</span> for you. A project file wins. The body
            is the system prompt.
          </p>
          {profiles.error ? <p className="text-sm text-destructive">{profiles.error}</p> : null}
          <div className="flex flex-wrap gap-2">
            {(profiles.data?.profiles ?? []).map((profile) => (
              <Button
                key={`${profile.source}:${profile.name}`}
                size="sm"
                variant={profile.name === name ? "default" : "outline"}
                onClick={() => setSelected(profile.name)}
              >
                {profile.name}
              </Button>
            ))}
          </div>
          <Textarea
            value={profileText}
            aria-label="Agent profile markdown"
            onChange={(event) => {
              if (name === null) return;
              setProfileDraft({ name, text: event.target.value });
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={profileScope === "user" ? "default" : "outline"}
              onClick={() => setProfileScope("user")}
            >
              User
            </Button>
            <Button
              size="sm"
              variant={profileScope === "project" ? "default" : "outline"}
              disabled={projectRoot === undefined}
              onClick={() => setProfileScope("project")}
            >
              Project
            </Button>
            <Button
              size="sm"
              disabled={!canWrite || profileText.trim().length === 0}
              onClick={() => {
                void saveProfile({
                  environmentId,
                  input: { scope: profileScope, text: profileText, ...projectInput(projectRoot) },
                }).then((result) => {
                  if (result._tag === "Success") {
                    setMessage("Saved the profile.");
                    setProfileDraft(null);
                    profiles.refresh();
                    source.refresh();
                    preview.refresh();
                  }
                });
              }}
            >
              Save profile
            </Button>
          </div>
          {projectRoot === undefined ? (
            <p className="text-xs text-muted-foreground">
              Open a project in Settings to save a project profile. User profiles still save.
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection {...searchableSetting("kin-base-prompt")}>
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <Textarea
            value={baseText}
            aria-label="Kin base prompt"
            onChange={(event) => setBaseDraft(event.target.value)}
          />
          <Button
            size="sm"
            disabled={!canWrite || baseText.trim().length === 0}
            onClick={() => {
              void saveBase({ environmentId, input: { text: baseText } }).then((result) => {
                if (result._tag === "Success") {
                  setMessage("Saved the Kin base prompt.");
                  setBaseDraft(null);
                  base.refresh();
                  preview.refresh();
                }
              });
            }}
          >
            Save base prompt
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection {...searchableSetting("kin-md-files")}>
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <p className="text-sm text-muted-foreground">
            Extra markdown a profile lists in <span className="font-mono">userMd</span>. Kin skips
            CLAUDE.md for Claude and AGENTS.md for Codex, because those CLIs already load them.
          </p>
          <div className="flex flex-wrap gap-2">
            {(files.data?.files ?? []).map((file) => (
              <Button
                key={`${file.scope}:${file.name}`}
                size="sm"
                variant={
                  selectedFile?.scope === file.scope && selectedFile.name === file.name
                    ? "default"
                    : "outline"
                }
                onClick={() => {
                  setMdKey(`${file.scope}:${file.name}`);
                  setMdName(file.name);
                  setMdScope(file.scope);
                  setMdDraft(null);
                }}
              >
                {file.scope}/{file.name}
              </Button>
            ))}
          </div>
          <div className="max-w-xs">
            <Input
              value={mdName}
              aria-label="Markdown file name"
              onChange={(event) => setMdName(event.target.value)}
            />
          </div>
          <Textarea
            value={mdText}
            aria-label="Markdown file"
            onChange={(event) => setMdDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={mdScope === "user" ? "default" : "outline"}
              onClick={() => setMdScope("user")}
            >
              User
            </Button>
            <Button
              size="sm"
              variant={mdScope === "project" ? "default" : "outline"}
              disabled={projectRoot === undefined}
              onClick={() => setMdScope("project")}
            >
              Project
            </Button>
            <Button
              size="sm"
              disabled={!canWrite}
              onClick={() => {
                void saveMd({
                  environmentId,
                  input: {
                    scope: mdScope,
                    name: mdName,
                    text: mdText,
                    ...projectInput(projectRoot),
                  },
                }).then((result) => {
                  if (result._tag === "Success") {
                    setMessage("Saved the markdown file.");
                    setMdDraft(null);
                    files.refresh();
                  }
                });
              }}
            >
              Save markdown
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || selectedFile === undefined}
              onClick={() => {
                if (selectedFile === undefined) return;
                void removeMd({
                  environmentId,
                  input: {
                    scope: selectedFile.scope,
                    name: selectedFile.name,
                    ...projectInput(projectRoot),
                  },
                }).then((result) => {
                  if (result._tag === "Success") {
                    setMdKey(null);
                    setMdDraft(null);
                    files.refresh();
                  }
                });
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection {...searchableSetting("kin-prompt-preview")}>
        <SettingsRow
          {...searchableSetting("kin-prompt-preview-provider")}
          description="The preview uses the same order a turn does. The brief is last and is empty until the lineage lane fills it."
          control={
            <div className="flex gap-2">
              {PREVIEW_PROVIDERS.map((kind) => (
                <Button
                  key={kind}
                  size="sm"
                  variant={provider === kind ? "default" : "outline"}
                  onClick={() => setProvider(kind)}
                >
                  {kind === "claudeAgent" ? "Claude" : kind === "codex" ? "Codex" : "Grok"}
                </Button>
              ))}
            </div>
          }
        />
        <div className="space-y-2 px-3 py-3 sm:px-4">
          {preview.error ? <p className="text-sm text-destructive">{preview.error}</p> : null}
          <p className="text-xs text-muted-foreground">Stable prefix</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {preview.data?.prefix ?? ""}
          </pre>
          <p className="text-xs text-muted-foreground">Delivered suffix</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {preview.data?.suffix ?? ""}
          </pre>
          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
