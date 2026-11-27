import {
  KIN_CHATS_SETTLE,
  KIN_CHATS_SETTLE_OPTIONS,
  kinChatsSettleAfterHours,
} from "@t3tools/client-runtime/kin/kinChatListRows";
import type { KinChatsSettleAfterHours } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMessages } from "gt-react";

import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "../kinClient";
import { useKinProfiles } from "../kinPictures";
import { useKinMe } from "../KinProfileSheet";
import { KinSettingsChoice, useKinSettingsSave } from "./KinSettingsControls";
import { KinSettingsLoading, KinSettingsRow, KinSettingsSection } from "./KinSettingsLayout";
import type { KinSettingsTarget } from "./kinSettingsTarget";

/**
 * How long a read chat stays up in Chats before moving under Settled, synced across this
 * person's devices on their own Kin profile.
 */
export function KinChatsSettleSetting(props: KinSettingsTarget) {
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const me = useKinMe(props.environmentId, props.orgId);
  const result = useKinProfiles(props.environmentId, props.orgId);
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const saving = useKinSettingsSave();
  const held = result === null ? null : Option.getOrNull(AsyncResult.value(result));
  const profile = held?.profiles.find((one) => one.personId === me) ?? null;
  if (me === null || held === null || profile === null)
    return result !== null && AsyncResult.isFailure(result) ? null : (
      <KinSettingsSection title={m(KIN_CHATS_SETTLE.section)}>
        <KinSettingsLoading rows={1} />
      </KinSettingsSection>
    );
  const hours = kinChatsSettleAfterHours(profile);
  const change = async (chatsSettleAfterHours: KinChatsSettleAfterHours) => {
    await saving.run("settle-after", m(KIN_CHATS_SETTLE.failed), () =>
      update({
        environmentId: props.environmentId,
        input: { orgId: props.orgId, personId: me, chatsSettleAfterHours },
      }),
    );
    appAtomRegistry.refresh(
      kinClient.profiles({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
    );
  };
  return (
    <KinSettingsSection
      searchId={searchableSetting("kin-settle-read-chats").id}
      title={m(KIN_CHATS_SETTLE.section)}
      problem={saving.problem}
    >
      <KinSettingsRow
        title={m(KIN_CHATS_SETTLE.label)}
        detail={m(KIN_CHATS_SETTLE.hint)}
        wrap
        stack
        control={
          <KinSettingsChoice
            label={m(KIN_CHATS_SETTLE.label)}
            value={String(hours)}
            disabled={saving.busy !== null}
            options={KIN_CHATS_SETTLE_OPTIONS.map((option) => ({
              value: String(option.hours),
              label: m(option.label),
            }))}
            onChange={(next) => {
              const picked = KIN_CHATS_SETTLE_OPTIONS.find(
                (option) => String(option.hours) === next,
              );
              if (picked !== undefined) void change(picked.hours);
            }}
          />
        }
      />
    </KinSettingsSection>
  );
}
