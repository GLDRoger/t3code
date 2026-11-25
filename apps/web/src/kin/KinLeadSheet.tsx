import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_FAILED,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
} from "@t3tools/client-runtime/kin/kinClearChat";
import { kinRetiredWhen } from "@t3tools/client-runtime/kin/kinAgentRetire";
import {
  kinDomainLabel,
  kinLeadContactAbout,
  kinLeadOwnerSeesLine,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinChatId, KinLeadContact, KinLeadProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";
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
import { Label } from "../components/ui/label";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAgentDetails } from "./KinAgentPage";
import { KinAvatar } from "./KinAvatar";
import { openKinSettings } from "./kinSettingsAddress";
import { kinClient } from "./kinClient";
import { KinPinSwitch } from "./KinPinSwitch";
import { useKinWorkingAgents } from "./useKinHost";
import { announceKinClearKept, useKinClearPreview } from "./useKinClearPreview";
import { useNowMinuteMs } from "./useKinClock";

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
  readonly muted: boolean;
  /** The viewer's pin on this chat; null where none is offered, as on the main agent's chat. */
  readonly pinned: boolean | null;
  /** The viewer is the one person in this chat, so it is theirs to clear. */
  readonly ownsChat: boolean;
  /** How many of the viewer's own agents are active: the last one can't be retired. */
  readonly activeAgents: number;
}) {
  const { about, environmentId } = props;
  const router = useRouter();
  const nowMs = useNowMinuteMs();
  const retired = about.kind === "own" ? about.lead.retired : undefined;
  const canMute = useAtomValue(kinClient.mute.permissionAtom(environmentId));
  const working = useKinWorkingAgents(
    environmentId,
    about.kind === "own" ? about.lead.orgId : about.contact.orgId,
  );
  const mute = useAtomCommand(kinClient.mute, { reportFailure: false });
  const [muteState, setMuteState] = useState<"idle" | "saving" | "failed">("idle");
  const [muteProblem, setMuteProblem] = useState<string | null>(null);
  const muteId = useId();
  // The host decides again on the call; this only hides what it would refuse.
  const canClear = useAtomValue(kinClient.clear.permissionAtom(environmentId)) && props.ownsChat;
  const clear = useAtomCommand(kinClient.clear, { reportFailure: false });
  const [clearState, setClearState] = useState<"idle" | "confirm" | "clearing" | "failed">("idle");
  const [clearProblem, setClearProblem] = useState("");

  const setMuted = async (muted: boolean) => {
    setMuteState("saving");
    const result = await mute({ environmentId, input: { chatId: props.chatId, muted } });
    setMuteProblem(
      AsyncResult.isFailure(result)
        ? kinFailureText(squashAtomCommandFailure(result), KIN_AGENT_PAGE.changeFailed)
        : null,
    );
    setMuteState(AsyncResult.isFailure(result) ? "failed" : "idle");
  };

  const clearPreview = useKinClearPreview(environmentId, props.chatId);

  const clearChat = async () => {
    setClearState("clearing");
    const result = await clear({ environmentId, input: { chatId: props.chatId } });
    if (!AsyncResult.isSuccess(result)) {
      setClearProblem(kinFailureText(squashAtomCommandFailure(result), KIN_CLEAR_CHAT_FAILED));
      return setClearState("failed");
    }
    setClearState("idle");
    // The chat behind the sheet is empty; only files a doc kept need saying.
    announceKinClearKept(result.value.keptFiles);
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
                  {retired !== undefined
                    ? ` · ${kinRetiredWhen(retired.at, nowMs)}`
                    : about.lead.paused !== undefined
                      ? " · Paused"
                      : working.has(about.lead.agentId)
                        ? " · Working now"
                        : ""}
                </SheetDescription>
              ) : null}
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          {about.kind === "own" ? (
            <KinAgentDetails
              environmentId={environmentId}
              orgId={about.lead.orgId}
              agentId={about.lead.agentId}
              activeAgents={props.activeAgents}
              onClose={() => props.onOpenChange(false)}
              onOpenSettings={(section) => {
                props.onOpenChange(false);
                openKinSettings(router.history, section);
              }}
            />
          ) : (
            <Section title="About">
              <p className="whitespace-pre-line text-sm text-foreground">
                {kinLeadContactAbout(about.contact)}
              </p>
              <p className="text-xs text-muted-foreground">
                {kinLeadOwnerSeesLine(about.contact.ownerName)}
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
                  {muteProblem}
                </p>
              ) : null}
              {props.pinned === null ? null : (
                <KinPinSwitch
                  environmentId={environmentId}
                  chatId={props.chatId}
                  pinned={props.pinned}
                />
              )}
            </Section>
          ) : null}
          {canClear ? (
            <Section title="Chat">
              <Button
                size="sm"
                variant="destructive-outline"
                className="self-start"
                disabled={clearState === "clearing"}
                onClick={() => {
                  clearPreview.ask();
                  setClearState("confirm");
                }}
              >
                {KIN_CLEAR_CHAT_ACTION}
              </Button>
              {clearState === "failed" ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {clearProblem}
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
              {kinClearChatBody(about.kind === "own" ? about.lead.name : null, clearPreview.kept)}
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
