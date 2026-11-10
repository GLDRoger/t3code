import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
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
import { kinClient } from "../state/kinClient";
import { KinApprovalCard } from "../widgets/KinApprovalCard";
import { useEnrolApproverKey, useKinApproverKey } from "./useKinApproverKey";

type KinApprovalsParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

const HARDWARE: Record<string, string> = {
  secure_enclave: "Secure Enclave",
  strongbox: "StrongBox",
  tee: "secure hardware",
  software: "software",
};

/** Sets up this phone to approve Kin's requests: one hardware key, behind Face ID every time. */
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

function ApprovalsBody(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const { environmentId, orgId } = props;
  const { status, refresh } = useKinApproverKey(environmentId, orgId);
  const enrol = useEnrolApproverKey();
  const canChallenge = useAtomValue(kinClient.keyChallenge.permissionAtom(environmentId));
  const canRegister = useAtomValue(kinClient.registerKey.permissionAtom(environmentId));
  const canEnrol = canChallenge && canRegister;
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<{
    readonly text: string;
    readonly keyExists: boolean;
  } | null>(null);

  const start = async (replace: boolean) => {
    if (working || !canEnrol) return;
    setWorking(true);
    setProblem(null);
    const result = await enrol({ environmentId, orgId, replace });
    setWorking(false);
    if (result !== null && !result.ok) setProblem(result);
  };
  const confirmReplace = () =>
    Alert.alert(
      "Replace this phone's key?",
      "Kin stops accepting approvals from the old key. You confirm the new one like the first.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Replace key", style: "destructive", onPress: () => void start(true) },
      ],
    );

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

  const section = (title: string, lines: ReadonlyArray<string>, extra?: ReactNode) => (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <Text textRole="headline" className="font-t3-bold text-foreground">
        {title}
      </Text>
      {lines.map((line) => (
        <Text key={line} textRole="footnote" className="text-foreground-secondary">
          {line}
        </Text>
      ))}
      {extra}
    </View>
  );
  const problemLine =
    problem === null ? null : (
      <Text textRole="footnote" accessibilityRole="alert" className="text-danger-foreground">
        {problem.text}
      </Text>
    );
  const actions = (primary: ReactNode) => (
    <View className="flex-row flex-wrap gap-2 pt-1">{primary}</View>
  );
  const cantEnrolLine = canEnrol ? null : (
    <Text textRole="footnote" className="text-foreground-muted">
      This device can't set up approvals. Pair it again from the Kin host.
    </Text>
  );
  const remake = (label: string) =>
    actions(
      <Button
        label={label}
        tone="primary"
        loading={working}
        disabled={!canEnrol}
        onPress={confirmReplace}
      />,
    );
  const keyLine = (thumbprint: string) => (
    <Text selectable textRole="caption" className="font-mono text-foreground-muted">
      {`Key ${thumbprint}`}
    </Text>
  );
  const codeLine = (code: string) => (
    <Text
      selectable
      accessibilityLabel={`Code ${code.split("").join(" ")}`}
      className="py-2 font-mono text-[34px] tracking-[6px] text-foreground"
    >
      {`${code.slice(0, 3)} ${code.slice(3)}`}
    </Text>
  );

  switch (status._tag) {
    case "none":
      // Simulators refuse biometric Secure Enclave keys (LocalAuthentication -1020).
      if (!Device.isDevice)
        return section("This simulator can't approve", [
          "Approval keys need the secure hardware and Face ID of a real phone. Set up approvals on your iPhone.",
        ]);
      return section(
        "Approve from this phone",
        [
          "Kin asks before it merges a pull request or raises a lead's level. You approve with Face ID, and the phone signs exactly what the card shows.",
          "The key stays in this phone's secure hardware and never leaves it.",
        ],
        <>
          {problemLine}
          {cantEnrolLine}
          {actions(
            problem?.keyExists === true || status.staleKey ? (
              <Button
                label="Replace this phone's key"
                tone="primary"
                loading={working}
                onPress={confirmReplace}
                disabled={!canEnrol}
              />
            ) : (
              <Button
                label="Set up approvals"
                tone="primary"
                loading={working}
                disabled={!canEnrol}
                onPress={() => void start(false)}
              />
            ),
          )}
        </>,
      );
    case "pending":
      return section(
        status.first
          ? "Confirm this phone on the Kin host"
          : "Approve this phone from your other one",
        status.code === null
          ? ["The code expired. Make a new key to get another."]
          : status.first
            ? [
                "In a shell on the Kin host, run t3 kin approvals confirm-key, pick this key, and type this code. It works for 10 minutes.",
              ]
            : [
                "On the phone that already approves, open Approvals and approve this key with Face ID.",
                "Lost that phone? Run t3 kin approvals confirm-key --recover on the Kin host and type this code instead.",
              ],
        <>
          {status.code === null ? null : codeLine(status.code)}
          {keyLine(status.thumbprint)}
          {problemLine}
          {cantEnrolLine}
          {actions(
            status.code === null ? (
              <Button
                label="Make a new key"
                tone="primary"
                loading={working}
                disabled={!canEnrol}
                onPress={confirmReplace}
              />
            ) : (
              <Button label="Check again" tone="primary" onPress={refresh} />
            ),
          )}
        </>,
      );
    case "unattested":
      return section(
        "This phone can't approve",
        [
          "It couldn't prove to Apple that its key is in secure hardware, so Kin won't accept it. Simulators and some older phones can't.",
        ],
        <>
          {problemLine}
          {cantEnrolLine}
          {remake("Make a new key")}
        </>,
      );
    case "revoked":
      return section(
        "This phone's key was revoked",
        ["Kin no longer accepts approvals from it. Make a new key to approve from this phone."],
        <>
          {problemLine}
          {cantEnrolLine}
          {remake("Make a new key")}
        </>,
      );
    case "active":
      return (
        <>
          {section("This phone approves for Kin", [
            `Its key is in ${HARDWARE[status.key.hardware] ?? "secure hardware"}. Every approval asks for Face ID.`,
          ])}
          {status.enrolments.map((enrolment) => (
            <KinApprovalCard
              key={enrolment.actionId}
              environmentId={environmentId}
              actionId={enrolment.actionId}
              revision={0}
            />
          ))}
        </>
      );
  }
}
