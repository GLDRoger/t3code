import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CONNECTIONS_COPY as COPY,
  createKinConnectionActions,
  kinAddableServices,
  kinConnectionChange,
  kinConnectionDraft,
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
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
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
  const view = Option.getOrNull(AsyncResult.value(useAtomValue(listAtom)));
  const reload = useAtomRefresh(listAtom);
  const add = useAtomCommand(kinClient.connectionAdd, { reportFailure: false });
  const remove = useAtomCommand(kinClient.connectionRemove, { reportFailure: false });
  const actions = createKinConnectionActions({
    orgId,
    add: (input) => add({ environmentId, input }),
    remove: (input) => remove({ environmentId, input }),
    refresh: reload,
  });
  const services = kinAddableServices(view?.services ?? []);
  const [draft, setDraft] = useState<KinConnectionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown =
    draft ?? kinConnectionDraft(services.find((entry) => entry.available)?.service ?? "custom");
  const service = services.find((entry) => entry.service === shown.service);
  const custom = shown.service === "custom";

  const connect = async (typed?: string) => {
    if (busy || view === null) return;
    setBusy(true);
    setProblem(null);
    const outcome = await actions.add({ ...shown, key: typed ?? shown.key }, view.services);
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
          label: busy ? COPY.connecting : COPY.connect,
          onPress: () => void connect(),
          loading: busy,
          disabled: busy || view === null,
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
            <AppActivityIndicator />
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
                    description={entry.available ? undefined : COPY.soon}
                    selected={entry.service === shown.service}
                    separated={index > 0}
                    disabled={!entry.available || busy}
                    onPress={() => {
                      setProblem(null);
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
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

export type KinConnectionEditParams = KinConnectionParams & { readonly edit: "rename" | "key" };

/** Rename, or replace the key: one field, saved and checked by the host. */
export function KinConnectionEditScreen({ route }: StaticScreenProps<KinConnectionEditParams>) {
  const target = decodeConnectionsTarget(route.params);
  const connectionId = decodeConnectionId(route.params);
  const rename = route.params.edit === "rename";
  return target === null || connectionId === null ? (
    <KinConnectionsMissing title={rename ? COPY.renameTitle : COPY.replaceKeyTitle} sheet />
  ) : (
    <EditForm target={target} connectionId={connectionId} rename={rename} />
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
