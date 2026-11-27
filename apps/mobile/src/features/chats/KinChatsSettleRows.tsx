import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_CHATS_SETTLE,
  KIN_CHATS_SETTLE_OPTIONS,
  kinChatsSettleAfterHours,
} from "@t3tools/client-runtime/kin/kinChatListRows";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinChatsSettleAfterHours,
  KinOrgId,
  KinPeopleProfilesResult,
  KinPersonId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { kinClient } from "./state/kinClient";

/**
 * How long a read chat stays up in Chats before moving under Settled, synced across this
 * person's devices on their own Kin profile.
 */
export function KinChatsSettleRows(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profiles: KinPeopleProfilesResult;
  readonly personId: KinPersonId;
}) {
  const m = useMessages();
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const profile = props.profiles.profiles.find((one) => one.personId === props.personId);
  if (profile === undefined) return null;
  const selected = kinChatsSettleAfterHours(profile);
  const selectedLabel =
    KIN_CHATS_SETTLE_OPTIONS.find((option) => option.hours === selected)?.label ??
    KIN_CHATS_SETTLE_OPTIONS[2]!.label;
  const change = async (chatsSettleAfterHours: KinChatsSettleAfterHours) => {
    setBusy(true);
    setProblem(null);
    const outcome = await update({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, personId: profile.personId, chatsSettleAfterHours },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(outcome))
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), m(KIN_CHATS_SETTLE.failed)));
    appAtomRegistry.refresh(
      kinClient.profiles({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
    );
  };
  return (
    <SettingsSection title={m(KIN_CHATS_SETTLE.section)} footer={m(KIN_CHATS_SETTLE.hint)}>
      <Menu
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${m(KIN_CHATS_SETTLE.label)}, ${m(selectedLabel)}`}
        title={m(KIN_CHATS_SETTLE.label)}
        actions={KIN_CHATS_SETTLE_OPTIONS.map((option) => ({
          id: String(option.hours),
          title: m(option.label),
          state: option.hours === selected ? "on" : "off",
        }))}
        onPressAction={({ nativeEvent: { event } }) => {
          const picked = KIN_CHATS_SETTLE_OPTIONS.find((option) => String(option.hours) === event);
          if (picked !== undefined && picked.hours !== selected && !busy) {
            void change(picked.hours);
          }
        }}
      >
        <View pointerEvents="none">
          <ListRowLayout
            icon="clock"
            label={m(KIN_CHATS_SETTLE.label)}
            detail={m(selectedLabel)}
            disabled={busy}
            accessory={
              <SymbolView
                name="chevron.down"
                size={13}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
                weight="semibold"
              />
            }
          />
        </View>
      </Menu>
      {problem === null ? null : (
        <Text textRole="footnote" className="px-4 pb-3 text-danger-foreground">
          {problem}
        </Text>
      )}
    </SettingsSection>
  );
}
