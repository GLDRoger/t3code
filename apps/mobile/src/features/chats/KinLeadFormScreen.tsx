import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, KinAgentId, KinOrgId, type KinLeadProfile } from "@t3tools/contracts";
import {
  KIN_LEAD_CHARTER_MAX,
  KIN_LEAD_NAME_MAX,
  kinLeadChanges,
  KIN_LEAD_INTRO_MAX,
  kinLeadDraftCheck,
  kinLeadDraftOf,
  kinLeadSaveProblem,
  type KinLeadDraft,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";

export type KinLeadFormParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The lead to edit; unset makes a new one. */
  readonly agentId?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeAgentId = Schema.decodeUnknownOption(KinAgentId);

const NEW_LEAD: KinLeadDraft = { name: "", area: "", charter: "", intro: "" };

/** Makes a lead, or changes one's name, area and what it is for. */
export function KinLeadFormScreen({ route }: StaticScreenProps<KinLeadFormParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const agentId =
    route.params.agentId === undefined
      ? null
      : Option.getOrNull(decodeAgentId(route.params.agentId));
  if (
    environmentId === null ||
    orgId === null ||
    (route.params.agentId !== undefined && !agentId)
  ) {
    return (
      <FormFrame title="Agent" onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name an agent"
          detail="Open an agent from its chat."
        />
      </FormFrame>
    );
  }
  return agentId === null ? (
    <LeadForm environmentId={environmentId} orgId={orgId} lead={null} />
  ) : (
    <EditLead environmentId={environmentId} orgId={orgId} agentId={agentId} />
  );
}

function FormFrame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly confirm?: ComponentProps<typeof AppBar>["confirm"];
  readonly children: ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onClose={props.onClose} confirm={props.confirm} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function EditLead(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const navigation = useNavigation();
  const result = useAtomValue(
    kinClient.leads({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
  );
  const lead = AsyncResult.isSuccess(result)
    ? (result.value.leads.find((held) => held.agentId === props.agentId) ?? null)
    : null;
  if (lead !== null) {
    return <LeadForm environmentId={props.environmentId} orgId={props.orgId} lead={lead} />;
  }
  return (
    <FormFrame title="Edit agent" onClose={() => navigation.goBack()}>
      {AsyncResult.isInitial(result) ? (
        <View className="items-center py-12">
          <AppActivityIndicator />
        </View>
      ) : (
        <EmptyState
          variant="plain"
          title="Couldn't load this agent"
          detail="Close this and open the agent again."
        />
      )}
    </FormFrame>
  );
}

function LeadForm(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly lead: KinLeadProfile | null;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, lead } = props;
  const creating = lead === null;
  const [initial] = useState<KinLeadDraft>(() => (lead === null ? NEW_LEAD : kinLeadDraftOf(lead)));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{
    readonly field: keyof KinLeadDraft | null;
    readonly text: string;
  } | null>(null);
  // Set once the save lands, so the removal guard lets the form close.
  const saved = useRef(false);
  const create = useAtomCommand(kinClient.leadCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.leadUpdate, { reportFailure: false });
  const allowed = useAtomValue(
    (creating ? kinClient.leadCreate : kinClient.leadUpdate).permissionAtom(environmentId),
  );
  const dirty =
    draft.name !== initial.name ||
    draft.area !== initial.area ||
    draft.charter !== initial.charter ||
    draft.intro !== initial.intro;

  usePreventRemove(dirty || saving, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) return;
    Dialog.alert(
      creating ? "Discard this agent?" : "Discard changes?",
      "What you typed will be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => navigation.dispatch(data.action),
        },
      ],
    );
  });

  const set = (patch: Partial<KinLeadDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };

  const refreshLeads = () => {
    appAtomRegistry.refresh(kinClient.leads({ environmentId, input: { orgId } }));
    // Chat titles read lead names from the directory.
    appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
  };

  const save = async () => {
    if (saving) return;
    const checked = kinLeadDraftCheck(draft);
    if (!checked.ok) {
      setProblem({ field: checked.field, text: checked.problem });
      return;
    }
    const { name, domain, charter, intro } = checked;
    if (lead !== null) {
      const changes = kinLeadChanges(lead, checked);
      if (changes === null) {
        saved.current = true;
        navigation.goBack();
        return;
      }
      setSaving(true);
      const result = await update({
        environmentId,
        input: { orgId, agentId: lead.agentId, ...changes },
      });
      setSaving(false);
      if (!AsyncResult.isSuccess(result)) {
        setProblem({
          field: null,
          text: kinLeadSaveProblem(
            AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
            false,
          ),
        });
        return;
      }
      saved.current = true;
      refreshLeads();
      navigation.goBack();
      return;
    }
    setSaving(true);
    const result = await create({
      environmentId,
      input: { orgId, name, domain, charter, ...(intro === "" ? undefined : { intro }) },
    });
    setSaving(false);
    if (!AsyncResult.isSuccess(result)) {
      setProblem({
        field: null,
        text: kinLeadSaveProblem(
          AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
          true,
        ),
      });
      return;
    }
    saved.current = true;
    refreshLeads();
    navigation.goBack();
    navigation.navigate("KinChat", {
      environmentId,
      orgId,
      chatId: result.value.ownerChatId,
    });
  };

  const left = KIN_LEAD_CHARTER_MAX - draft.charter.length;
  return (
    <FormFrame
      title={creating ? "New agent" : "Edit agent"}
      onClose={() => navigation.goBack()}
      confirm={{
        label: creating ? "Create" : "Save",
        onPress: () => void save(),
        loading: saving,
        disabled: !allowed || saving || (!creating && !dirty),
      }}
    >
      {problem?.field === null ? <ErrorBanner message={problem.text} /> : null}
      {allowed ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {creating
            ? "This phone isn't allowed to add agents on this server."
            : "This phone isn't allowed to change agents on this server."}
        </Text>
      )}
      <View className="gap-2">
        <ListSection>
          <Field
            label="Name"
            value={draft.name}
            placeholder="Growth lead"
            maxLength={KIN_LEAD_NAME_MAX}
            editable={allowed && !saving}
            autoFocus={creating}
            autoCapitalize="words"
            onChange={(name) => set({ name })}
          />
          <Field
            label="Area"
            value={draft.area}
            placeholder="Growth"
            maxLength={40}
            editable={allowed && !saving}
            autoCapitalize="sentences"
            borderTop
            onChange={(area) => set({ area })}
          />
        </ListSection>
        <Note
          problem={problem?.field === "name" || problem?.field === "area" ? problem.text : null}
          hint="The area is what it looks after, such as growth or finance. Leave it blank to use the name."
        />
      </View>
      <View className="gap-2">
        <ListSection title="What it's responsible for">
          <TextInput
            multiline
            accessibilityLabel="What it's responsible for"
            value={draft.charter}
            editable={allowed && !saving}
            maxLength={KIN_LEAD_CHARTER_MAX}
            onChangeText={(charter) => set({ charter })}
            placeholder="Owns growth and marketing: launch plans, campaigns and the numbers behind them. Drafts for me to approve. Never publishes or spends on its own."
            placeholderTextColorClassName="accent-placeholder"
            textAlignVertical="top"
            className="min-h-36 px-4 py-3 font-sans text-base leading-normal text-foreground"
          />
        </ListSection>
        <Note
          problem={problem?.field === "charter" ? problem.text : null}
          hint={
            left <= 100
              ? `It reads this before every reply. ${left} characters left.`
              : "It reads this before every reply. Say what it owns and what it must never do on its own."
          }
        />
      </View>
      <View className="gap-2">
        <ListSection title="What teammates see">
          <TextInput
            multiline
            accessibilityLabel="What teammates see"
            value={draft.intro}
            editable={allowed && !saving}
            maxLength={KIN_LEAD_INTRO_MAX}
            onChangeText={(intro) => set({ intro })}
            placeholder="Handles billing questions and invoices."
            placeholderTextColorClassName="accent-placeholder"
            textAlignVertical="top"
            className="min-h-20 px-4 py-3 font-sans text-base leading-normal text-foreground"
          />
        </ListSection>
        <Note
          problem={problem?.field === "intro" ? problem.text : null}
          hint="Optional. People you let message this agent see this and nothing above."
        />
      </View>
    </FormFrame>
  );
}

/** Under a group: what to fix when the save was held back, else what the fields mean. */
function Note(props: { readonly problem: string | null; readonly hint: string }) {
  return (
    <Text
      textRole="footnote"
      accessibilityLiveRegion={props.problem === null ? "none" : "polite"}
      className={
        props.problem === null ? "px-4 text-foreground-muted" : "px-4 text-danger-foreground"
      }
    >
      {props.problem ?? props.hint}
    </Text>
  );
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly maxLength: number;
  readonly editable: boolean;
  readonly autoFocus?: boolean;
  readonly autoCapitalize: "words" | "sentences";
  readonly borderTop?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        editable={props.editable}
        autoFocus={props.autoFocus}
        autoCapitalize={props.autoCapitalize}
        maxLength={props.maxLength}
        onChangeText={props.onChange}
        textAlignVertical="center"
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-placeholder"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}
