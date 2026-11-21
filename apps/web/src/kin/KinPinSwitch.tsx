import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_CHATS_PIN } from "@t3tools/client-runtime/kin/kinChatListRows";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

/** Beside a chat's mute: keeps the chat on top of this person's own list, on every device. */
export function KinPinSwitch(props: {
  readonly environmentId: EnvironmentId;
  readonly chatId: KinChatId;
  readonly pinned: boolean;
}) {
  const canPin = useAtomValue(kinClient.pin.permissionAtom(props.environmentId));
  const pin = useAtomCommand(kinClient.pin, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  if (!canPin) return null;
  const setPinned = async (pinned: boolean) => {
    setSaving(true);
    const result = await pin({
      environmentId: props.environmentId,
      input: { chatId: props.chatId, pinned },
    });
    setSaving(false);
    setProblem(
      AsyncResult.isFailure(result)
        ? kinFailureText(squashAtomCommandFailure(result), KIN_AGENT_PAGE.changeFailed)
        : null,
    );
  };
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <Label htmlFor={id}>{KIN_CHATS_PIN.setting}</Label>
          <span className="text-xs text-muted-foreground">{KIN_CHATS_PIN.settingDetail}</span>
        </span>
        <Switch
          id={id}
          checked={props.pinned}
          disabled={saving}
          onCheckedChange={(checked) => void setPinned(checked)}
        />
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </>
  );
}
