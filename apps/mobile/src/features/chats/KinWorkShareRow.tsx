import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_AUDIENCE,
  KIN_WORK_SHARE,
  kinWorkAudience,
  kinWorkAudienceMove,
  type KinWorkItemView,
  type KinWorkNames,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import type { KinWorkTarget } from "./state/useKinWork";

/** The owner's switch for whether teammates see a task or doc; a teammate never gets it. */
export function KinWorkShareRow(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly shared: boolean;
    readonly disabled: boolean;
    readonly copy?: typeof KIN_WORK_SHARE;
    /** Reads the record again once the host answers; the task by default. */
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
  const copy = props.copy ?? KIN_WORK_SHARE;
  if (!canShare) return null;
  const shared = asked !== null && asked.from === props.shared ? asked.to : props.shared;
  return (
    <ListToggleRow
      icon="person.2"
      label={copy.label}
      description={failed ? copy.failed : shared ? copy.on : copy.off}
      value={shared}
      disabled={props.disabled || pending}
      onValueChange={(on) => {
        setAsked({ to: on, from: props.shared });
        setPending(true);
        setFailed(false);
        void share({ environmentId, input: { orgId, keys: [itemKey], shared: on } }).then(
          (outcome) => {
            const refused = AsyncResult.isFailure(outcome);
            setFailed(refused);
            setPending(false);
            if (refused) setAsked(null);
            if (props.onSettled !== undefined) props.onSettled();
            else
              appAtomRegistry.refresh(
                kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
              );
          },
        );
      }}
    />
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
  const shared = asked !== null && asked.from === view.shared ? asked.to : view.shared;
  const audience = kinWorkAudience(
    { ...view, shared },
    {
      mark: props.onMark !== null && view.can.mark,
      unmark: props.onMark !== null && view.can.unmark,
      share: view.can.share && canShare,
    },
    props.names,
  );
  if (props.onMark === null) return null;
  // One line: who in a few words; the whole answer is read out.
  const row = (
    <View accessible accessibilityLabel={`${KIN_WORK_AUDIENCE.label}: ${audience.answer}`}>
      <ListRowLayout
        icon={audience.current === "me" ? "lock" : "person.2"}
        label={KIN_WORK_AUDIENCE.label}
        detail={audience.short}
        detailEllipsizeMode="tail"
        {...(failed ? { description: KIN_WORK_AUDIENCE.failed } : {})}
        disabled={props.disabled || pending}
      />
    </View>
  );
  if (audience.choices.length === 0) return row;
  return (
    <Menu
      title={KIN_WORK_AUDIENCE.label}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_WORK_AUDIENCE.label}: ${audience.answer}. Change`}
      actions={audience.choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        state: choice.id === audience.current ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled || pending) return;
        const to = audience.choices.find((choice) => choice.id === event)?.id;
        if (to === undefined) return;
        const move = kinWorkAudienceMove({ private: view.privacy.private, shared }, to);
        if (move.private !== null) props.onMark?.(move.private);
        if (move.shared === null || !canShare) return;
        const on = move.shared;
        setAsked({ to: on, from: view.shared });
        setPending(true);
        setFailed(false);
        void share({ environmentId, input: { orgId, keys: [itemKey], shared: on } }).then(
          (outcome) => {
            const refused = AsyncResult.isFailure(outcome);
            setFailed(refused);
            setPending(false);
            if (refused) setAsked(null);
            appAtomRegistry.refresh(
              kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
            );
          },
        );
      }}
    >
      <View pointerEvents="none">{row}</View>
    </Menu>
  );
}
