import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_FAILED,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
} from "@t3tools/client-runtime/kin/kinClearChat";
import {
  kinDomainLabel,
  kinLeadAccessCandidates,
  kinLeadAccessChanged,
  kinLeadAccessProblem,
  kinLeadModelName,
  kinLeadTrackingDetail,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinChatId,
  KinLeadAccessResult,
  KinLeadContact,
  KinLeadProfile,
  KinPersonId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Label } from "../components/ui/label";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Switch } from "../components/ui/switch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { serverEnvironment } from "../state/server";
import { kinLeadFormAtom } from "./kinLeadForm";

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** Whose lead the sheet is about: the viewer's own, or someone else's they may message. */
export type KinLeadAbout =
  | { readonly kind: "own"; readonly lead: KinLeadProfile }
  | { readonly kind: "contact"; readonly contact: KinLeadContact };

/**
 * A lead beside its chat. Its owner sees what it is for, what it has in hand and who else can
 * message it; someone it was shared with sees its name and what its owner wrote for them.
 */
export function KinLeadSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly about: KinLeadAbout;
  readonly avatar: KinAvatarView;
  readonly environmentId: EnvironmentId;
  readonly chatId: KinChatId;
  readonly personId: string | null;
  readonly muted: boolean;
  /** The viewer is the one person in this chat, so it is theirs to clear. */
  readonly ownsChat: boolean;
}) {
  const { about, environmentId } = props;
  const canMute = useAtomValue(kinClient.mute.permissionAtom(environmentId));
  const mute = useAtomCommand(kinClient.mute, { reportFailure: false });
  const [muteState, setMuteState] = useState<"idle" | "saving" | "failed">("idle");
  const muteId = useId();
  // The host decides again on the call; this only hides what it would refuse.
  const canClear = useAtomValue(kinClient.clear.permissionAtom(environmentId)) && props.ownsChat;
  const clear = useAtomCommand(kinClient.clear, { reportFailure: false });
  const [clearState, setClearState] = useState<"idle" | "confirm" | "clearing" | "failed">("idle");

  const setMuted = async (muted: boolean) => {
    setMuteState("saving");
    const result = await mute({ environmentId, input: { chatId: props.chatId, muted } });
    setMuteState(AsyncResult.isFailure(result) ? "failed" : "idle");
  };

  const clearChat = async () => {
    setClearState("clearing");
    const result = await clear({ environmentId, input: { chatId: props.chatId } });
    if (AsyncResult.isFailure(result)) return setClearState("failed");
    setClearState("idle");
    // Nothing to announce: the chat behind the sheet is empty.
    props.onOpenChange(false);
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <div className="flex items-center gap-3 pe-8">
            <KinAvatar avatar={props.avatar} />
            <div className="flex min-w-0 flex-col">
              <SheetTitle>{about.kind === "own" ? about.lead.name : about.contact.name}</SheetTitle>
              {about.kind === "own" ? (
                <SheetDescription>
                  {kinDomainLabel(about.lead.domain)}
                  {about.lead.working ? " · Working now" : ""}
                </SheetDescription>
              ) : null}
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          {about.kind === "own" ? (
            <KinOwnLead
              lead={about.lead}
              environmentId={environmentId}
              personId={props.personId}
              onClose={() => props.onOpenChange(false)}
            />
          ) : (
            <Section title="About">
              <p className="whitespace-pre-line text-sm text-foreground">
                {about.contact.intro.trim() === ""
                  ? `Message ${about.contact.name} here like a colleague.`
                  : about.contact.intro}
              </p>
            </Section>
          )}
          {canMute ? (
            <Section title="Notifications">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={muteId}>Mute this chat</Label>
                <Switch
                  id={muteId}
                  checked={props.muted}
                  disabled={muteState === "saving"}
                  onCheckedChange={(checked) => void setMuted(checked)}
                />
              </div>
              {muteState === "failed" ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  Couldn't change that. Try again.
                </p>
              ) : null}
            </Section>
          ) : null}
          {canClear ? (
            <Section title="Chat">
              <Button
                size="sm"
                variant="destructive-outline"
                className="self-start"
                disabled={clearState === "clearing"}
                onClick={() => setClearState("confirm")}
              >
                {KIN_CLEAR_CHAT_ACTION}
              </Button>
              {clearState === "failed" ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {KIN_CLEAR_CHAT_FAILED}
                </p>
              ) : null}
            </Section>
          ) : null}
        </div>
      </SheetPopup>
      <AlertDialog
        open={clearState === "confirm"}
        onOpenChange={(open) => {
          if (!open) setClearState((held) => (held === "confirm" ? "idle" : held));
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_CLEAR_CHAT_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>
              {kinClearChatBody(about.kind === "own" ? about.lead.name : about.contact.name)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void clearChat()}>
              {KIN_CLEAR_CHAT_ACTION}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Sheet>
  );
}

