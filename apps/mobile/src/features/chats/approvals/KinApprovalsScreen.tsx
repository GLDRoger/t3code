import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  KinApprovalError,
  KinOrgId,
  type KinApproverKey,
  type KinApproverKeyActivity,
  type KinKeyThumbprint,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Device from "expo-device";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";
import { Alert, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import { useEnrolApproverKey, useKinApproverKey } from "./useKinApproverKey";

type KinApprovalsParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const isApprovalError = Schema.is(KinApprovalError);

const HARDWARE: Record<string, string> = {
  secure_enclave: "the Secure Enclave",
  strongbox: "StrongBox",
  tee: "secure hardware",
};
const PLATFORM: Record<string, string> = { ios: "iPhone", android: "Android" };
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const on = (at: DateTime.Utc) => dayFormat.format(DateTime.toEpochMillis(at));

/** Sets up this phone to approve Kin's requests, and lists the phones that can. */
export function KinApprovalsScreen({ route }: StaticScreenProps<KinApprovalsParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title="Approvals" onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, gap: 16 }}
        >
          {environmentId === null || orgId === null ? (
            <EmptyState
              variant="plain"
              title="This link doesn't name a Kin host."
              detail="Open approvals from a card that waits on you."
            />
          ) : (
            <ApprovalsBody environmentId={environmentId} orgId={orgId} />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function Section(props: {
  readonly title: string;
  readonly lines?: ReadonlyArray<string>;
  readonly children?: ReactNode;
}) {
  return (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <Text textRole="headline" className="font-t3-bold text-foreground">
        {props.title}
      </Text>
      {(props.lines ?? []).map((line) => (
        <Text key={line} textRole="footnote" className="text-foreground-secondary">
          {line}
        </Text>
      ))}
      {props.children}
    </View>
  );
}

function ApprovalsBody(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const { environmentId, orgId } = props;
  const { status, refresh } = useKinApproverKey(environmentId, orgId);
  const enrol = useEnrolApproverKey();
  const revokeKey = useAtomCommand(kinClient.revokeKey, { reportFailure: false });
  const canChallenge = useAtomValue(kinClient.keyChallenge.permissionAtom(environmentId));
  const canRegister = useAtomValue(kinClient.registerKey.permissionAtom(environmentId));
  const canRemove = useAtomValue(kinClient.revokeKey.permissionAtom(environmentId));
  const canEnrol = canChallenge && canRegister;
  const [working, setWorking] = useState(false);
  const [removing, setRemoving] = useState<KinKeyThumbprint | null>(null);
  const [problem, setProblem] = useState<{
    readonly text: string;
    readonly keyExists: boolean;
  } | null>(null);

  if (status._tag === "loading")
    return (
      <View className="items-center py-12" accessible accessibilityLabel="Loading approvals">
        <AppActivityIndicator />
      </View>
    );
  if (status._tag === "unreadable")
    return (
      <View className="gap-3">
        <ErrorBanner message="Kin didn't say whether this phone can approve." />
        <View className="self-start">
          <Button tone="secondary" size="compact" label="Retry" onPress={status.retry} />
        </View>
      </View>
    );

  const start = async (replace: boolean) => {
    if (working || !canEnrol) return;
    setWorking(true);
    setProblem(null);
    const result = await enrol({ environmentId, orgId, replace });
    setWorking(false);
    if (result !== null && !result.ok) setProblem(result);
  };
  const replaceKey = problem?.keyExists === true || status.staleKey;
  const setUp = () =>
    replaceKey
      ? Alert.alert(
          "Set up this phone again?",
          "It makes a new approval key. The old one on this phone stops working.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Set up again", onPress: () => void start(true) },
          ],
        )
      : void start(false);

  const remove = async (key: KinApproverKey) => {
    if (removing !== null) return;
    setRemoving(key.thumbprint);
    setProblem(null);
    const result = await revokeKey({
      environmentId,
      input: { orgId, thumbprint: key.thumbprint },
    });
    setRemoving(null);
    refresh();
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setProblem({
        text:
          isApprovalError(cause) && cause.reason !== "unavailable"
            ? cause.message
            : "Kin didn't answer. Try again.",
        keyExists: false,
      });
    }
  };
  const confirmRemove = (key: KinApproverKey) =>
    Alert.alert(
      `Remove ${key.deviceLabel}?`,
      status.keys.length === 1
        ? "It's the only phone that can approve. Once it's removed, nothing that needs approval can happen until you set up a phone again."
        : "It stops approving for Kin, and anything it approved that hasn't run yet is cancelled.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove phone", style: "destructive", onPress: () => void remove(key) },
      ],
    );

  const problemLine =
    problem === null ? null : (
      <Text textRole="footnote" accessibilityRole="alert" className="text-danger-foreground">
        {problem.text}
      </Text>
    );

  return (
    <>
      {status.own !== null ? (
        <Section
          title="This phone can approve"
          lines={[
            `Its key is in ${HARDWARE[status.own.hardware] ?? "secure hardware"}. Kin asks before it merges a pull request or changes what an agent may do, and every approval asks for Face ID.`,
          ]}
        />
      ) : !Device.isDevice ? (
        // Simulators refuse biometric Secure Enclave keys (LocalAuthentication -1020).
        <Section
          title="This simulator can't approve"
          lines={[
            "Approvals need the secure hardware and Face ID of a real phone. Set up approvals on your phone.",
          ]}
        />
      ) : (
        <Section
          title="Set up approvals on this phone"
          lines={[
            "Kin asks before it merges a pull request or changes what an agent may do. You approve with Face ID, and the phone signs exactly what the card shows.",
            "The key stays in this phone's secure hardware and never leaves it.",
          ]}
        >
          {problemLine}
          {canEnrol ? null : (
            <Text textRole="footnote" className="text-foreground-muted">
              This device can't set up approvals. Pair it again from the Kin host.
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2 pt-1">
            <Button
              label="Set up approvals on this phone"
              tone="primary"
              loading={working}
              disabled={!canEnrol}
              onPress={setUp}
            />
          </View>
        </Section>
      )}

      <Section title="Phones that can approve">
        {status.own === null ? null : problemLine}
        {status.keys.length === 0 ? (
          <Text textRole="footnote" className="text-foreground-secondary">
            None yet, so nothing that needs approval can happen.
          </Text>
        ) : (
          status.keys.map((key) => (
            <View key={key.thumbprint} className="flex-row items-center gap-3 py-1">
              <View className="min-w-0 flex-1">
                <Text textRole="body" className="text-foreground" numberOfLines={2}>
                  {key.thumbprint === status.own?.thumbprint
                    ? `${key.deviceLabel} (this phone)`
                    : key.deviceLabel}
                </Text>
                <Text textRole="caption" className="text-foreground-muted">
                  {`${PLATFORM[key.platform] ?? "Phone"}, added ${on(key.confirmedAt ?? key.createdAt)}${key.lastUsedAt === undefined ? "" : `. Last approved ${on(key.lastUsedAt)}`}`}
                </Text>
              </View>
              {canRemove ? (
                <Button
                  label="Remove"
                  tone="secondary"
                  size="compact"
                  loading={removing === key.thumbprint}
                  disabled={removing !== null}
                  accessibilityLabel={`Remove ${key.deviceLabel}`}
                  onPress={() => confirmRemove(key)}
                />
              ) : null}
            </View>
          ))
        )}
      </Section>

      {status.activity.length === 0 ? null : (
        <Section title="Recent changes">
          {status.activity.map((entry) => (
            <ActivityLine
              key={`${entry.change}:${DateTime.toEpochMillis(entry.at)}:${entry.deviceLabel}`}
              entry={entry}
            />
          ))}
        </Section>
      )}
    </>
  );
}

function ActivityLine(props: { readonly entry: KinApproverKeyActivity }) {
  const { entry } = props;
  return (
    <Text textRole="footnote" className="text-foreground-secondary">
      {`${entry.deviceLabel} (${PLATFORM[entry.platform] ?? "Phone"}) ${entry.change === "added" ? "was set up" : "was removed"} on ${on(entry.at)}.`}
    </Text>
  );
}
