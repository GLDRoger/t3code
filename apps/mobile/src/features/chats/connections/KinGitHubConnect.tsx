import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinGitHubActions,
  KIN_GITHUB_COPY as COPY,
  kinGitHubRow,
  kinGitHubSheet,
} from "@t3tools/client-runtime/kin/kinGitHub";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionsParams,
  type KinConnectionsTarget,
} from "./kinConnectionTarget";

function useGitHub(environmentId: EnvironmentId, orgId: KinOrgId) {
  const statusAtom = kinClient.github({ environmentId, input: { orgId } });
  const result = useAtomValue(statusAtom);
  const reload = useAtomRefresh(statusAtom);
  const start = useAtomCommand(kinClient.githubStart, { reportFailure: false });
  const cancel = useAtomCommand(kinClient.githubCancel, { reportFailure: false });
  const disconnect = useAtomCommand(kinClient.githubDisconnect, { reportFailure: false });
  return {
    result,
    reload,
    status: Option.getOrNull(AsyncResult.value(result)),
    actions: createKinGitHubActions({
      orgId,
      start: (input) => start({ environmentId, input }),
      cancel: (input) => cancel({ environmentId, input }),
      disconnect: (input) => disconnect({ environmentId, input }),
      refresh: reload,
    }),
  };
}

/** The GitHub section of Settings → Connections; only owners and co-owners reach that screen. */
export function KinGitHubSection(props: {
  readonly params: KinConnectionsParams;
  readonly target: KinConnectionsTarget;
}) {
  const navigation = useNavigation();
  const { result, reload, status, actions } = useGitHub(
    props.target.environmentId,
    props.target.orgId,
  );
  const [problem, setProblem] = useState<string | null>(null);
  if (status === null)
    return AsyncResult.isFailure(result) ? (
      <Notice
        tone="danger"
        message={COPY.loadFailed}
        action={{ label: KIN_RETRY, onPress: reload }}
      />
    ) : null;
  const row = kinGitHubRow(status);
  const login = status.account?.login ?? null;
  const confirmDisconnect = () => {
    if (login === null) return;
    Dialog.alert(COPY.disconnectTitle, COPY.disconnectDetail(login), [
      { text: COPY.cancel, style: "cancel" },
      {
        text: COPY.disconnect,
        style: "destructive",
        onPress: () =>
          void actions.disconnect().then((outcome) => {
            setProblem(outcome.ok ? null : outcome.problem);
          }),
      },
    ]);
  };
  return (
    <View className="gap-2">
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection title={COPY.title} footer={row.action === "connect" ? undefined : COPY.intro}>
        <ListRow
          icon={
            row.tone === "error"
              ? "exclamationmark.triangle"
              : row.tone === "ok"
                ? "checkmark.circle"
                : "link"
          }
          label={COPY.title}
          description={row.detail}
          detail={row.label}
          onPress={() =>
            row.action === "disconnect"
              ? confirmDisconnect()
              : navigation.navigate("KinGitHubConnect", props.params)
          }
        />
        {row.action === "connect" || row.action === "reconnect" || row.action === "waiting" ? (
          <ListActionRow
            label={
              row.action === "reconnect"
                ? COPY.reconnect
                : row.action === "waiting"
                  ? COPY.enterCode
                  : COPY.connect
            }
            onPress={() => navigation.navigate("KinGitHubConnect", props.params)}
          />
        ) : null}
        {login === null ? null : (
          <ListActionRow label={COPY.disconnect} tone="danger" onPress={confirmDisconnect} />
        )}
      </ListSection>
    </View>
  );
}

/** The Connect sheet: get a code and enter it on GitHub, or paste a token. Updates live. */
export function KinGitHubConnectScreen({ route }: StaticScreenProps<KinConnectionsParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.sheetTitle} sheet />
  ) : (
    <ConnectSheet target={target} />
  );
}

function ConnectSheet(props: { readonly target: KinConnectionsTarget }) {
  const navigation = useNavigation();
  const { result, status, actions } = useGitHub(props.target.environmentId, props.target.orgId);
  const step = kinGitHubSheet(status);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [withToken, setWithToken] = useState(false);
  const [token, setToken] = useState("");

  const submit = async (typed?: string) => {
    if (busy || step.step !== "start") return;
    setBusy(true);
    setProblem(null);
    const outcome = withToken
      ? await actions.connectWithToken(typed ?? token)
      : await actions.getCode();
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
    else setToken("");
  };
  const close = () => {
    if (step.step === "code") void actions.cancel();
    navigation.goBack();
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={COPY.sheetTitle}
        onClose={close}
        {...(step.step === "start"
          ? {
              confirm: {
                label: busy
                  ? withToken
                    ? COPY.connecting
                    : COPY.gettingCode
                  : withToken
                    ? COPY.connect
                    : COPY.getCode,
                onPress: () => void submit(),
                loading: busy,
                disabled: busy || status === null,
              },
            }
          : step.step === "done"
            ? { confirm: { label: COPY.done, onPress: () => navigation.goBack() } }
            : {})}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {status === null ? (
            AsyncResult.isFailure(result) ? (
              <ErrorBanner message={COPY.loadFailed} />
            ) : (
              <AppActivityIndicator />
            )
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {COPY.intro}
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              {step.step === "start" && step.failed !== null && problem === null ? (
                <ErrorBanner message={step.failed} />
              ) : null}
              {step.step === "code" ? (
                <>
                  <ListSection title={COPY.enterCode} footer={COPY.codeHint}>
                    <View className="items-center px-4 py-5">
                      <Text
                        selectable
                        accessibilityLabel={`Code ${step.code.split("").join(" ")}`}
                        className="font-mono text-3xl font-semibold tracking-widest text-foreground"
                      >
                        {step.code}
                      </Text>
                    </View>
                    <ListActionRow
                      label={COPY.copy}
                      onPress={() => void tryCopyTextWithHaptic(step.code, { target: "code" })}
                    />
                    <ListActionRow
                      label={COPY.openGitHub}
                      onPress={() => void Linking.openURL(step.url)}
                    />
                  </ListSection>
                  <View className="flex-row items-center justify-center gap-2">
                    <AppActivityIndicator />
                    <Text textRole="footnote" className="text-foreground-muted">
                      {COPY.waiting}
                    </Text>
                  </View>
                </>
              ) : step.step === "done" ? (
                <Notice icon="checkmark.circle" message={step.detail} />
              ) : (
                <>
                  {withToken ? (
                    <View className="gap-2">
                      <ListSection>
                        <View className="gap-2 px-4 py-3">
                          <Text className="text-sm text-foreground-muted">{COPY.tokenLabel}</Text>
                          <SecretTextInput
                            accessibilityLabel={COPY.tokenLabel}
                            placeholder={COPY.tokenPlaceholder}
                            value={token}
                            editable={!busy}
                            onChangeText={setToken}
                            onSubmitEditing={(typed) => void submit(typed)}
                          />
                        </View>
                      </ListSection>
                      <Text textRole="footnote" className="px-4 text-foreground-muted">
                        {COPY.tokenHint}
                      </Text>
                    </View>
                  ) : null}
                  <ListSection>
                    <ListActionRow
                      label={withToken ? COPY.codeInstead : COPY.tokenInstead}
                      disabled={busy}
                      onPress={() => {
                        setProblem(null);
                        setWithToken(!withToken);
                      }}
                    />
                  </ListSection>
                </>
              )}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
