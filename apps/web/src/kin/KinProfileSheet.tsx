import { type RouterHistory, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DAY_LABELS,
  KIN_PROFILE_COPY,
  KIN_PROFILE_NAME_MAX,
  KIN_PROFILE_SKILLS_MAX,
  KIN_PROFILE_TALK_MAX,
  kinHoursLine,
  kinMayEditProfile,
  kinPersonSeed,
  kinProfileChanges,
  kinProfileDraft,
  kinProfileShowsTasks,
  kinQuietLine,
  type KinProfileDraft,
  type KinProfileHolding,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { kinFormTyped } from "@t3tools/client-runtime/kin/kinWorkForms";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import { KIN_TIME_ZONE_PLACEHOLDER, kinZoneLabel } from "@t3tools/client-runtime/kin/kinTimeZone";
import type {
  EnvironmentId,
  KinAttachment,
  KinOrgId,
  KinPersonId,
  KinPersonProfile,
} from "@t3tools/contracts";
import { KIN_PEOPLE_CHAT } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { KIN_PERSON_TASKS } from "@t3tools/client-runtime/kin/kinTasksList";
import { MessageSquareIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Blobatar } from "@blobatar/react";
import { kinAwayLine } from "@t3tools/client-runtime/kin/kinAway";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Toggle } from "../components/ui/toggle";
import { type ComposerImageAttachment } from "../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "../lib/imageCompression";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinAwayRow } from "./KinAway";
import { KinGithubLoginRow } from "./KinGithubLogin";
import { useOpenKinPeopleChat } from "./KinPeopleChat";
import { kinSettingsSectionIn } from "./kinSettingsAddress";
import type { KIN_PROFILE_SETTINGS_SEARCH_ITEMS } from "./kinSettingsSearch";

type KinProfileSearchId = (typeof KIN_PROFILE_SETTINGS_SEARCH_ITEMS)[number]["id"];
import { KinTasksKeysSection } from "./KinTasksKeys";
import { useKinOwnerLevelKnown } from "./useKinOwnerLevel";
import { KIN_DIALOG_PARTS, KIN_SHEET_PARTS } from "./kinOverlayParts";
import { KinMyDevices } from "./KinDevices";
import { KinPersonTasks } from "./KinPersonTasks";
import { KIN_PLACE_PATH } from "./kinPlaces";
import { kinClient } from "./kinClient";
import { useKinProfiles } from "./kinPictures";
import { useKinHostAt } from "./useKinHost";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { KinSettingsField, KinSettingsFormDialog } from "./settings/KinSettingsControls";
import {
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";

export interface KinProfileTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
}

const kinProfileSheetAtom = Atom.make<KinProfileTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:profile-sheet"),
);

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The profile sheet was opened on this page, so closing it is one step back. */
    kinProfilePushed?: boolean;
  }
}

// The profile lives in the address, as New task and Search do, so Back closes only the sheet.
const PROFILE_PARAM = "profile";
let kinHistory: RouterHistory | null = null;

/** Opens someone's profile over whatever is on screen: the Team list, a chat, the chat list. */
export const openKinProfile = (target: KinProfileTarget) => {
  appAtomRegistry.set(kinProfileSheetAtom, target);
  if (kinHistory === null) return;
  const { pathname, search, hash, state } = kinHistory.location;
  const params = new URLSearchParams(search);
  const already = params.has(PROFILE_PARAM);
  params.set(PROFILE_PARAM, target.personId);
  const href = `${pathname}?${params.toString()}${hash}`;
  // From one profile to another keeps the one step back to the page underneath.
  if (already) kinHistory.replace(href, state);
  else kinHistory.push(href, { ...state, kinProfilePushed: true });
};

