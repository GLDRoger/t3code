import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CONNECTIONS_COPY as COPY,
  KIN_OWNER_CLIENT_SETUP,
  kinAddableServices,
  kinConnectionChange,
  kinConnectionDraft,
  kinIsOwnerClientService,
  kinServiceNote,
  type KinConnectionDraft,
} from "@t3tools/client-runtime/kin/kinConnections";
import { KinConnectionKey, type KinConnectionId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { AppText as Text } from "../../../components/ui/AppText";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../../state/use-atom-command";
import { KinLoadFailed } from "../components/KinLoadFailed";
import { kinClient } from "../state/kinClient";
import { kinSignInInApp, kinSignInReturn, useKinConnectionActions } from "./kinConnectionSignIn";
import {
  decodeConnectionId,
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionParams,
  type KinConnectionsParams,
  type KinConnectionsTarget,
} from "./kinConnectionTarget";

const makeKey = Schema.decodeSync(KinConnectionKey);

/** The Add sheet: pick a service, paste its key (or a server's address), Connect. */
export function KinConnectionAddScreen({ route }: StaticScreenProps<KinConnectionsParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.addTitle} sheet />
  ) : (
    <AddForm params={route.params} target={target} />
  );
}

function AddForm(props: {
  readonly params: KinConnectionsParams;
  readonly target: KinConnectionsTarget;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props.target;
  const listAtom = kinClient.connections({ environmentId, input: { orgId } });
  const list = useAtomValue(listAtom);
  const view = Option.getOrNull(AsyncResult.value(list));
  const reload = useAtomRefresh(listAtom);
  const actions = useKinConnectionActions(environmentId, orgId, reload);
  const services = kinAddableServices(view?.services ?? []);
  const [draft, setDraft] = useState<KinConnectionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown =
    draft ?? kinConnectionDraft(services.find((entry) => entry.available)?.service ?? "custom");
  const service = services.find((entry) => entry.service === shown.service);
  const custom = shown.service === "custom";
  const signIn = service?.connect === "sign_in";
  const [changingClient, setChangingClient] = useState(false);
  const [ownClient, setOwnClient] = useState(false);
  const ownerClient =
    service !== undefined && kinIsOwnerClientService(service.service) ? service.service : null;
  const setup = signIn && !ownClient && (service?.needsSetup === true || changingClient);
  const clientSetup = ownerClient === null ? null : KIN_OWNER_CLIENT_SETUP[ownerClient];
  const accountClient = signIn ? (clientSetup?.accountClient ?? null) : null;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const saveClient = async () => {
    if (busy || ownerClient === null) return;
    setBusy(true);
    setProblem(null);
    const saved = await actions.setOwnerClient(ownerClient, clientId, clientSecret);
    setBusy(false);
    if (!saved.ok) return setProblem(saved.problem);
    setChangingClient(false);
  };

  const connect = async (typed?: string) => {
    if (busy || view === null || setup) return;
    setBusy(true);
    setProblem(null);
    const outcome = signIn
      ? await (async () => {
          const started = await actions.signInNew(shown, view.services, kinSignInReturn());
          if (!started.ok) return started;
          const response = await kinSignInInApp(started.value.authorizationUrl);
          if (response === null)
            return { ok: false as const, problem: "The sign-in was closed before it finished." };
          return actions.signInFinish(response);
        })()
      : await actions.add({ ...shown, key: typed ?? shown.key }, view.services);
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    navigation.goBack();
    navigation.navigate("KinConnection", {
      ...props.params,
      connectionId: outcome.value satisfies KinConnectionId,
    });
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={COPY.addTitle}
        onClose={() => navigation.goBack()}
        confirm={{
          label: busy ? COPY.connecting : signIn ? COPY.signIn : COPY.connect,
          onPress: () => void connect(),
          loading: busy,
          disabled: busy || view === null || setup,
        }}
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
            AsyncResult.isFailure(list) ? (
              <KinLoadFailed title={COPY.loadFailed} cause={list} onRetry={reload} />
            ) : (
              <AppActivityIndicator />
            )
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {COPY.intro}
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              <ListSection title={COPY.serviceLabel} footer={service?.setup ?? undefined}>
                {services.map((entry, index) => (
                  <ListChoiceRow
                    key={entry.service}
                    label={entry.label}
                    description={kinServiceNote(entry)}
                    selected={entry.service === shown.service}
                    separated={index > 0}
                    disabled={!entry.available || busy}
                    onPress={() => {
                      setProblem(null);
                      setChangingClient(false);
                      setOwnClient(false);
                      setDraft({ ...kinConnectionDraft(entry.service), key: shown.key });
                    }}
                  />
                ))}
              </ListSection>
              {custom ? (
                <Field label={COPY.urlLabel}>
                  <TextInput
                    accessibilityLabel={COPY.urlLabel}
                    value={shown.url}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder={COPY.urlPlaceholder}
                    placeholderTextColorClassName="accent-placeholder"
                    onChangeText={(url) => setDraft({ ...shown, url })}
                    className="min-h-8 font-sans text-base text-foreground"
                  />
                </Field>
              ) : null}
              <Field label={COPY.nameLabel}>
                <TextInput
                  accessibilityLabel={COPY.nameLabel}
                  value={shown.label}
                  editable={!busy}
                  maxLength={80}
                  autoCorrect={false}
                  placeholder={custom ? COPY.namePlaceholder : (service?.label ?? "")}
                  placeholderTextColorClassName="accent-placeholder"
                  onChangeText={(label) => setDraft({ ...shown, label })}
                  className="min-h-8 font-sans text-base text-foreground"
                />
              </Field>
              {signIn ? null : (
                <Field
                  label={COPY.keyLabel}
                  hint={custom ? `${COPY.keyOptional} ${COPY.keyHint}` : COPY.keyHint}
                >
                  <SecretTextInput
                    accessibilityLabel={COPY.keyLabel}
                    placeholder={COPY.keyPlaceholder}
                    value={shown.key}
                    editable={!busy}
                    onChangeText={(key) => setDraft({ ...shown, key })}
                    onSubmitEditing={(key) => void connect(key)}
                  />
                </Field>
              )}
              {service?.fields.includes("org") === true ? (
                <Field label={COPY.orgLabel}>
                  <TextInput
                    accessibilityLabel={COPY.orgLabel}
                    value={shown.org}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={COPY.orgPlaceholder}
                    placeholderTextColorClassName="accent-placeholder"
                    onChangeText={(org) => setDraft({ ...shown, org })}
                    className="min-h-8 font-sans text-base text-foreground"
                  />
                </Field>
              ) : null}
              {service?.fields.includes("secretUrl") === true ? (
                <Field label={COPY.secretUrlLabel} hint={COPY.secretUrlHint}>
                  <SecretTextInput
                    accessibilityLabel={COPY.secretUrlLabel}
                    placeholder={COPY.secretUrlPlaceholder}
                    value={shown.secretUrl}
                    editable={!busy}
                    onChangeText={(secretUrl) => setDraft({ ...shown, secretUrl })}
                    onSubmitEditing={() => void connect()}
                  />
                </Field>
              ) : null}
              {setup && clientSetup !== null ? (
                <>
                  <ListSection title={clientSetup.title} footer={clientSetup.detail}>
                    {clientSetup.steps.map((step, index) => (
                      <View key={step.text} className="flex-row gap-3 px-4 py-3">
                        <Text className="text-foreground-muted">{index + 1}.</Text>
                        <Text className="flex-1 text-foreground">
                          {step.address ? `${step.text} ${view.signInAddress}` : step.text}
                        </Text>
                      </View>
                    ))}
                    <ListActionRow
                      label={`${COPY.copy}: ${COPY.redirectLabel}`}
                      onPress={() =>
                        void tryCopyTextWithHaptic(view.signInAddress, { target: "address" })
                      }
                    />
                  </ListSection>
                  <Field label={clientSetup.clientIdLabel}>
                    <TextInput
                      accessibilityLabel={clientSetup.clientIdLabel}
                      value={clientId}
                      editable={!busy}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder={clientSetup.clientIdPlaceholder}
                      placeholderTextColorClassName="accent-placeholder"
                      onChangeText={setClientId}
                      className="min-h-8 font-sans text-base text-foreground"
                    />
                  </Field>
                  <Field label={clientSetup.secretLabel} hint={COPY.keyHint}>
                    <SecretTextInput
                      accessibilityLabel={clientSetup.secretLabel}
                      placeholder={clientSetup.secretLabel}
                      value={clientSecret}
                      editable={!busy}
                      onChangeText={setClientSecret}
                      onSubmitEditing={() => void saveClient()}
                    />
                  </Field>
                  <ListSection>
                    <ListActionRow
                      label={COPY.saveClient}
                      loading={busy}
                      onPress={() => void saveClient()}
                    />
                  </ListSection>
                </>
              ) : signIn && clientSetup !== null && !ownClient ? (
                <ListSection>
                  <ListActionRow
                    label={clientSetup.changeClient}
                    onPress={() => setChangingClient(true)}
                  />
                  {accountClient === null ? null : (
                    <ListActionRow label={accountClient.label} onPress={() => setOwnClient(true)} />
                  )}
                </ListSection>
              ) : null}
              {accountClient !== null && clientSetup !== null && ownClient ? (
                <>
                  <Text textRole="body" className="px-2 text-foreground-muted">
                    {accountClient.detail}
                  </Text>
                  <Field label={clientSetup.clientIdLabel}>
                    <TextInput
                      accessibilityLabel={clientSetup.clientIdLabel}
                      value={shown.clientId}
                      editable={!busy}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder={clientSetup.clientIdPlaceholder}
                      placeholderTextColorClassName="accent-placeholder"
                      onChangeText={(clientId) => setDraft({ ...shown, clientId })}
                      className="min-h-8 font-sans text-base text-foreground"
                    />
                  </Field>
                  <Field label={clientSetup.secretLabel} hint={COPY.keyHint}>
                    <SecretTextInput
                      accessibilityLabel={clientSetup.secretLabel}
                      placeholder={clientSetup.secretLabel}
                      value={shown.clientSecret}
                      editable={!busy}
                      onChangeText={(clientSecret) => setDraft({ ...shown, clientSecret })}
                      onSubmitEditing={() => void connect()}
                    />
                  </Field>
                  <ListSection>
                    <ListActionRow
                      label={COPY.usualClient}
                      onPress={() => {
                        setOwnClient(false);
                        setDraft({ ...shown, clientId: "", clientSecret: "" });
                      }}
                    />
                  </ListSection>
                </>
              ) : null}
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

export type KinConnectionEditParams = KinConnectionParams & {
  readonly edit: "rename" | "key" | "note";
};

/** Rename, note what an account is for, or replace the key: one field, saved by the host. */
export function KinConnectionEditScreen({ route }: StaticScreenProps<KinConnectionEditParams>) {
  const target = decodeConnectionsTarget(route.params);
  const connectionId = decodeConnectionId(route.params);
  const edit = route.params.edit;
  const title =
    edit === "rename" ? COPY.renameTitle : edit === "note" ? COPY.noteTitle : COPY.replaceKeyTitle;
  return target === null || connectionId === null ? (
    <KinConnectionsMissing title={title} sheet />
  ) : edit === "note" ? (
    <NoteForm target={target} connectionId={connectionId} />
  ) : (
    <EditForm target={target} connectionId={connectionId} rename={edit === "rename"} />
  );
}

function NoteForm(props: {
  readonly target: KinConnectionsTarget;
  readonly connectionId: KinConnectionId;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props.target;
  const ref = { orgId, connectionId: props.connectionId };
  const detailAtom = kinClient.connection({ environmentId, input: ref });
  const read = useAtomValue(detailAtom);
  const reread = useAtomRefresh(detailAtom);
  const detail = Option.getOrNull(AsyncResult.value(read));
  const update = useAtomCommand(kinClient.connectionUpdate, { reportFailure: false });
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = value ?? detail?.connection.note ?? "";

  const save = async () => {
    // Until the note is read, saving would put an empty field over it.
    if (busy || detail === null) return;
    setBusy(true);
    setProblem(null);
    const note = shown.trim();
    const failed = await kinConnectionChange<unknown>(
      update({ environmentId, input: { ...ref, note: note === "" ? null : note } }),
      "save the note",
    );
    setBusy(false);
    if (failed === null) navigation.goBack();
    else setProblem(failed);
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={COPY.noteTitle}
        onClose={() => navigation.goBack()}
        confirm={{
          label: COPY.save,
          onPress: () => void save(),
          loading: busy,
          disabled: busy || detail === null || shown.trim().length > 200,
        }}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {problem === null ? null : <ErrorBanner message={problem} />}
          {detail === null ? (
            AsyncResult.isFailure(read) ? (
              <KinLoadFailed title="Couldn't load this connection" cause={read} onRetry={reread} />
            ) : (
              <AppActivityIndicator />
            )
          ) : (
            <Field label={COPY.noteLabel} hint={COPY.noteHint}>
              <TextInput
                accessibilityLabel={COPY.noteLabel}
                value={shown}
                editable={!busy}
                autoFocus
                maxLength={200}
                returnKeyType="done"
                placeholder={COPY.notePlaceholder}
                placeholderTextColorClassName="accent-placeholder"
                onChangeText={setValue}
                onSubmitEditing={() => void save()}
                className="min-h-8 font-sans text-base text-foreground"
              />
            </Field>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function EditForm(props: {
  readonly target: KinConnectionsTarget;
  readonly connectionId: KinConnectionId;
  readonly rename: boolean;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props.target;
  const ref = { orgId, connectionId: props.connectionId };
  const detail = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinClient.connection({ environmentId, input: ref }))),
  );
  const update = useAtomCommand(kinClient.connectionUpdate, { reportFailure: false });
  const setKey = useAtomCommand(kinClient.connectionSetKey, { reportFailure: false });
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = value ?? (props.rename ? (detail?.connection.label ?? "") : "");
  const valid = shown.trim() !== "" && shown.trim().length <= (props.rename ? 80 : 4096);

  const save = async (typed?: string) => {
    const text = typed ?? shown;
    if (busy || text.trim() === "") return;
    setBusy(true);
    setProblem(null);
    const failed = await kinConnectionChange<unknown>(
      props.rename
        ? update({ environmentId, input: { ...ref, label: text.trim() } })
        : setKey({ environmentId, input: { ...ref, key: makeKey(text.trim()) } }),
      props.rename ? "rename it" : "replace the key",
    );
    setBusy(false);
    if (failed === null) navigation.goBack();
    else setProblem(failed);
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.rename ? COPY.renameTitle : COPY.replaceKeyTitle}
        onClose={() => navigation.goBack()}
        confirm={{
          label: COPY.save,
          onPress: () => void save(),
          loading: busy,
          disabled: busy || !valid,
        }}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {problem === null ? null : <ErrorBanner message={problem} />}
          {props.rename ? (
            <Field label={COPY.nameLabel}>
              <TextInput
                accessibilityLabel={COPY.nameLabel}
                value={shown}
                editable={!busy}
                autoFocus
                maxLength={80}
                autoCorrect={false}
                returnKeyType="done"
                placeholder={COPY.namePlaceholder}
                placeholderTextColorClassName="accent-placeholder"
                onChangeText={setValue}
                onSubmitEditing={() => void save()}
                className="min-h-8 font-sans text-base text-foreground"
              />
            </Field>
          ) : (
            <Field label={COPY.keyLabel} hint={`${COPY.replaceKeyDetail} ${COPY.keyHint}`}>
              <SecretTextInput
                accessibilityLabel={COPY.keyLabel}
                placeholder={COPY.keyPlaceholder}
                value={shown}
                editable={!busy}
                onChangeText={setValue}
                onSubmitEditing={(text) => void save(text)}
              />
            </Field>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <ListSection>
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">{props.label}</Text>
          {props.children}
        </View>
      </ListSection>
      {props.hint === undefined ? null : (
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          {props.hint}
        </Text>
      )}
    </View>
  );
}
