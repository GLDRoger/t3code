import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_AUDIENCE,
  KIN_WORK_SHARE,
  kinWorkAudience,
  kinWorkAudienceMove,
  type KinWorkAudience,
  type KinWorkItemView,
  type KinWorkNames,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/** The owner's switch for whether teammates see a task or doc; a teammate never gets it. */
export function KinWorkShareRow(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly shared: boolean;
    readonly disabled: boolean;
    readonly copy?: typeof KIN_WORK_SHARE;
    /** Reads the record again once the host answers; a task's sheet by default. */
    readonly onSettled?: () => void;
  },
) {
  const { environmentId, orgId, itemKey } = props;
  const canShare = useAtomValue(kinClient.workShare.permissionAtom(environmentId));
  const share = useAtomCommand(kinClient.workShare, { reportFailure: false });
  // What was asked, held only until the host's read moves off the value it was asked from.
  const [asked, setAsked] = useState<{ readonly to: boolean; readonly from: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const shareId = useId();
  const copy = props.copy ?? KIN_WORK_SHARE;
  if (!canShare) return null;
  const shared = asked !== null && asked.from === props.shared ? asked.to : props.shared;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={shareId}>{copy.label}</Label>
        <p className="text-xs text-muted-foreground">
          {failed ? copy.failed : shared ? copy.on : copy.off}
        </p>
      </div>
      <Switch
        id={shareId}
        size="sm"
        checked={shared}
        disabled={props.disabled || pending}
        onCheckedChange={(checked) => {
          setAsked({ to: checked, from: props.shared });
          setPending(true);
          setFailed(false);
          void share({
            environmentId,
            input: { orgId, keys: [itemKey], shared: checked },
          }).then((outcome) => {
            const refused = AsyncResult.isFailure(outcome);
            setFailed(refused);
            setPending(false);
            if (refused) setAsked(null);
            if (props.onSettled !== undefined) props.onSettled();
            else
              appAtomRegistry.refresh(
                kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
              );
          });
        }}
      />
    </div>
  );
}

/**
 * A task's one privacy control: who can see it, in plain words, and a menu of the real choices.
 * The private mark goes through the task's own changes; sharing through `kin.work.share`.
 */
export function KinWorkAudienceRow(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly view: Pick<KinWorkItemView, "privacy" | "shared" | "project" | "can" | "markedBy">;
    readonly names: KinWorkNames;
    readonly disabled: boolean;
    /** Sets the private mark; null where this viewer can't. */
    readonly onMark: ((on: boolean) => void) | null;
  },
) {
  const { environmentId, orgId, itemKey, view } = props;
  const canShare = useAtomValue(kinClient.workShare.permissionAtom(environmentId));
  const share = useAtomCommand(kinClient.workShare, { reportFailure: false });
  const [asked, setAsked] = useState<{ readonly to: boolean; readonly from: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (props.onMark === null) return null;
  const shared = asked !== null && asked.from === view.shared ? asked.to : view.shared;
  const audience = kinWorkAudience(
    { ...view, shared },
    { ...view.can, share: view.can.share && canShare },
    props.names,
  );
  const pick = (to: KinWorkAudience) => {
    const move = kinWorkAudienceMove({ private: view.privacy.private, shared }, to);
    if (move.private !== null) props.onMark?.(move.private);
    if (move.shared === null || !canShare) return;
    const on = move.shared;
    setAsked({ to: on, from: view.shared });
    setPending(true);
    setFailed(false);
    void share({ environmentId, input: { orgId, keys: [itemKey], shared: on } }).then((outcome) => {
      const refused = AsyncResult.isFailure(outcome);
      setFailed(refused);
      setPending(false);
      if (refused) setAsked(null);
      appAtomRegistry.refresh(
        kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
      );
    });
  };
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{KIN_WORK_AUDIENCE.label}</span>
        <p className="text-xs text-muted-foreground">
          {failed ? KIN_WORK_AUDIENCE.failed : audience.answer}
        </p>
      </div>
      {audience.choices.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={props.disabled || pending}
                aria-label={`${KIN_WORK_AUDIENCE.label}: ${audience.answer}. Change`}
              />
            }
          >
            Change
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={audience.current}
              onValueChange={(value) => {
                const to = audience.choices.find((choice) => choice.id === value)?.id;
                if (to !== undefined) pick(to);
              }}
            >
              {audience.choices.map((choice) => (
                <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
                  {choice.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