export function KinProfileSheetHost() {
  const target = useAtomValue(kinProfileSheetAtom);
  const router = useRouter();
  const shown = useLocation({
    select: (location) => new URLSearchParams(location.searchStr).get(PROFILE_PARAM),
  });
  const overSettings = useLocation({
    select: (location) => kinSettingsSectionIn(location.searchStr) !== null,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the router's history to `openKinProfile`, which runs from handlers outside React
  useEffect(() => {
    kinHistory = router.history;
    return () => {
      kinHistory = null;
    };
  }, [router]);
  if (target === null || shown !== target.personId) return null;
  const close = () => {
    const { history } = router;
    if (history.location.state.kinProfilePushed === true) return history.back();
    const params = new URLSearchParams(history.location.search);
    params.delete(PROFILE_PARAM);
    const rest = params.toString();
    history.replace(
      `${history.location.pathname}${rest === "" ? "" : `?${rest}`}${history.location.hash}`,
      {
        ...history.location.state,
      },
    );
  };
  return (
    <KinProfileSheet
      key={`${target.environmentId}:${target.personId}`}
      target={target}
      inDialog={overSettings}
      onClose={close}
    />
  );
}

const PICTURE_EDGE = 512;
const PICTURE_MAX_BYTES = 2 * 1024 * 1024;

/** A square-ish picture no larger than 512 px on its long edge, as a JPEG. */
async function pictureFile(file: File): Promise<File | null> {
  const prepared = await prepareImageForAttachment(file, PICTURE_MAX_BYTES * 4).catch(() => null);
  if (prepared === null || !prepared.ok) return null;
  const bitmap = await createImageBitmap(prepared.file).catch(() => null);
  if (bitmap === null) return prepared.file.size <= PICTURE_MAX_BYTES ? prepared.file : null;
  const scale = Math.min(1, PICTURE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.86),
  );
  return blob === null || blob.size > PICTURE_MAX_BYTES
    ? null
    : new File([blob], "picture.jpg", { type: "image/jpeg" });
}

/** Uploads through the composer's upload path; the host claims it when the profile saves. */
async function uploadPicture(
  environmentId: EnvironmentId,
  file: File,
): Promise<{ readonly attachment: KinAttachment; readonly release: () => void } | null> {
  const image: ComposerImageAttachment = {
    type: "image",
    id: randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: "",
    file,
  };
  startAttachmentUpload({ environmentId, image });
  await awaitAttachmentUploads([image.id]);
  const [uploaded] = getUploadedAttachments({ environmentId, images: [image] }) ?? [];
  if (uploaded === undefined || uploaded.type !== "image") {
    releaseAttachmentUpload(image.id);
    return null;
  }
  const attachment: KinAttachment = {
    type: "image",
    id: uploaded.id,
    name: uploaded.name,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
  };
  return { attachment, release: () => releaseAttachmentUpload(image.id) };
}

/** A sheet over a Kin page; over Settings, a dialog, since a sheet would open under the modal. */
function KinProfileSheet(props: {
  readonly target: KinProfileTarget;
  readonly inDialog: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, orgId, personId } = props.target;
  const profile = useKinProfileOf(environmentId, orgId, personId);
  const navigate = useNavigate();
  const Parts = props.inDialog ? KIN_DIALOG_PARTS : KIN_SHEET_PARTS;
  const params = { environmentId, orgId };
  return (
    <Parts.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Parts.Popup>
        <Parts.Header>
          <Parts.Title>
            {profile.mine
              ? KIN_PROFILE_COPY.mine
              : (profile.profile?.displayName ?? KIN_PROFILE_COPY.title)}
          </Parts.Title>
          {profile.runsWorkspace ? (
            <Parts.Description>{KIN_PROFILE_COPY.runsWorkspace}</Parts.Description>
          ) : null}
          {profile.mine || profile.profile === null ? null : (
            <KinMessageButton target={props.target} />
          )}
        </Parts.Header>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          <KinProfileBody {...props.target} />
          {/* Over Settings, the Team page behind it already lists what they hold. Leaving the
              sheet's address closes it. */}
          {profile.profile === null ||
          !kinProfileShowsTasks({ mine: profile.mine, overTheirTasks: props.inDialog }) ? null : (
            <Field label={KIN_PERSON_TASKS.title}>
              <KinPersonTasks
                environmentId={environmentId}
                orgId={orgId}
                personId={personId}
                onOpenTask={(task) =>
                  void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { task } })
                }
                onSeeAll={() =>
                  void navigate({ to: KIN_PLACE_PATH.tasks, params, search: { person: personId } })
                }
              />
            </Field>
          )}
        </div>
      </Parts.Popup>
    </Parts.Root>
  );
}

