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
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinZoneLabel } from "@t3tools/client-runtime/kin/kinTimeZone";
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
import { useEffect, useRef, useState } from "react";

import { Badge } from "../components/ui/badge";
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
import { KinAwayField } from "./KinAway";
import { KinGithubLoginField } from "./KinGithubLogin";
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
            <Parts.Description>Runs this workspace</Parts.Description>
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

/** Someone's profile, read or edited: in the sheet, and as Settings → Profile for your own. */
export function KinProfileBody(props: KinProfileTarget) {
  const { environmentId, orgId, personId } = props;
  const { result, profile, mine, mayEdit, holding } = useKinProfileOf(
    environmentId,
    orgId,
    personId,
  );
  const [editing, setEditing] = useState(false);
  if (profile === null)
    return (
      <p className="text-sm text-muted-foreground">
        {result !== null && AsyncResult.isFailure(result)
          ? KIN_PROFILE_COPY.loadFailed
          : "Loading…"}
      </p>
    );
  return editing ? (
    <KinProfileForm
      environmentId={environmentId}
      orgId={orgId}
      profile={profile}
      mine={mine}
      holding={holding}
      onDone={() => setEditing(false)}
    />
  ) : (
    <>
      <KinProfileRead
        environmentId={environmentId}
        orgId={orgId}
        profile={profile}
        holding={holding}
        mine={mine}
        mayEdit={mayEdit}
        onEdit={() => setEditing(true)}
      />
      {/* The owner's own devices are T3 Code pairings, managed in its settings. */}
      {mine && !holding.isOwner ? (
        <KinMyDevices environmentId={environmentId} orgId={orgId} personId={personId} />
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

function Field(props: {
  readonly label: string;
  readonly target?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      id={props.target}
      tabIndex={props.target === undefined ? undefined : -1}
      className="flex flex-col gap-1"
    >
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      {props.children}
    </section>
  );
}

function KinProfileRead(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly mine: boolean;
  readonly profile: KinPersonProfile;
  readonly holding: KinProfileHolding;
  readonly mayEdit: boolean;
  readonly onEdit: () => void;
}) {
  const { profile } = props;
  const hours = kinHoursLine(profile.workHours);
  // Your own settings are where the app's settings search lands.
  const mineTarget = (id: KinProfileSearchId) => (props.mine ? id : undefined);
  const ownerLevel = useKinOwnerLevelKnown(props.environmentId);
  return (
    <>
      <div className="flex items-center gap-4">
        <KinAvatar avatar={{ kind: "person", seed: kinPersonSeed(profile.personId) }} size="lg" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="truncate text-lg font-medium text-foreground">{profile.displayName}</p>
          {profile.roleTags.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_PROFILE_COPY.noTags}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {profile.roleTags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
      <Field label={KIN_PROFILE_COPY.skillsLabel}>
        <p className="whitespace-pre-wrap text-sm text-foreground">
          {profile.skills === "" ? (
            <span className="text-muted-foreground">{KIN_PROFILE_COPY.noSkills}</span>
          ) : (
            profile.skills
          )}
        </p>
      </Field>
      <Field label={KIN_PROFILE_COPY.talkLabel}>
        <p className="whitespace-pre-wrap text-sm text-foreground">
          {(props.profile.talkStyle ?? "") === "" ? (
            <span className="text-muted-foreground">{KIN_PROFILE_COPY.noTalk}</span>
          ) : (
            props.profile.talkStyle
          )}
        </p>
      </Field>
      <Field label={KIN_PROFILE_COPY.hoursLabel} target={mineTarget("kin-working-hours")}>
        <p className="text-sm text-foreground">
          {hours === null ? (
            <span className="text-muted-foreground">{KIN_PROFILE_COPY.noHours}</span>
          ) : (
            `${hours}${profile.timeZone === null ? "" : `, ${kinZoneLabel(profile.timeZone)}`}`
          )}
        </p>
      </Field>
      <KinAwayField
        environmentId={props.environmentId}
        orgId={props.orgId}
        profile={profile}
        mine={props.mine}
        mayEdit={props.mayEdit}
        target={mineTarget("kin-away")}
      />
      <Field label={KIN_PROFILE_COPY.quietLabel} target={mineTarget("kin-quiet-hours")}>
        <p className="text-sm text-foreground">{kinQuietLine(profile, props.holding)}</p>
      </Field>
      <KinGithubLoginField
        environmentId={props.environmentId}
        orgId={props.orgId}
        profile={profile}
        mine={props.mine}
        target={mineTarget("kin-github-username")}
      />
      {props.mayEdit ? (
        <Button variant="outline" className="self-start" onClick={props.onEdit}>
          {KIN_PROFILE_COPY.edit}
        </Button>
      ) : null}
      {props.mine || ownerLevel === true ? (
        <KinTasksKeysSection
          environmentId={props.environmentId}
          orgId={props.orgId}
          personId={profile.personId}
          holder={props.mine ? null : profile.displayName}
        />
      ) : null}
    </>
  );
}

const timeZones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

function KinProfileForm(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  /** Only the person says how they like to be spoken to, and when Kin holds messages for them. */
  readonly mine: boolean;
  readonly holding: KinProfileHolding;
  readonly onDone: () => void;
}) {
  const { environmentId, orgId, profile } = props;
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [draft, setDraft] = useState<KinProfileDraft>(() =>
    kinProfileDraft(profile, props.holding),
  );
  const [busy, setBusy] = useState<"saving" | "picture" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const set = (change: Partial<KinProfileDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const save = async (picture?: KinAttachment | null) => {
    const changes = kinProfileChanges(profile, draft, { ...props.holding, mine: props.mine });
    if (!changes.ok) return setProblem(changes.problem);
    const input = {
      orgId,
      personId: profile.personId,
      ...changes.changes,
      ...(picture === undefined ? {} : { picture }),
    };
    if (Object.keys(input).length === 2) return props.onDone();
    setBusy("saving");
    setProblem(null);
    const outcome = await update({ environmentId, input });
    setBusy(null);
    if (AsyncResult.isSuccess(outcome)) props.onDone();
    else setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_PROFILE_COPY.failed));
  };

  const choosePicture = async (file: File | undefined) => {
    if (file === undefined) return;
    setBusy("picture");
    setProblem(null);
    const resized = await pictureFile(file);
    const uploaded = resized === null ? null : await uploadPicture(environmentId, resized);
    if (uploaded === null) {
      setBusy(null);
      return setProblem(KIN_PROFILE_COPY.pictureFailed);
    }
    const outcome = await update({
      environmentId,
      input: { orgId, personId: profile.personId, picture: uploaded.attachment },
    });
    setBusy(null);
    if (!AsyncResult.isSuccess(outcome)) {
      uploaded.release();
      setProblem(KIN_PROFILE_COPY.pictureFailed);
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-4">
        <KinAvatar avatar={{ kind: "person", seed: kinPersonSeed(profile.personId) }} size="lg" />
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
              : profile.pictureId === null
                ? KIN_PROFILE_COPY.pictureAdd
                : KIN_PROFILE_COPY.pictureChange}
          </Button>
          {profile.pictureId === null ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void update({
                  environmentId,
                  input: { orgId, personId: profile.personId, picture: null },
                })
              }
            >
              {KIN_PROFILE_COPY.pictureRemove}
            </Button>
          )}
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kin-profile-name">{KIN_PROFILE_COPY.nameLabel}</Label>
        <Input
          id="kin-profile-name"
          value={draft.displayName}
          maxLength={KIN_PROFILE_NAME_MAX}
          onChange={(event) => set({ displayName: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kin-profile-tags">{KIN_PROFILE_COPY.tagsLabel}</Label>
        <Input
          id="kin-profile-tags"
          value={draft.tags}
          onChange={(event) => set({ tags: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">{KIN_PROFILE_COPY.tagsHint}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kin-profile-skills">{KIN_PROFILE_COPY.skillsLabel}</Label>
        <Textarea
          id="kin-profile-skills"
          value={draft.skills}
          maxLength={KIN_PROFILE_SKILLS_MAX}
          placeholder={KIN_PROFILE_COPY.skillsExample}
          onChange={(event) => set({ skills: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">{KIN_PROFILE_COPY.skillsHint}</p>
      </div>
      {props.mine ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kin-profile-talk">{KIN_PROFILE_COPY.talkLabel}</Label>
          <Textarea
            id="kin-profile-talk"
            value={draft.talkStyle}
            maxLength={KIN_PROFILE_TALK_MAX}
            onChange={(event) => set({ talkStyle: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">{KIN_PROFILE_COPY.talkHint}</p>
        </div>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium text-foreground">
          {KIN_PROFILE_COPY.hoursLabel}
        </legend>
        <div className="flex flex-wrap gap-1">
          {KIN_DAY_LABELS.map((label, day) => (
            <Toggle
              key={label}
              size="sm"
              variant="outline"
              pressed={draft.days.includes(day)}
              onPressedChange={(pressed) =>
                set({
                  days: pressed ? [...draft.days, day] : draft.days.filter((held) => held !== day),
                })
              }
            >
              {label}
            </Toggle>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
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
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kin-profile-zone">{KIN_PROFILE_COPY.timeZoneLabel}</Label>
        <Input
          id="kin-profile-zone"
          list="kin-profile-zones"
          value={draft.timeZone}
          placeholder="City or region"
          onChange={(event) => set({ timeZone: event.target.value })}
        />
        <datalist id="kin-profile-zones">
          {timeZones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>
      {props.mine ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-foreground">
            {KIN_PROFILE_COPY.quietLabel}
          </legend>
          <div className="flex items-center gap-2">
            <Input
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
          <p className="text-xs text-muted-foreground">{KIN_PROFILE_COPY.quietHint}</p>
          <div className="mt-2 flex items-start gap-3">
            <Switch
              id="kin-profile-hold"
              checked={draft.holdOutside}
              onCheckedChange={(checked) => set({ holdOutside: checked })}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="kin-profile-hold">{KIN_PROFILE_COPY.holdLabel}</Label>
              <p className="text-xs text-muted-foreground">{KIN_PROFILE_COPY.holdHint}</p>
            </div>
          </div>
        </fieldset>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy !== null} aria-busy={busy === "saving"}>
          {busy === "saving" ? KIN_PROFILE_COPY.saving : KIN_PROFILE_COPY.save}
        </Button>
        <Button type="button" variant="ghost" disabled={busy !== null} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
