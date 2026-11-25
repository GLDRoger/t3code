import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_DOCS,
  KIN_DOC_HOMES,
  KIN_DOC_KIND_LABELS,
  kinDocFileDraft,
  kinDocFileInput,
  type KinDocFileDraft,
} from "@t3tools/client-runtime/kin/kinDocs";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  EnvironmentId,
  KIN_DOC_KINDS,
  KinOrgId,
  KinRecordKey,
  type KinDocDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinDoc } from "./state/useKinDocs";
import { kinWorkChoicesAtom, type KinWorkTarget } from "./state/useKinWork";
import { useKinSectionOn } from "./state/useKinShell";

export type KinDocFileParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly doc: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

function Frame(props: {
  readonly onClose: () => void;
  readonly onSave?: () => void;
  readonly saving?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_DOC_HOMES.fileTitle} onClose={props.onClose} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
          {props.onSave === undefined ? null : (
            <Button
              tone="primary"
              label="Save"
              loading={props.saving === true}
              disabled={props.saving === true}
              onPress={props.onSave}
            />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** A sheet on a doc: what kind it is, and its home, a client and project or the company. */
export function KinDocFileScreen({ route }: StaticScreenProps<KinDocFileParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.doc));
  if (environmentId === null || orgId === null || key === null)
    return (
      <Frame onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_DOCS.gone} />
      </Frame>
    );
  return <KinDocFileBody environmentId={environmentId} orgId={orgId} docKey={key} />;
}

function KinDocFileBody(props: KinWorkTarget & { readonly docKey: KinRecordKey }) {
  const navigation = useNavigation();
  const { state } = useKinDoc(props, props.docKey, null);
  const close = () => navigation.goBack();
  if (state._tag !== "ready")
    return (
      <Frame onClose={close}>
        {state._tag === "loading" ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : (
          <EmptyState variant="plain" {...KIN_DOCS.failed} />
        )}
      </Frame>
    );
  return <KinDocFileForm {...props} doc={state.value} onDone={close} />;
}

function KinDocFileForm(
  props: KinWorkTarget & { readonly doc: KinDocDetail; readonly onDone: () => void },
) {
  const { environmentId, orgId, doc } = props;
  const file = useAtomCommand(kinClient.docFile, { reportFailure: false });
  const held = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinWorkChoicesAtom({ environmentId, orgId }))),
  );
  // With Clients off a doc is filed under the company or nothing, never a client.
  const clientsOn = useKinSectionOn(environmentId, "clients");
  const clients = clientsOn
    ? (held?.clients ?? []).filter((one) => one.active && one.kind === "client")
    : [];
  const [draft, setDraft] = useState<KinDocFileDraft>(() => kinDocFileDraft(doc));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const projects = (held?.projects ?? []).filter(
    (one) =>
      one.state === "open" &&
      (draft.home === "none" ? one.party === null : one.party?.key === draft.home),
  );
  const save = async () => {
    setSaving(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => file({ environmentId, input: kinDocFileInput(orgId, doc, draft) }),
    });
    setSaving(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    props.onDone();
  };
  const homes = [
    { value: "company", label: KIN_DOC_HOMES.company },
    ...clients.map((one) => ({ value: String(one.key), label: one.name })),
    { value: "none", label: "No client" },
  ];
  return (
    <Frame onClose={props.onDone} onSave={() => void save()} saving={saving}>
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection title={KIN_DOC_HOMES.home}>
        {homes.map((home, index) => (
          <ListChoiceRow
            key={home.value}
            label={home.label}
            separated={index > 0}
            selected={draft.home === home.value}
            onPress={() => setDraft({ ...draft, home: home.value, project: null })}
          />
        ))}
      </ListSection>
      {draft.home === "company" || projects.length === 0 ? null : (
        <ListSection title="Project">
          {[{ key: null, name: "No project" }, ...projects].map((project, index) => (
            <ListChoiceRow
              key={String(project.key)}
              label={project.name}
              separated={index > 0}
              selected={draft.project === project.key}
              onPress={() => setDraft({ ...draft, project: project.key })}
            />
          ))}
        </ListSection>
      )}
      <ListSection title={KIN_DOC_HOMES.kind}>
        {KIN_DOC_KINDS.map((kind, index) => (
          <ListChoiceRow
            key={kind}
            label={KIN_DOC_KIND_LABELS[kind].one}
            separated={index > 0}
            selected={draft.kind === kind}
            onPress={() => setDraft({ ...draft, kind })}
          />
        ))}
      </ListSection>
    </Frame>
  );
}