/** A teammate's profile opens your chat with them; going there leaves the sheet's address. */
function KinMessageButton(props: { readonly target: KinProfileTarget }) {
  const open = useOpenKinPeopleChat();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1 pt-2">
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setProblem(null);
          const failed = await open(props.target);
          setBusy(false);
          setProblem(failed);
        }}
      >
        <MessageSquareIcon />
        {KIN_PEOPLE_CHAT.message}
      </Button>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

function useKinProfileOf(environmentId: EnvironmentId, orgId: KinOrgId, personId: KinPersonId) {
  const host = useKinHostAt(environmentId);
  const viewer = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  ).personId;
  const result = useKinProfiles(environmentId, orgId);
  const held = result === null ? null : Option.getOrNull(AsyncResult.value(result));
  const profile = held?.profiles.find((entry) => entry.personId === personId) ?? null;
  const holding: KinProfileHolding = {
    companyQuiet: held?.quietHours,
    isOwner: held?.ownerPersonId === personId,
  };
  return {
    result,
    profile,
    viewer,
    holding,
    mine: viewer === personId,
    runsWorkspace: held?.ownerPersonId === personId,
    mayEdit: kinMayEditProfile({
      viewerPersonId: viewer,
      ownerPersonId: held?.ownerPersonId ?? null,
      personId,
      canEdit: profile?.canEdit,
    }),
  };
}

/** Where a row opens the profile's form: the field it lands on. */
type KinProfileFocus = "name" | "tags" | "skills" | "talk" | "hours" | "quiet";

/**
 * Someone's profile as rows, each opening the one form at its field: in the sheet, and as
 * Settings → Profile for your own, where `afterProfile` (your briefs) follows the rows.
 */
export function KinProfileBody(props: KinProfileTarget & { readonly afterProfile?: ReactNode }) {
  const { environmentId, orgId, personId } = props;
  const { result, profile, mine, mayEdit, holding } = useKinProfileOf(
    environmentId,
    orgId,
    personId,
  );
  const ownerLevel = useKinOwnerLevelKnown(environmentId);
  const [editing, setEditing] = useState<KinProfileFocus | null>(null);
  if (profile === null)
    return (
      <KinSettingsSection>
        {result !== null && AsyncResult.isFailure(result) ? (
          <KinSettingsLoadFailed
            onRetry={() =>
              appAtomRegistry.refresh(kinClient.profiles({ environmentId, input: { orgId } }))
            }
          >
            {KIN_PROFILE_COPY.loadFailed}
          </KinSettingsLoadFailed>
        ) : (
          <KinSettingsLoading rows={6} />
        )}
      </KinSettingsSection>
    );
  return (
    <>
      <KinProfileRows
        environmentId={environmentId}
        orgId={orgId}
        profile={profile}
        holding={holding}
        mine={mine}
        mayEdit={mayEdit}
        onEdit={setEditing}
      />
      {editing === null ? null : (
        <KinProfileForm
          environmentId={environmentId}
          orgId={orgId}
          profile={profile}
          mine={mine}
          holding={holding}
          focus={editing}
          onDone={() => setEditing(null)}
        />
      )}
      {props.afterProfile}
      {/* The owner's own devices are T3 Code pairings, managed in its settings. */}
      {mine && !holding.isOwner ? (
        <KinMyDevices environmentId={environmentId} orgId={orgId} personId={personId} />
      ) : null}
      {mine || ownerLevel === true ? (
        <KinTasksKeysSection
          environmentId={environmentId}
          orgId={orgId}
          personId={profile.personId}
          holder={mine ? null : profile.displayName}
        />
      ) : null}
    </>
  );
}

