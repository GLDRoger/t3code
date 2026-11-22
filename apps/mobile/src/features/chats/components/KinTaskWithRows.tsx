import { KIN_TASK_WITH, type kinTaskWith } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { KinAvatar } from "./KinAvatar";

/**
 * Details' With line: who else is on the task, × beside each where the reader may take them off,
 * Leave beside the reader's own name, and a row to put someone on it.
 */
export function KinTaskWithRows(props: {
  readonly with: ReturnType<typeof kinTaskWith>;
  readonly saving: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (key: string) => void;
  readonly onLeave: () => void;
}) {
  const { people, add, full } = props.with;
  return (
    <>
      <ListRowLayout icon="person.2" label={KIN_TASK_WITH.label} />
      {people.map((who) => (
        <View key={who.key} className="min-h-12 flex-row items-center gap-3 pr-2 pl-[52px]">
          <KinAvatar avatar={who.avatar} size="small" />
          <View className="min-w-0 flex-1">
            <Text textRole="body" numberOfLines={1} className="text-foreground">
              {who.name}
            </Text>
            {who.status === null ? null : (
              <Text textRole="footnote" className="text-foreground-muted">
                {who.status}
              </Text>
            )}
          </View>
          {who.act === "remove" ? (
            <IconButton
              icon="xmark"
              tintColorClassName="accent-icon-muted"
              accessibilityLabel={KIN_TASK_WITH.remove(who.name)}
              disabled={props.saving}
              onPress={() => props.onRemove(who.key)}
            />
          ) : who.act === "leave" ? (
            <View className="pr-2">
              <Button
                tone="secondary"
                size="compact"
                label={KIN_TASK_WITH.leave}
                accessibilityLabel={KIN_TASK_WITH.leaveLabel}
                disabled={props.saving}
                onPress={props.onLeave}
              />
            </View>
          ) : null}
        </View>
      ))}
      {add ? (
        <ListActionRow
          icon="plus"
          label={KIN_TASK_WITH.add}
          disabled={props.saving}
          onPress={props.onAdd}
        />
      ) : null}
      {full === null ? null : (
        <View className="px-4 pb-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {full}
          </Text>
        </View>
      )}
    </>
  );
}
