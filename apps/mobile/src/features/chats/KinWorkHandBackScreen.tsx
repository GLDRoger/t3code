import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_WORK_HAND_BACK } from "@t3tools/client-runtime/kin/kinWork";
import { EnvironmentId, KinOrgId, KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";

export type KinWorkHandBackParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly task: string;
  /** Who it goes back to, as the task shows them. */
  readonly to: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** The holder gives a task back to whoever gave it, saying why if they like. */
export function KinWorkHandBackScreen({ route }: StaticScreenProps<KinWorkHandBackParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  const handBack = useAtomCommand(kinClient.workHandBack, { reportFailure: false });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => navigation.goBack();
  const send = async () => {
    if (environmentId === null || orgId === null || key === null || pending) return;
    setPending(true);
    setFailed(false);
    const trimmed = note.trim();
    const outcome = await handBack({
      environmentId,
      input: { orgId, key, ...(trimmed === "" ? {} : { note: trimmed }) },
    });
    setPending(false);
    if (AsyncResult.isFailure(outcome)) {
      setFailed(true);
      return;
    }
    appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } }));
    // Off the task too: once it is back, it may no longer be one they see.
    navigation.dispatch(StackActions.pop(2));
  };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_WORK_HAND_BACK.title} onClose={close} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {environmentId === null || orgId === null || key === null ? (
            <EmptyState
              variant="plain"
              title="This link doesn't name a task"
              detail="Open Work from your Kin chats."
            />
          ) : (
            <>
              {failed ? <ErrorBanner message={KIN_WORK_HAND_BACK.failed} /> : null}
              <Text textRole="body" className="px-2 text-foreground">
                {KIN_WORK_HAND_BACK.detail(route.params.to)}
              </Text>
              <ListSection>
                <View className="gap-2 px-4 py-3">
                  <Text className="text-sm text-foreground-muted">
                    {KIN_WORK_HAND_BACK.reasonLabel}
                  </Text>
                  <TextInput
                    accessibilityLabel={KIN_WORK_HAND_BACK.reasonLabel}
                    value={note}
                    editable={!pending}
                    autoFocus
                    multiline
                    maxLength={280}
                    onChangeText={setNote}
                    textAlignVertical="top"
                    placeholderTextColorClassName="accent-placeholder"
                    className="min-h-20 font-sans text-base text-foreground"
                  />
                </View>
              </ListSection>
              <Button
                tone="primary"
                fullWidth
                label={KIN_WORK_HAND_BACK.confirm}
                loading={pending}
                onPress={() => void send()}
              />
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