/** The viewer's own person here, once the host has said who they are. */
export function useKinMe(environmentId: EnvironmentId, orgId: KinOrgId): KinPersonId | null {
  const host = useKinHostAt(environmentId);
  return kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  ).personId;
}

function Field(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      {props.children}
    </section>
  );
}

function KinProfileRows(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly mine: boolean;
  readonly profile: KinPersonProfile;
  readonly holding: KinProfileHolding;
  readonly mayEdit: boolean;
  readonly onEdit: (focus: KinProfileFocus) => void;
}) {
  const { profile, mine, mayEdit } = props;
  const hours = kinHoursLine(profile.workHours);
  // Your own settings are where the app's settings search lands.
  const found = (id: KinProfileSearchId) => (mine ? { searchId: id } : {});
  // How you're spoken to and when Kin holds messages are only yours to change.
  const opens = (focus: KinProfileFocus, what: string, value: string) =>
    mayEdit && (mine || (focus !== "talk" && focus !== "quiet"))
      ? {
          openLabel: `${KIN_PROFILE_COPY.editOf(what)}: ${value}`,
          onOpen: () => props.onEdit(focus),
        }
      : {};
  const row = (
    focus: KinProfileFocus,
    title: string,
    value: string,
    searchId?: KinProfileSearchId,
  ) => (
    <KinSettingsRow
      title={title}
      detail={value}
      {...(searchId === undefined ? {} : found(searchId))}
      {...opens(focus, title, value)}
    />
  );
  const awayShows = mayEdit || kinAwayLine(profile, { mine }) !== null;
  return (
    <KinSettingsSection>
      <KinSettingsRow
        leading={
          <KinAvatar avatar={{ kind: "person", seed: kinPersonSeed(profile.personId) }} size="sm" />
        }
        title={profile.displayName}
        {...opens("name", KIN_PROFILE_COPY.nameLabel, profile.displayName)}
      />
      {row(
        "tags",
        KIN_PROFILE_COPY.tagsLabel,
        profile.roleTags.length === 0 ? KIN_PROFILE_COPY.rowEmpty : profile.roleTags.join(", "),
      )}
      {row(
        "skills",
        KIN_PROFILE_COPY.skillsLabel,
        profile.skills === "" ? KIN_PROFILE_COPY.rowEmpty : profile.skills,
      )}
      {row(
        "talk",
        KIN_PROFILE_COPY.talkLabel,
        (profile.talkStyle ?? "") === "" ? KIN_PROFILE_COPY.rowEmpty : (profile.talkStyle ?? ""),
      )}
      {row(
        "hours",
        KIN_PROFILE_COPY.hoursLabel,
        hours === null
          ? KIN_PROFILE_COPY.rowEmpty
          : `${hours}${profile.timeZone === null ? "" : `, ${kinZoneLabel(profile.timeZone)}`}`,
        "kin-working-hours",
      )}
      {row(
        "quiet",
        KIN_PROFILE_COPY.quietLabel,
        kinQuietLine(profile, props.holding),
        "kin-quiet-hours",
      )}
      {awayShows ? (
        <KinAwayRow
          environmentId={props.environmentId}
          orgId={props.orgId}
          profile={profile}
          mine={mine}
          mayEdit={mayEdit}
          {...found("kin-away")}
        />
      ) : null}
      {profile.githubLogin === undefined ? null : (
        <KinGithubLoginRow
          environmentId={props.environmentId}
          orgId={props.orgId}
          profile={profile}
          mine={mine}
          {...found("kin-github-username")}
        />
      )}
    </KinSettingsSection>
  );
}

const timeZones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

/** A picture picked in the form: uploaded already, claimed by the host only when the form saves. */
interface PickedPicture {
  readonly attachment: KinAttachment;
  readonly release: () => void;
  readonly preview: string;
}

