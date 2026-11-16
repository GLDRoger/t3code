import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinSocialActions,
  KIN_SOCIAL_COPY as COPY,
  KIN_SOCIAL_LINK_PLATFORMS,
  kinSocialAccountLine,
  kinSocialChoices,
  kinSocialRows,
  type KinSocialRow,
} from "@t3tools/client-runtime/kin/kinSocial";
import type {
  EnvironmentId,
  KinOrgId,
  KinSocialCheck,
  KinSocialLink,
  KinSocialPlatform,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking, Share, View } from "react-native";

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

/** A sheet for one group; without a group the connect sheet adds one. */
export type KinSocialParams = KinConnectionsParams & { readonly groupId?: string };

function useSocial(environmentId: EnvironmentId, orgId: KinOrgId) {
  const viewAtom = kinClient.social({ environmentId, input: { orgId } });
  const result = useAtomValue(viewAtom);
  const reload = useAtomRefresh(viewAtom);
  const check = useAtomCommand(kinClient.socialCheck, { reportFailure: false });
  const connect = useAtomCommand(kinClient.socialConnect, { reportFailure: false });
  const refresh = useAtomCommand(kinClient.socialRefresh, { reportFailure: false });
  const remove = useAtomCommand(kinClient.socialRemove, { reportFailure: false });
  const link = useAtomCommand(kinClient.socialLink, { reportFailure: false });
  return {
    result,
    reload,
    view: Option.getOrNull(AsyncResult.value(result)),
    actions: createKinSocialActions({
      orgId,
      check: (input) => check({ environmentId, input }),
      connect: (input) => connect({ environmentId, input }),
      refresh: (input) => refresh({ environmentId, input }),
      remove: (input) => remove({ environmentId, input }),
      link: (input) => link({ environmentId, input }),
      reload,
    }),
  };
}

const ROW_ICON = {
  ok: "checkmark.circle",
  attention: "exclamationmark.circle",
  error: "exclamationmark.triangle",
  muted: "link",
} as const;

/** Social accounts on Settings → Connections; only owners and co-owners reach that screen. */
export function KinSocialSection(props: {
  readonly params: KinConnectionsParams;
  readonly target: KinConnectionsTarget;
}) {
  const navigation = useNavigation();
  const { result, reload, view, actions } = useSocial(
    props.target.environmentId,
    props.target.orgId,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (view === null)
    return AsyncResult.isFailure(result) ? (
      <Notice
        tone="danger"
        message={COPY.loadFailed}
        action={{ label: KIN_RETRY, onPress: reload }}
      />
    ) : null;
  const rows = kinSocialRows(view);
  const canAdd = kinSocialChoices(view).length > 0;
  const confirmRemove = (row: KinSocialRow) =>
    Dialog.alert(COPY.removeTitle(row.title), COPY.removeDetail, [
      { text: COPY.cancel, style: "cancel" },
      {
        text: COPY.remove,
        style: "destructive",
        onPress: () =>
          void actions.remove(row.groupId).then((outcome) => {
            setProblem(outcome.ok ? null : outcome.problem);
          }),
      },
    ]);
  const checkAgain = async (row: KinSocialRow) => {
    setBusy(row.groupId);
    const outcome = await actions.refresh(row.groupId);
    setBusy(null);
    setProblem(outcome.ok ? null : outcome.problem);
  };
  return (
    <View className="gap-2">
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection title={COPY.title} footer={rows.length === 0 ? COPY.empty : COPY.intro}>
        {rows.map((row) => (
          <View key={row.groupId}>
            <ListRow
              icon={ROW_ICON[row.tone]}
              label={row.title}
              description={[row.detail, ...row.accounts.map((one) => one.line)].join("\n")}
              detail={row.label}
              onPress={() =>
                navigation.navigate("KinSocialLink", { ...props.params, groupId: row.groupId })
              }
            />
            <ListActionRow
              label={row.linkLabel}
              onPress={() =>
                navigation.navigate("KinSocialLink", { ...props.params, groupId: row.groupId })
              }
            />
            <ListActionRow
              label={row.tone === "error" ? COPY.reconnect : COPY.refresh}
              loading={busy === row.groupId}
              onPress={() =>
                row.tone === "error"
                  ? navigation.navigate("KinSocialConnect", {
                      ...props.params,
                      groupId: row.groupId,
                    })
                  : void checkAgain(row)
              }
            />
            <ListActionRow label={COPY.remove} tone="danger" onPress={() => confirmRemove(row)} />
          </View>
        ))}
        {canAdd ? (
          <ListActionRow
            label={COPY.add}
            onPress={() => navigation.navigate("KinSocialConnect", props.params)}
          />
        ) : null}
      </ListSection>
    </View>
  );
}

/** Whose accounts, that profile's key, what it reaches, then Connect. */
export function KinSocialConnectScreen({ route }: StaticScreenProps<KinSocialParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.sheetTitle} sheet />
  ) : (
    <ConnectSheet target={target} groupId={route.params.groupId ?? null} />
  );
}

