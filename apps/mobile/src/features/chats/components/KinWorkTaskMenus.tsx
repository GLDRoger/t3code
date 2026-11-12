import {
  kinWorkDueChoices,
  kinWorkDueLabel,
  KIN_WORK_ASSIGN,
  KIN_WORK_NEW_COPY,
  type KinWorkAssignee,
  type KinWorkItemView,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  KIN_WORK_STATE_CHOICES,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import { View } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
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
              ...(to.invited
                ? { subtitle: KIN_WORK_ASSIGN.invited, attributes: { disabled: true } }
                : {}),
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
        if (on !== undefined && on.invited !== true)
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

const NONE = "none";

/** The client or the project something sits under: one of the ones there are, or none. */
export function KinWorkPlaceRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly none: string;
  readonly held: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly disabled: boolean;
  readonly onPick: (ref: KinWorkRef | null) => void;
}) {
  const { held } = props;
  // The one it already has stays pickable after that one closes.
  const choices =
    held === null || props.choices.some((choice) => choice.key === held.key)
      ? props.choices
      : [held, ...props.choices];
  const detail = held?.title ?? props.none;
  return (
    <Menu
      title={props.label}
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${detail}. Change`}
      actions={[
        ...choices.map((choice) => ({
          id: choice.key,
          title: choice.title,
          state: choice.key === held?.key ? ("on" as const) : ("off" as const),
        })),
        { id: NONE, title: props.none, state: held === null ? ("on" as const) : ("off" as const) },
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === NONE) return props.onPick(null);
        const picked = choices.find((choice) => choice.key === event);
        if (picked !== undefined) props.onPick(picked);
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout
          icon={props.icon}
          label={props.label}
          detail={detail}
          disabled={props.disabled}
        />
      </View>
    </Menu>
  );
}

const SIDES = [
  { id: "ours", title: KIN_WORK_NEW_COPY.sideOurs },
  { id: "theirs", title: KIN_WORK_NEW_COPY.sideTheirs },
] as const;

/** Whose move it is, for a task under a client: ours to do, or theirs. */
export function KinWorkSideRow(props: {
  readonly side: "ours" | "theirs";
  readonly disabled: boolean;
  readonly onPick: (side: "ours" | "theirs") => void;
}) {
  const detail = SIDES.find((side) => side.id === props.side)?.title ?? "";
  return (
    <Menu
      title={KIN_WORK_NEW_COPY.sideLabel}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_WORK_NEW_COPY.sideLabel}: ${detail}. Change`}
      actions={SIDES.map((side) => ({
        id: side.id,
        title: side.title,
        state: side.id === props.side ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === "ours" || event === "theirs") props.onPick(event);
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout
          icon="arrow.left.arrow.right"
          label={KIN_WORK_NEW_COPY.sideLabel}
          detail={detail}
          disabled={props.disabled}
        />
      </View>
    </Menu>
  );
}
