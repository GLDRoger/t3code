import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_FAILED,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
} from "@t3tools/client-runtime/kin/kinClearChat";
import {
  kinDomainLabel,
  kinLeadModelName,
  kinLeadTrackingDetail,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import type { EnvironmentId, KinChatId, KinLeadProfile } from "@t3tools/contracts";
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

/** A lead's profile beside its chat: who it is, what it is for, what it has in hand. */
export function KinLeadSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly lead: KinLeadProfile;
  readonly avatar: KinAvatarView;
  readonly environmentId: EnvironmentId;
  readonly chatId: KinChatId;
  readonly muted: boolean;
  /** The viewer is the one person in this chat, so it is theirs to clear. */
  readonly ownsChat: boolean;
}) {
  const { lead, environmentId } = props;
  const canEdit = useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId));
  const canMute = useAtomValue(kinClient.mute.permissionAtom(environmentId));
  const mute = useAtomCommand(kinClient.mute, { reportFailure: false });
  const [muteState, setMuteState] = useState<"idle" | "saving" | "failed">("idle");
  const muteId = useId();
  // The host decides again on the call; this only hides what it would refuse.
  const canClear = useAtomValue(kinClient.clear.permissionAtom(environmentId)) && props.ownsChat;
  const clear = useAtomCommand(kinClient.clear, { reportFailure: false });
  const [clearState, setClearState] = useState<"idle" | "confirm" | "clearing" | "failed">("idle");
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));

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
              <SheetTitle>{lead.name}</SheetTitle>
              <SheetDescription>
                {kinDomainLabel(lead.domain)}
                {lead.working ? " · Working now" : ""}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
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
                  props.onOpenChange(false);
                  appAtomRegistry.set(kinLeadFormAtom, {
                    environmentId,
                    orgId: lead.orgId,
                    lead,
                  });
                }}
              >
                Edit lead
              </Button>
            ) : null}
          </Section>
          <Section title="In hand">
            {lead.tracking.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing in hand right now.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {lead.tracking.map((item, index) => (
                  // Titles can repeat and items carry no id; the host's order is stable.
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={index} className="flex flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      {kinLeadTrackingDetail(item)}
                    </span>
                    <span className="text-sm text-foreground">{item.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Model">
            <p className="text-sm text-foreground">{kinLeadModelName(lead.model, providers)}</p>
          </Section>
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
            <AlertDialogDescription>{kinClearChatBody(lead.name)}</AlertDialogDescription>
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