function KinProfileForm(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  /** Only the person says how they like to be spoken to, and when Kin holds messages for them. */
  readonly mine: boolean;
  readonly holding: KinProfileHolding;
  readonly focus: KinProfileFocus;
  readonly onDone: () => void;
}) {
  const { environmentId, orgId, profile } = props;
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [opened] = useState<KinProfileDraft>(() => kinProfileDraft(profile, props.holding));
  const [draft, setDraft] = useState(opened);
  const [busy, setBusy] = useState<"saving" | "picture" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Undefined keeps the picture; null takes it away.
  const [picture, setPicture] = useState<PickedPicture | null | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const set = (change: Partial<KinProfileDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const drop = (kept: PickedPicture | null | undefined) => {
    if (kept == null) return;
    kept.release();
    URL.revokeObjectURL(kept.preview);
  };

  const save = async () => {
    const changes = kinProfileChanges(profile, draft, { ...props.holding, mine: props.mine });
    if (!changes.ok) return setProblem(changes.problem);
    const input = {
      orgId,
      personId: profile.personId,
      ...changes.changes,
      ...(picture === undefined ? {} : { picture: picture?.attachment ?? null }),
    };
    if (Object.keys(input).length === 2) return props.onDone();
    setBusy("saving");
    setProblem(null);
    const outcome = await update({ environmentId, input });
    setBusy(null);
    if (!AsyncResult.isSuccess(outcome))
      return setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_PROFILE_COPY.failed));
    if (picture != null) URL.revokeObjectURL(picture.preview);
    props.onDone();
  };

  const choosePicture = async (file: File | undefined) => {
    if (file === undefined) return;
    setBusy("picture");
    setProblem(null);
    const resized = await pictureFile(file);
    const uploaded = resized === null ? null : await uploadPicture(environmentId, resized);
    setBusy(null);
    if (resized === null || uploaded === null) return setProblem(KIN_PROFILE_COPY.pictureFailed);
    drop(picture);
    setPicture({ ...uploaded, preview: URL.createObjectURL(resized) });
  };

  const shownPicture = picture === undefined ? profile.pictureId !== null : picture !== null;
  return (
    <KinSettingsFormDialog
      title={KIN_PROFILE_COPY.edit}
      submitLabel={KIN_PROFILE_COPY.saveProfile}
      openAt={props.focus}
      busy={busy !== null}
      problem={problem}
      typed={picture !== undefined || kinFormTyped(opened, draft)}
      onSubmit={() => void save()}
      onClose={() => {
        drop(picture);
        props.onDone();
      }}
    >
      <KinSettingsField label={KIN_PROFILE_COPY.pictureLabel}>
        {(ids) => (
          <div role="group" aria-labelledby={ids.label} className="flex items-center gap-4">
            {picture == null ? (
              picture === null ? (
                <Blobatar name={kinPersonSeed(profile.personId)} size={72} alt="" />
              ) : (
                <KinAvatar
                  avatar={{ kind: "person", seed: kinPersonSeed(profile.personId) }}
                  size="lg"
                />
              )
            ) : (
              <img
                src={picture.preview}
                alt=""
                width={72}
                height={72}
                className="size-18 rounded-full object-cover"
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                aria-busy={busy === "picture"}
                onClick={() => picker.current?.click()}
              >
                {busy === "picture"
                  ? "Uploading…"
                  : shownPicture
                    ? KIN_PROFILE_COPY.pictureChange
                    : KIN_PROFILE_COPY.pictureAdd}
              </Button>
              {shownPicture ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    drop(picture);
                    setPicture(null);
                  }}
                >
                  {KIN_PROFILE_COPY.pictureRemove}
                </Button>
              ) : null}
              <input
                ref={picker}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  void choosePicture(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
        )}
      </KinSettingsField>
      <KinSettingsField name="name" label={KIN_PROFILE_COPY.nameLabel}>
        {(ids) => (
          <Input
            id={ids.control}
            value={draft.displayName}
            maxLength={KIN_PROFILE_NAME_MAX}
            onChange={(event) => set({ displayName: event.target.value })}
          />
        )}
      </KinSettingsField>
      <KinSettingsField
        name="tags"
        label={KIN_PROFILE_COPY.tagsLabel}
        help={KIN_PROFILE_COPY.tagsHint}
      >
        {(ids) => (
          <Input
            id={ids.control}
            value={draft.tags}
            onChange={(event) => set({ tags: event.target.value })}
          />
        )}
      </KinSettingsField>
      <KinSettingsField
        name="skills"
        label={KIN_PROFILE_COPY.skillsLabel}
        help={KIN_PROFILE_COPY.skillsHint}
      >
        {(ids) => (
          <Textarea
            id={ids.control}
            value={draft.skills}
            maxLength={KIN_PROFILE_SKILLS_MAX}
            placeholder={KIN_PROFILE_COPY.skillsExample}
            onChange={(event) => set({ skills: event.target.value })}
          />
        )}
      </KinSettingsField>
      {props.mine ? (
        <KinSettingsField
          name="talk"
          label={KIN_PROFILE_COPY.talkLabel}
          help={KIN_PROFILE_COPY.talkHint}
        >
          {(ids) => (
            <Textarea
              id={ids.control}
              value={draft.talkStyle}
              maxLength={KIN_PROFILE_TALK_MAX}
              onChange={(event) => set({ talkStyle: event.target.value })}
            />
          )}
        </KinSettingsField>
      ) : null}
      <KinSettingsField name="hours" label={KIN_PROFILE_COPY.hoursLabel}>
        {(ids) => (
          <div role="group" aria-labelledby={ids.label} className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {KIN_DAY_LABELS.map((label, day) => (
                <Toggle
                  key={label}
                  size="sm"
                  variant="outline"
                  pressed={draft.days.includes(day)}
                  onPressedChange={(pressed) =>
                    set({
                      days: pressed
                        ? [...draft.days, day]
                        : draft.days.filter((held) => held !== day),
                    })
                  }
                >
                  {label}
                </Toggle>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                id={ids.control}
                type="time"
                aria-label="Starts"
                value={draft.start}
                disabled={draft.days.length === 0}
                onChange={(event) => set({ start: event.target.value })}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="time"
                aria-label="Ends"
                value={draft.end}
                disabled={draft.days.length === 0}
                onChange={(event) => set({ end: event.target.value })}
              />
            </div>
          </div>
        )}
      </KinSettingsField>
      <KinSettingsField label={KIN_PROFILE_COPY.timeZoneLabel}>
        {(ids) => (
          <>
            <Input
              id={ids.control}
              list={`${ids.control}-zones`}
              value={draft.timeZone}
              placeholder={KIN_TIME_ZONE_PLACEHOLDER}
              onChange={(event) => set({ timeZone: event.target.value })}
            />
            <datalist id={`${ids.control}-zones`}>
              {timeZones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </>
        )}
      </KinSettingsField>
      {props.mine ? (
        <KinSettingsField
          name="quiet"
          label={KIN_PROFILE_COPY.quietLabel}
          help={KIN_PROFILE_COPY.quietHint}
        >
          {(ids) => (
            <div role="group" aria-labelledby={ids.label} className="flex items-center gap-2">
              <Input
                id={ids.control}
                type="time"
                aria-label="Quiet from"
                value={draft.quietFrom}
                onChange={(event) => set({ quietFrom: event.target.value })}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="time"
                aria-label="Quiet until"
                value={draft.quietTo}
                onChange={(event) => set({ quietTo: event.target.value })}
              />
            </div>
          )}
        </KinSettingsField>
      ) : null}
      {props.mine ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="kin-profile-hold">{KIN_PROFILE_COPY.holdLabel}</Label>
            <p className="text-xs text-muted-foreground">{KIN_PROFILE_COPY.holdHint}</p>
          </div>
          <Switch
            id="kin-profile-hold"
            checked={draft.holdOutside}
            onCheckedChange={(checked) => set({ holdOutside: checked })}
          />
        </div>
      ) : null}
    </KinSettingsFormDialog>
  );
}
