import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_NEW_COPY,
  KIN_WORK_NOTES_MAX,
  KIN_WORK_ONLY_OWNER,
  KIN_WORK_TITLE_MAX,
  kinWorkItemState,
} from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_COPY, kinWorkEditMoved } from "@t3tools/client-runtime/kin/kinWorkChanges";
import { EnvironmentId, KinOrgId, KinRecordKey, type KinRecordDetail } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import type { KinWorkItemParams } from "./KinWorkItemScreen";
import { kinClient } from "./state/kinClient";
import {
  useKinWorkChanges,
  useKinWorkDirectory,
  useKinWorkItemWatch,
  type KinWorkTarget,
} from "./state/useKinWork";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** A task's title and notes, retyped. What is typed stays until the host has it. */
export function KinWorkEditScreen({ route }: StaticScreenProps<KinWorkItemParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <Frame onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a task"
          detail="Open Work from your Kin chats."
        />
      </Frame>
    );
  }
  return <KinWorkEditGate environmentId={environmentId} orgId={orgId} itemKey={key} />;
}

function Frame(props: {
  readonly onClose: () => void;
  readonly confirm?: React.ComponentProps<typeof AppBar>["confirm"];
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={KIN_WORK_COPY.editTitle}
        onClose={props.onClose}
        {...(props.confirm === undefined ? {} : { confirm: props.confirm })}
      />
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

type ItemTarget = KinWorkTarget & { readonly itemKey: KinRecordKey };

function KinWorkEditGate(props: ItemTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.workUpdate.permissionAtom(props.environmentId));
  const itemAtom = kinClient.workItem({
    environmentId: props.environmentId,
    input: { orgId: props.orgId, key: props.itemKey },
  });
  const read = useAtomValue(itemAtom);
  const state = kinWorkItemState(read, null);
  const close = () => navigation.goBack();
  if (!allowed) {
    return (
      <Frame onClose={close}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </Frame>
    );
  }
  if (state._tag !== "ready") {
    return (
      <Frame onClose={close}>
        {state._tag === "loading" ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : state._tag === "gone" ? (
          <EmptyState variant="plain" {...KIN_WORK_GONE} />
        ) : (
          <EmptyState
            variant="plain"
            {...KIN_WORK_ITEM_FAILED}
            action={
              <Button
                tone="secondary"
                label="Try again"
                onPress={() => appAtomRegistry.refresh(itemAtom)}
              />
            }
          />
        )}
      </Frame>
    );
  }
  return <KinWorkEditForm {...props} item={state.item} reading={read.waiting} />;
}

function KinWorkEditForm(
  props: ItemTarget & {
    readonly item: KinRecordDetail;
    /** A change made just before is still being read back; its old revision would be refused. */
    readonly reading: boolean;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, itemKey, item } = props;
  const { names } = useKinWorkDirectory(props, true);
  // The form opens holding the task as it was read; the host's later word never retypes it.
  const { state: changed, changes } = useKinWorkChanges(props, item);
  useKinWorkItemWatch(props, itemKey, item.seq);
  const { edit } = changed;
  const moved = edit === null ? null : kinWorkEditMoved(edit, item);
  const saving = changed.pending[itemKey] !== undefined;
  const notice = changed.notice?.key === itemKey ? changed.notice : null;

  const save = async () => {
    if (saving || props.reading) return;
    if (!(await changes.saveEdit(item, names))) return;
    appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }));
    navigation.goBack();
  };

  return (
    <Frame
      onClose={() => navigation.goBack()}
      confirm={{
        label: KIN_WORK_COPY.save,
        onPress: () => void save(),
        loading: saving,
        disabled: saving || props.reading || edit === null || edit.title.trim() === "",
      }}
    >
      {notice === null ? null : (
        <Notice message={notice.text} tone={notice.kind === "failed" ? "danger" : "default"} />
      )}
      <ListSection>
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">Title</Text>
          <TextInput
            accessibilityLabel="Title"
            value={edit?.title ?? ""}
            editable={!saving}
            autoFocus
            autoCapitalize="sentences"
            returnKeyType="done"
            maxLength={KIN_WORK_TITLE_MAX}
            onChangeText={(title) => changes.setEdit({ title })}
            textAlignVertical="center"
            placeholder={KIN_WORK_NEW_COPY.titlePlaceholder}
            placeholderTextColorClassName="accent-placeholder"
            className="min-h-8 font-sans text-base text-foreground"
          />
        </View>
      </ListSection>
      {moved?.title == null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          It now says: {moved.title}
        </Text>
      )}
      <ListSection>
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">{KIN_WORK_NEW_COPY.notesLabel}</Text>
          <TextInput
            accessibilityLabel={KIN_WORK_NEW_COPY.notesLabel}
            value={edit?.notes ?? ""}
            editable={!saving}
            multiline
            maxLength={KIN_WORK_NOTES_MAX}
            onChangeText={(notes) => changes.setEdit({ notes })}
            textAlignVertical="top"
            placeholder={KIN_WORK_NEW_COPY.notesPlaceholder}
            placeholderTextColorClassName="accent-placeholder"
            className="min-h-24 font-sans text-base text-foreground"
          />
        </View>
      </ListSection>
      {moved?.notes == null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          They now say: {moved.notes}
        </Text>
      )}
    </Frame>
  );
}