function KinOwnLead(props: {
  readonly lead: KinLeadProfile;
  readonly environmentId: EnvironmentId;
  readonly personId: string | null;
  readonly onClose: () => void;
}) {
  const { lead, environmentId } = props;
  const canEdit = useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId));
  const canShare = useAtomValue(kinClient.leadAllow.permissionAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return (
    <>
      <Section title="Responsible for">
        <p className="whitespace-pre-line text-sm text-foreground">
          {lead.charter.trim() === "" ? "Nothing written yet." : lead.charter}
        </p>
        {canEdit ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => {
              props.onClose();
              appAtomRegistry.set(kinLeadFormAtom, { environmentId, orgId: lead.orgId, lead });
            }}
          >
            Edit lead
          </Button>
        ) : null}
      </Section>
      {canShare ? (
        <KinLeadAccess lead={lead} environmentId={environmentId} personId={props.personId} />
      ) : null}
      <Section title="In hand">
        {lead.tracking.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in hand right now.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lead.tracking.map((item, index) => (
              // Titles can repeat and items carry no id; the host's order is stable.
              // oxlint-disable-next-line react/no-array-index-key
              <li key={index} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{kinLeadTrackingDetail(item)}</span>
                <span className="text-sm text-foreground">{item.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Model">
        <p className="text-sm text-foreground">{kinLeadModelName(lead.model, providers)}</p>
      </Section>
    </>
  );
}

type AccessPerson = KinLeadAccessResult["people"][number];

/** Who besides the owner can message this lead, and the way to add or remove a person. */
function KinLeadAccess(props: {
  readonly lead: KinLeadProfile;
  readonly environmentId: EnvironmentId;
  readonly personId: string | null;
}) {
  const { lead, environmentId } = props;
  const target = { orgId: lead.orgId, agentId: lead.agentId };
  const accessAtom = kinClient.leadAccess({ environmentId, input: target });
  const access = useAtomValue(accessAtom);
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId: lead.orgId } }));
  const allow = useAtomCommand(kinClient.leadAllow, { reportFailure: false });
  const disallow = useAtomCommand(kinClient.leadDisallow, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [removing, setRemoving] = useState<AccessPerson | null>(null);
  // What was last read stays up while a change is read again.
  const allowed = Option.getOrNull(AsyncResult.value(access))?.people ?? null;
  const candidates = kinLeadAccessCandidates(
    Option.getOrNull(AsyncResult.value(people))?.people ?? [],
    allowed ?? [],
    props.personId,
  );

  const change = async (
    person: { readonly personId: KinPersonId; readonly displayName: string },
    on: boolean,
  ) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const input = { ...target, personId: person.personId };
    const result = await (on ? allow : disallow)({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      appAtomRegistry.refresh(accessAtom);
      setNote({ text: kinLeadAccessChanged(person.displayName, lead.name, on), failed: false });
      return;
    }
    setNote({
      text: kinLeadAccessProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
      ),
      failed: true,
    });
  };

  return (
    <Section title="Who can message">
      {allowed === null ? (
        <p className="text-sm text-muted-foreground">
          {AsyncResult.isFailure(access) ? "Couldn't load who can message it." : "Loading…"}
        </p>
      ) : allowed.length === 0 ? (
        <p className="text-sm text-muted-foreground">Only you.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {allowed.map((person) => (
            <li key={person.personId} className="flex min-h-9 items-center gap-3">
              <KinAvatar avatar={{ kind: "person", seed: `person:${person.personId}` }} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {person.displayName}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${person.displayName}`}
                onClick={() => setRemoving(person)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {allowed === null || allowed.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {(lead.intro ?? "").trim() === ""
            ? "They see its name only. Add what teammates see in Edit lead."
            : `They see its name and this: ${(lead.intro ?? "").trim()}`}
        </p>
      )}
      {note === null ? null : (
        <p
          role={note.failed ? "alert" : "status"}
          className={
            note.failed ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
          }
        >
          {note.text}
        </p>
      )}
      {candidates.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            render={<Button size="sm" variant="outline" className="self-start" disabled={busy} />}
          >
            Add a person
          </MenuTrigger>
          <MenuPopup align="start">
            {candidates.map((person) => (
              <MenuItem key={person.personId} onClick={() => void change(person, true)}>
                {person.displayName}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.displayName} keeps their chat with {lead.name} to read, but can't send it
              anything more. You can add them back any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const person = removing;
                setRemoving(null);
                if (person !== null) void change(person, false);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Section>
  );
}
