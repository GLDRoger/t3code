import {
  kinWorkDueChoices,
  kinWorkDueLabel,
  type KinWorkAssignee,
  type KinWorkItemView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  KIN_WORK_STATE_CHOICES,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import { View } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";

const WAITING = "waiting:";
const NOBODY = "waiting";
const DUE = "due:";
const NO_DATE = "due";

/** Where the task stands, other than done: started, waiting on someone, or not worth doing. */
export function KinWorkStatusRow(props: {
  readonly view: KinWorkItemView;
  /** Everyone it could be waiting on. */
  readonly people: ReadonlyArray<KinWorkAssignee>;
  readonly disabled: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view, people } = props;
  return (
    <Menu
      title={KIN_WORK_COPY.status}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_WORK_COPY.status}: ${view.status}. Change`}
      actions={[
        ...KIN_WORK_STATE_CHOICES.map((choice) => ({
          id: choice.state,
          title: choice.label,
          state: view.state === choice.state ? ("on" as const) : ("off" as const),
        })),
        {
          id: "waiting-on",
          title: KIN_WORK_COPY.waitingOn,
          subactions: [
            ...people.map((to) => ({
              id: `${WAITING}${to.key}`,
              title: to.name,
              state: to.current ? ("on" as const) : ("off" as const),
            })),
            { id: NOBODY, title: KIN_WORK_COPY.waitingOnNobody },
          ],
        },
        { id: "dropped", title: KIN_WORK_COPY.drop, attributes: { destructive: true } },
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === "open" || event === "doing" || event === "dropped")
          return props.onAct({ type: "state", state: event });
        if (event === NOBODY)
          return props.onAct({ type: "state", state: "waiting", waitingOn: null });
        const on = people.find((to) => `${WAITING}${to.key}` === event);
        if (on !== undefined)
          props.onAct({ type: "state", state: "waiting", waitingOn: on.principal });
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout
          icon="circle.dashed"
          label={KIN_WORK_COPY.status}
          detail={view.status}
          disabled={props.disabled}
        />
      </View>
    </Menu>
  );
}

/** The due date: the days people pick on a phone, or none. */
export function KinWorkDueRow(props: {
  readonly view: KinWorkItemView;
  readonly now: Date;
  readonly disabled: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view, now } = props;
  const due = view.due === null ? KIN_WORK_COPY.noDate : capital(view.due);
  return (
    <Menu
      title="Due"
      accessibilityRole="button"
      accessibilityLabel={`Due: ${due}. Change`}
      actions={[
        ...kinWorkDueChoices(now).map((choice) => {
          const date = kinWorkDueLabel(choice.day, now);
          return {
            id: `${DUE}${choice.day}`,
            title: choice.label,
            ...(date.toLowerCase() === choice.label.toLowerCase() ? {} : { subtitle: date }),
            state: choice.day === view.dueDay ? ("on" as const) : ("off" as const),
          };
        }),
        ...(view.due === null ? [] : [{ id: NO_DATE, title: KIN_WORK_COPY.noDate }]),
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === NO_DATE) return props.onAct({ type: "due", day: null });
        if (event.startsWith(DUE)) props.onAct({ type: "due", day: event.slice(DUE.length) });
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout icon="clock" label="Due" detail={due} disabled={props.disabled} />
      </View>
    </Menu>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
