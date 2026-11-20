import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinPicturesActions,
  KIN_PICTURES_COPY as COPY,
  kinPicturesChoices,
  kinPicturesRows,
  type KinPicturesOutcome,
} from "@t3tools/client-runtime/kin/kinPictures";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking, View } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Notice } from "../../../components/ui/Notice";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import type { KinConnectionsTarget } from "./kinConnectionTarget";

/** Pictures on Settings → Connections; only owners and co-owners reach that screen. */
export function KinPicturesSection(props: { readonly target: KinConnectionsTarget }) {
  const { environmentId, orgId } = props.target;
  const viewAtom = kinClient.pictures({ environmentId, input: { orgId } });
  const result = useAtomValue(viewAtom);
  const reload = useAtomRefresh(viewAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const set = useAtomCommand(kinClient.picturesSet, { reportFailure: false });
  const actions = createKinPicturesActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    reload,
  });
  const [key, setKey] = useState("");
  const [pick, setPick] = useState<{ readonly limit: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (view === null)
    return AsyncResult.isFailure(result) ? (
      <Notice
        tone="danger"
        message={COPY.loadFailed}
        action={{ label: KIN_RETRY, onPress: reload }}
      />
    ) : null;
  const rows = kinPicturesRows(view);
  const selected = rows.connected || pick === null ? rows.limit : pick.limit;

  const run = async (sent: Promise<KinPicturesOutcome>) => {
    setBusy(true);
    const outcome = await sent;
    setBusy(false);
    setProblem(outcome.ok ? null : outcome.problem);
    return outcome.ok;
  };
  const apply = (limit: number | null) => {
    if (rows.connected) void run(actions.setLimit(limit));
    else setPick({ limit });
  };
  const choose = (limit: number | null) =>
    limit === null
      ? Dialog.alert(COPY.noLimitTitle, COPY.noLimitDetail, [
          { text: COPY.cancel, style: "cancel" },
          { text: COPY.noLimit, onPress: () => apply(null) },
        ])
      : apply(limit);
  const connect = (typed?: string) =>
    void run(actions.connect(typed ?? key, selected)).then((ok) => {
      if (!ok) return;
      setKey("");
      setPick(null);
    });
  const confirmDisconnect = () =>
    Dialog.alert(COPY.disconnectTitle, COPY.disconnectDetail, [
      { text: COPY.cancel, style: "cancel" },
      {
        text: COPY.disconnect,
        style: "destructive",
        onPress: () => void run(actions.disconnect()),
      },
    ]);

  return (
    <View className="gap-2">
      {problem === null ? null : <ErrorBanner message={problem} />}
      {rows.connected ? (
        <ListSection title={COPY.title} footer={COPY.intro}>
          <ListRow
            icon="photo"
            label={rows.keyLine ?? ""}
            description={rows.usage}
            onPress={() => undefined}
          />
          <ListActionRow label={COPY.disconnect} tone="danger" onPress={confirmDisconnect} />
        </ListSection>
      ) : (
        <ListSection title={COPY.title} footer={COPY.connectDetail(rows.service)}>
          <ListRow
            icon="photo"
            label={COPY.connectTitle}
            description={COPY.intro}
            onPress={() => undefined}
          />
          <View className="px-4 py-3">
            <SecretTextInput
              accessibilityLabel={COPY.keyLabel}
              placeholder={COPY.keyPlaceholder}
              value={key}
              editable={!busy}
              onChangeText={setKey}
              onSubmitEditing={(typed) => connect(typed)}
            />
          </View>
          <ListActionRow
            label={busy ? COPY.connecting : COPY.connect}
            loading={busy}
            disabled={busy || key.trim() === ""}
            onPress={() => connect()}
          />
          <ListActionRow
            label={COPY.openService(rows.service)}
            onPress={() => void Linking.openURL(rows.keyUrl)}
          />
        </ListSection>
      )}
      <ListSection title={COPY.limitLabel}>
        {kinPicturesChoices(selected).map((choice) => (
          <ListRow
            key={choice.value ?? "none"}
            icon={choice.selected ? "checkmark.circle.fill" : "circle"}
            label={choice.label}
            selected={choice.selected}
            disabled={busy}
            onPress={() => {
              if (!choice.selected) choose(choice.value);
            }}
          />
        ))}
      </ListSection>
    </View>
  );
}
