import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CLEAR_CHAT_ACTION,
  KIN_CLEAR_CHAT_TITLE,
  kinClearChatBody,
} from "@t3tools/client-runtime/kin/kinClearChat";
import {
  KIN_GROUP_NAME_MAX,
  kinGroupCountLabel,
  kinGroupMemberViews,
  kinGroupNameCheck,
  kinGroupProblem,
  type KinGroupMemberView,
} from "@t3tools/client-runtime/kin/kinGroups";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinChatMembersResult, KinOrgId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
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
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Radio, RadioGroup } from "../components/ui/radio-group";
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
import { kinGroupFormAtom } from "./kinGroupForm";

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

type Confirm =
  | { readonly kind: "remove"; readonly member: KinGroupMemberView }
  | { readonly kind: "clear" }
  | { readonly kind: "delete" };

/** A group beside its chat: who is in it and which lead answers. Its owner changes both here. */
export function KinGroupSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly group: KinChatMembersResult;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: string | null;
  readonly muted: boolean;
  /** Agents the host marks retired: still listed here, and never the one that answers. */
  readonly retiredAgents: ReadonlySet<string>;
}) {
  const { group, environmentId, orgId, personId } = props;
  const { chatId } = group.chat;
  const navigate = useNavigate();
  const members = kinGroupMemberViews(group, personId, props.retiredAgents);
  const leads = members.filter((member) => member.kind === "lead");
  // Only an agent still at work can be chosen to answer.
  const answerers = leads.filter((lead) => !lead.retired);
  const silent = leads.find((lead) => lead.answers && lead.retired) ?? null;
  const owns = group.members.some(
    (member) =>
      member.leftAt === null &&
      member.role === "owner" &&
      member.principal._tag === "person" &&
      member.principal.personId === personId,
  );
  // The host decides again on every call; this only hides what it would refuse.
  const canChange = useAtomValue(kinClient.groupRename.permissionAtom(environmentId)) && owns;
  const canMute = useAtomValue(kinClient.mute.permissionAtom(environmentId));
  const mute = useAtomCommand(kinClient.mute, { reportFailure: false });
  const rename = useAtomCommand(kinClient.groupRename, { reportFailure: false });
  const setLead = useAtomCommand(kinClient.groupSetLead, { reportFailure: false });
  const removeMember = useAtomCommand(kinClient.groupRemoveMember, { reportFailure: false });
  const deleteGroup = useAtomCommand(kinClient.groupDelete, { reportFailure: false });
  const canClear = useAtomValue(kinClient.clear.permissionAtom(environmentId)) && owns;
  const clear = useAtomCommand(kinClient.clear, { reportFailure: false });
  const title = group.chat.title ?? "Group";
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const muteId = useId();
  const nameId = useId();

  /** Runs one change, then reads the group again; a refusal shows in the sheet. */
  const change = async <A, E>(doing: string, run: () => Promise<AsyncResult.AsyncResult<A, E>>) => {
    if (busy) return false;
    setBusy(true);
    setProblem(null);
    const result = await run();
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      appAtomRegistry.refresh(kinClient.chatMembers({ environmentId, input: { chatId } }));
      return true;
    }
    setProblem(
      kinGroupProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
        doing,
      ),
    );
    return false;
  };

  const saveName = async () => {
    const checked = kinGroupNameCheck(name ?? title);
    if (!checked.ok) return setProblem(checked.problem);
    if (checked.title === title) return setName(null);
    const done = await change("rename this group", () =>
      rename({ environmentId, input: { chatId, title: checked.title } }),
    );
    if (done) setName(null);
  };

  const confirmed = async () => {
    const pending = confirm;
    setConfirm(null);
    if (pending === null) return;
    if (pending.kind === "remove") {
      await change(`remove ${pending.member.name}`, () =>
        removeMember({ environmentId, input: { chatId, memberId: pending.member.memberId } }),
      );
      return;
    }
    if (pending.kind === "clear") {
      const done = await change("clear this chat", () =>
        clear({ environmentId, input: { chatId } }),
      );
      // Nothing to announce: the chat behind the sheet is empty.
      if (done) props.onOpenChange(false);
      return;
    }
    const done = await change("delete this group", () =>
      deleteGroup({ environmentId, input: { chatId } }),
    );
    if (!done) return;
    props.onOpenChange(false);
    void navigate({ to: "/kin" });
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <div className="flex items-center gap-3 pe-8">
            <KinAvatar avatar={{ kind: "group", seed: `chat:${chatId}` }} />
            <div className="flex min-w-0 flex-col">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{kinGroupCountLabel(members.length)}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          {problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          <Section title="Members">
            <ul className="flex flex-col gap-1">
              {members.map((member) => (
                <li key={member.memberId} className="flex min-h-9 items-center gap-3">
                  <KinAvatar avatar={member.avatar} size="sm" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{member.name}</span>
                    {member.detail === null ? null : (
                      <span className="truncate text-xs text-muted-foreground">
                        {member.detail}
                      </span>
                    )}
                  </div>
                  {canChange && member.kind !== "owner" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Remove ${member.name}`}
                      onClick={() => setConfirm({ kind: "remove", member })}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {leads.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No agent is in this group, so messages here get no answer from one.
              </p>
            ) : null}
            {canChange ? (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={() =>
                  appAtomRegistry.set(kinGroupFormAtom, { environmentId, orgId, chatId })
                }
              >
                Add agents or people
              </Button>
            ) : null}
          </Section>
          {canChange && (answerers.length > 1 || (silent !== null && answerers.length > 0)) ? (
            <Section title="Answers when no one is named">
              {silent === null ? null : (
                <p className="text-xs text-muted-foreground">
                  {silent.name} is retired, so nobody answers until you choose another agent.
                </p>
              )}
              <RadioGroup
                value={answerers.find((lead) => lead.answers)?.memberId ?? ""}
                disabled={busy}
                onValueChange={(memberId) => {
                  const lead = leads.find((held) => held.memberId === memberId);
                  if (lead === undefined || lead.principal._tag !== "agent") return;
                  const { agentId } = lead.principal;
                  void change("change who answers", () =>
                    setLead({ environmentId, input: { chatId, agentId } }),
                  );
                }}
              >
                {answerers.map((lead) => (
                  <label key={lead.memberId} className="flex cursor-pointer items-center gap-3">
                    <Radio value={lead.memberId} />
                    <KinAvatar avatar={lead.avatar} size="sm" />
                    <span className="truncate text-sm text-foreground">{lead.name}</span>
                  </label>
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">
                Name another agent with @ in a message to ask it instead.
              </p>
            </Section>
          ) : null}
          {canMute ? (
            <Section title="Notifications">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={muteId}>Mute this chat</Label>
                <Switch
                  id={muteId}
                  checked={props.muted}
                  disabled={busy}
                  onCheckedChange={(muted) =>
                    void change("change notifications", () =>
                      mute({ environmentId, input: { chatId, muted } }),
                    )
                  }
                />
              </div>
            </Section>
          ) : null}
          {canChange ? (
            <Section title="Group">
              {name === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => setName(title)}
                >
                  Rename group
                </Button>
              ) : (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveName();
                  }}
                >
                  <Label htmlFor={nameId}>Name</Label>
                  <Input
                    id={nameId}
                    value={name}
                    maxLength={KIN_GROUP_NAME_MAX}
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy}>
                      Save name
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setName(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
              {canClear ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: "clear" })}
                >
                  {KIN_CLEAR_CHAT_ACTION}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="destructive-outline"
                className="self-start"
                disabled={busy}
                onClick={() => setConfirm({ kind: "delete" })}
              >
                Delete group
              </Button>
            </Section>
          ) : null}
        </div>
      </SheetPopup>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "remove"
                ? `Remove ${confirm.member.name}?`
                : confirm?.kind === "clear"
                  ? KIN_CLEAR_CHAT_TITLE
                  : `Delete ${title}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "remove"
                ? confirm.member.kind === "lead"
                  ? `${confirm.member.name} stops answering here. You can add it back any time.`
                  : `${confirm.member.name} stops seeing this group and its files. You can add them back any time.`
                : confirm?.kind === "clear"
                  ? kinClearChatBody("group")
                  : "The group closes for everyone in it. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmed()}>
              {confirm?.kind === "remove"
                ? "Remove"
                : confirm?.kind === "clear"
                  ? KIN_CLEAR_CHAT_ACTION
                  : "Delete group"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Sheet>
  );
}
