import { KIN_TASK_WITH, type kinTaskWith } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";

const ADD = "add";
const LEAVE = "leave";
const REMOVE = "remove:";

/**
 * Details' With row: who else is on the task. Where the reader may take someone off or leave, it
 * opens a menu with those and "Put someone on it"; where adding is all there is, it opens the
 * picker; otherwise it is plain text.
 */
export function KinTaskWithRow(props: {
  readonly value: string;
  readonly opens: "menu" | "add" | null;
  readonly with: ReturnType<typeof kinTaskWith>;
  readonly saving: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (key: string) => void;
  readonly onLeave: () => void;
}) {
  const { people, add, full } = props.with;
  const content = {
    icon: "person.2" as const,
    label: KIN_TASK_WITH.label,
    detail: props.value,
    detailEllipsizeMode: "tail" as const,
    disabled: props.saving,
  };
  if (props.opens === null) return <ListRowLayout {...content} />;
  if (props.opens === "add") return <ListRow {...content} onPress={props.onAdd} />;
  return (
    <Menu
      title={KIN_TASK_WITH.label}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_TASK_WITH.label}: ${props.value}`}
      actions={[
        ...people.flatMap((who) =>
          who.act === "remove"
            ? [
                {
                  id: `${REMOVE}${who.key}`,
                  title: KIN_TASK_WITH.remove(who.name),
                  ...(who.status === null ? {} : { subtitle: who.status }),
                  attributes: { destructive: true },
                },
              ]
            : who.act === "leave"
              ? [{ id: LEAVE, title: KIN_TASK_WITH.leaveLabel, attributes: { destructive: true } }]
              : [],
        ),
        ...(add ? [{ id: ADD, title: KIN_TASK_WITH.add }] : []),
        ...(full === null ? [] : [{ id: "full", title: full, attributes: { disabled: true } }]),
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.saving) return;
        if (event === ADD) return props.onAdd();
        if (event === LEAVE) return props.onLeave();
        if (event.startsWith(REMOVE)) props.onRemove(event.slice(REMOVE.length));
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout
          {...content}
          accessory={
            <SymbolView
              name="chevron.right"
              size={16}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          }
        />
      </View>
    </Menu>
  );
}