function ConnectSheet(props: {
  readonly target: KinConnectionsTarget;
  readonly groupId: string | null;
}) {
  const navigation = useNavigation();
  const { result, view, actions } = useSocial(props.target.environmentId, props.target.orgId);
  const rekey =
    props.groupId === null || view === null
      ? null
      : (kinSocialRows(view).find((row) => row.groupId === props.groupId) ?? null);
  const choices = view === null ? [] : kinSocialChoices(view);
  const [pick, setPick] = useState(0);
  const [key, setKey] = useState("");
  const [checked, setChecked] = useState<KinSocialCheck | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = rekey === null ? choices[pick] : undefined;
  const label = rekey?.title ?? chosen?.label ?? "";

  const submit = async (typed?: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    if (checked === null) {
      const outcome = await actions.check(
        rekey === null
          ? { kind: chosen?.kind ?? "own", clientId: chosen?.clientId, key: typed ?? key }
          : { kind: rekey.kind, groupId: rekey.groupId, key: typed ?? key },
      );
      setBusy(false);
      if (!outcome.ok) return setProblem(outcome.problem);
      setKey("");
      return setChecked(outcome.value);
    }
    const outcome = await actions.connect(checked.checkId);
    setBusy(false);
    if (!outcome.ok) {
      setChecked(null);
      return setProblem(outcome.problem);
    }
    setDone(true);
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={rekey === null ? COPY.sheetTitle : `${COPY.reconnect}: ${rekey.title}`}
        onClose={() => navigation.goBack()}
        confirm={
          done
            ? { label: COPY.done, onPress: () => navigation.goBack() }
            : {
                label:
                  checked === null
                    ? busy
                      ? COPY.checking
                      : COPY.check
                    : busy
                      ? COPY.connecting
                      : COPY.confirm,
                onPress: () => void submit(),
                loading: busy,
                disabled: busy || (checked === null && (key.trim() === "" || label === "")),
              }
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {view === null ? (
            AsyncResult.isFailure(result) ? (
              <ErrorBanner message={COPY.loadFailed} />
            ) : (
              <AppActivityIndicator />
            )
          ) : done ? (
            <Notice
              icon="checkmark.circle"
              message={`${label} is connected. Social can read these accounts and draft for them; nothing posts until you confirm a week.`}
            />
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {COPY.intro}
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              {checked === null ? (
                <>
                  {rekey === null ? (
                    <ListSection
                      title={COPY.whose}
                      footer={choices.length === 0 ? COPY.noClients : undefined}
                    >
                      {choices.map((choice, index) => (
                        <ListRow
                          key={choice.clientId ?? "own"}
                          icon={pick === index ? "checkmark.circle.fill" : "circle"}
                          label={choice.label}
                          detail={choice.kind === "client" ? "client" : undefined}
                          onPress={() => setPick(index)}
                        />
                      ))}
                    </ListSection>
                  ) : null}
                  <View className="gap-2">
                    <ListSection title={COPY.keyLabel}>
                      <View className="px-4 py-3">
                        <SecretTextInput
                          accessibilityLabel={COPY.keyLabel}
                          placeholder={COPY.keyPlaceholder}
                          value={key}
                          editable={!busy}
                          onChangeText={setKey}
                          onSubmitEditing={(typed) => void submit(typed)}
                        />
                      </View>
                      <ListActionRow
                        label={COPY.openService(view.service.label)}
                        onPress={() => void Linking.openURL(view.service.keyUrl)}
                      />
                    </ListSection>
                    <Text textRole="footnote" className="px-4 text-foreground-muted">
                      {COPY.keyHint(view.service.label)} {view.service.setup}
                    </Text>
                  </View>
                </>
              ) : (
                <ListSection
                  title={COPY.found(checked.profileName ?? checked.label)}
                  footer={`In Kin, these become the accounts for ${checked.label}, and its posts can only go to them.`}
                >
                  {checked.accounts.length === 0 ? (
                    <View className="px-4 py-3">
                      <Text className="text-foreground-muted">{COPY.noAccounts}</Text>
                    </View>
                  ) : (
                    checked.accounts.map((account) => (
                      <ListRow
                        key={account.accountId}
                        label={kinSocialAccountLine(account)}
                        description={account.problem ?? account.name}
                        onPress={() => undefined}
                      />
                    ))
                  )}
                </ListSection>
              )}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** A one-time link for one platform; the owner forwards it, Kin never messages the client. */
export function KinSocialLinkScreen({ route }: StaticScreenProps<KinSocialParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null || route.params.groupId === undefined ? (
    <KinConnectionsMissing title={COPY.link} sheet />
  ) : (
    <LinkSheet target={target} groupId={route.params.groupId} />
  );
}

function LinkSheet(props: { readonly target: KinConnectionsTarget; readonly groupId: string }) {
  const navigation = useNavigation();
  const { view, actions } = useSocial(props.target.environmentId, props.target.orgId);
  const row =
    view === null
      ? null
      : (kinSocialRows(view).find((one) => one.groupId === props.groupId) ?? null);
  const broken = row?.accounts.find((account) => account.problem !== null);
  const [platform, setPlatform] = useState<KinSocialPlatform | null>(null);
  const chosen = platform ?? broken?.platform ?? "instagram";
  const [made, setMade] = useState<KinSocialLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const make = async () => {
    if (busy || row === null) return;
    setBusy(true);
    setProblem(null);
    const again = row.accounts.find(
      (account) => account.platform === chosen && account.problem !== null,
    );
    const outcome = await actions.link(row.groupId, chosen, again?.accountId);
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    setMade(outcome.value);
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={row === null ? COPY.link : COPY.linkTitle(row.title)}
        onClose={() => navigation.goBack()}
        confirm={
          made === null
            ? {
                label: busy ? COPY.linkMaking : COPY.linkMake,
                onPress: () => void make(),
                loading: busy,
                disabled: busy || row === null,
              }
            : { label: COPY.done, onPress: () => navigation.goBack() }
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {row === null ? (
            <AppActivityIndicator />
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {row.kind === "client"
                  ? "Kin doesn't message your client. Forward the link yourself."
                  : "Open it on the phone or computer signed in to the account."}
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              {made === null ? (
                <ListSection title={COPY.linkPlatform}>
                  {KIN_SOCIAL_LINK_PLATFORMS.map((one) => (
                    <ListRow
                      key={one.platform}
                      icon={chosen === one.platform ? "checkmark.circle.fill" : "circle"}
                      label={one.label}
                      onPress={() => setPlatform(one.platform)}
                    />
                  ))}
                </ListSection>
              ) : (
                <ListSection footer={made.note}>
                  <View className="px-4 py-3">
                    <Text selectable className="font-mono text-xs text-foreground">
                      {made.url}
                    </Text>
                  </View>
                  <ListActionRow
                    label={COPY.share}
                    // Closing the share sheet without sending is not a failure.
                    onPress={() => void Share.share({ message: made.url }).catch(() => undefined)}
                  />
                  <ListActionRow
                    label={COPY.copy}
                    onPress={() => void tryCopyTextWithHaptic(made.url, { target: "link" })}
                  />
                </ListSection>
              )}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
