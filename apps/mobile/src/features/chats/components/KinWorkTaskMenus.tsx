import {
  kinWorkDueChoices,
  kinWorkDueLabel,
  KIN_WORK_ASSIGN,
  KIN_WORK_NEW_COPY,
  type KinWorkAssignee,
  type KinWorkItemView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_COPY,
  kinWorkStatusOffer,
  type KinWorkAction,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinTaskPageStatus } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { View } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";

const WAITING = "waiting:";
const NOBODY = "waiting";
const REOPEN = "reopen";
const DUE = "due:";
const NO_DATE = "due";

/** Where the task stands: done, reopened, started, or waiting on someone. Drop is in •••. */
export function KinWorkStatusRow(props: {
  readonly view: KinWorkItemView;
  /** What the host takes (`kinWorkStatusOffer`). */
  readonly offer: ReturnType<typeof kinWorkStatusOffer>;
  /** Which of it this viewer gets on the page (`kinTaskControls`). */
  readonly status: KinTaskPageStatus;
  /** Everyone it could be waiting on. */
  readonly people: ReadonlyArray<KinWorkAssignee>;
  readonly disabled: boolean;
  readonly onAct: (action: KinWorkAction) => void;
}) {
  const { view, people, offer, status } = props;
  const note = view.leadNote === null ? {} : { subtitle: view.leadNote };
  return (
    <Menu
      title={KIN_WORK_COPY.status}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_WORK_COPY.status}: ${view.status}. Change`}
      actions={[
        ...(status.done ? [{ id: "done", title: KIN_WORK_COPY.done, ...note }] : []),
        ...(status.reopen ? [{ id: REOPEN, title: KIN_WORK_COPY.reopen, ...note }] : []),
        ...(!status.states
          ? []
          : offer.states.map((choice) => ({
              id: choice.state,
              title: choice.label,
              state: view.state === choice.state ? ("on" as const) : ("off" as const),
            }))),
        ...(!status.waiting
          ? []
          : [
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
            ]),
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === REOPEN) return props.onAct({ type: "state", state: "open" });
        if (event === "open" || event === "doing" || event === "done")
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
  /** Past due and still open: drawn in the danger colour. */
  readonly late?: boolean;
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
        <ListRowLayout
          icon="clock"
          label="Due"
          detail={due}
          disabled={props.disabled}
          {...(props.late ? { tone: "danger" as const } : {})}
        />
      </View>
    </Menu>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const SIDES = [
  { id: "none", title: KIN_WORK_NEW_COPY.sideNone },
  { id: "ours", title: KIN_WORK_NEW_COPY.sideOurs },
  { id: "theirs", title: KIN_WORK_NEW_COPY.sideTheirs },
] as const;

/** Who owes a task under a client, which makes it an obligation; nobody by default. */
export function KinWorkSideRow(props: {
  readonly side: "ours" | "theirs" | null;
  readonly disabled: boolean;
  readonly onPick: (side: "ours" | "theirs" | null) => void;
}) {
  const detail = SIDES.find((side) => side.id === (props.side ?? "none"))?.title ?? "";
  return (
    <Menu
      title={KIN_WORK_NEW_COPY.sideLabel}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_WORK_NEW_COPY.sideLabel}: ${detail}. Change`}
      actions={SIDES.map((side) => ({
        id: side.id,
        title: side.title,
        state: side.id === (props.side ?? "none") ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled) return;
        if (event === "ours" || event === "theirs") props.onPick(event);
        else if (event === "none") props.onPick(null);
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
