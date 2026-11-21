import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_DEALS,
  KIN_DEAL_QUIET,
  KIN_DEAL_STAGES,
  kinDealQuietProblem,
  kinDealStagesProblem,
} from "@t3tools/client-runtime/kin/kinDeals";
import type { KinDealStagesResult } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { NO_LINK, targetOf } from "./KinWorkFormScreens";
import { useKinDealQuietDaysSet, useKinDealStages, useKinDealStagesSet } from "./state/useKinDeals";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinDealStagesParams = {
  readonly environmentId: string;
  readonly orgId: string;
};

/** Settings → Deals: the company's stages, with Won and Lost as fixed ends. */
export function KinDealStagesScreen({ route }: StaticScreenProps<KinDealStagesParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_DEAL_STAGES.title} onBack={() => navigation.goBack()}>
        {NO_LINK}
      </KinWorkFrame>
    );
  return <DealStages {...target} />;
}

function DealStages(props: KinWorkTarget) {
  const navigation = useNavigation();
  const { state, refresh } = useKinDealStages(props);
  if (state._tag === "ready")
    // A fresh draft for each version of the stages, so a save from elsewhere shows at once.
    return <StagesEditor key={state.value.rev} {...props} held={state.value} onRefresh={refresh} />;
  return (
    <KinWorkFrame title={KIN_DEAL_STAGES.title} onBack={() => navigation.goBack()}>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading stages" />
      ) : state._tag === "failed" ? (
        <KinLoadFailed title={KIN_DEALS.stagesFailed} cause={state.cause} onRetry={refresh} />
      ) : (
        <EmptyState
          variant="plain"
          title={KIN_DEAL_STAGES.title}
          detail={KIN_DEAL_STAGES.readOnly}
        />
      )}
    </KinWorkFrame>
  );
}

interface Row {
  readonly id: string | null;
  readonly name: string;
  /** A stable key for a row not saved yet. */
  readonly key: string;
}

const ACTIONS = { rename: "rename", up: "up", down: "down", remove: "remove" } as const;

function StagesEditor(
  props: KinWorkTarget & { readonly held: KinDealStagesResult; readonly onRefresh: () => void },
) {
  const navigation = useNavigation();
  const { held } = props;
  const save = useKinDealStagesSet(props);
  const [rows, setRows] = useState<ReadonlyArray<Row>>(() =>
    held.stages.map((stage) => ({ id: stage.id, name: stage.name, key: stage.id })),
  );
  const [moveTo, setMoveTo] = useState<Readonly<Record<string, string>>>({});
  const [removing, setRemoving] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  if (!held.can)
    return (
      <KinWorkFrame
        title={KIN_DEAL_STAGES.title}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
      >
        <ListSection title={KIN_DEAL_STAGES.stages} footer={KIN_DEAL_STAGES.readOnly}>
          {held.stages.map((stage) => (
            <ListRowLayout key={stage.id} label={stage.name} />
          ))}
        </ListSection>
        <Ends />
        <QuietDays {...props} held={held} />
      </KinWorkFrame>
    );

  const invalid = kinDealStagesProblem(rows.map((row) => row.name));
  const dirty =
    Object.keys(moveTo).length > 0 ||
    rows.length !== held.stages.length ||
    rows.some(
      (row, index) =>
        row.id !== held.stages[index]?.id || row.name.trim() !== held.stages[index]?.name,
    );
  const openOf = (row: Row) => (row.id === null ? 0 : (held.open[row.id] ?? 0));
  const shift = (index: number, step: -1 | 1) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row === undefined) return current;
      next.splice(index + step, 0, row);
      return next;
    });
  const remove = (row: Row, to: string | null) => {
    setRows((current) => current.filter((one) => one.key !== row.key));
    if (row.id !== null && to !== null) {
      const id = row.id;
      setMoveTo((current) => ({ ...current, [id]: to }));
    }
    setRemoving(null);
  };
  const rename = (row: Row) =>
    Dialog.prompt({
      title: KIN_DEAL_STAGES.rename,
      message: KIN_DEAL_STAGES.stageName,
      initialValue: row.name,
      confirmText: KIN_DEAL_STAGES.rename,
      onConfirm: (typed) => {
        const name = typed.trim().slice(0, 40);
        if (name === "") return;
        setRows((current) => current.map((one) => (one.key === row.key ? { ...one, name } : one)));
      },
    });
  const add = () =>
    Dialog.prompt({
      title: KIN_DEAL_STAGES.add,
      message: KIN_DEAL_STAGES.stageName,
      initialValue: "",
      confirmText: KIN_DEAL_STAGES.add,
      onConfirm: (typed) => {
        const name = typed.trim().slice(0, 40);
        if (name === "") return;
        setAdded((count) => count + 1);
        setRows((current) =>
          current.length >= 12 ? current : [...current, { id: null, name, key: `new-${added}` }],
        );
      },
    });
  const submit = async () => {
    if (invalid !== null || !dirty || busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await save({
      rev: held.rev,
      stages: rows.map((row) => ({
        ...(row.id === null ? {} : { id: row.id }),
        name: row.name.trim(),
      })),
      ...(Object.keys(moveTo).length === 0 ? {} : { moveTo }),
    });
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
  };

  return (
    <KinWorkFrame
      title={KIN_DEAL_STAGES.title}
      onBack={() => navigation.goBack()}
      confirm={{
        label: KIN_DEAL_STAGES.save,
        onPress: () => void submit(),
        loading: busy,
        disabled: busy || !dirty || invalid !== null,
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_DEAL_STAGES.detail}
      </Text>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      {invalid === null || !dirty ? null : <Notice message={invalid} tone="danger" />}
      {removing === null ? null : (
        <RemoveStage
          row={removing}
          open={openOf(removing)}
          others={rows.filter((row) => row.key !== removing.key && row.id !== null)}
          onRemove={(to) => remove(removing, to)}
          onCancel={() => setRemoving(null)}
        />
      )}
      <ListSection title={KIN_DEAL_STAGES.stages} footer={KIN_DEAL_STAGES.hint}>
        {rows.map((row, index) => (
          <Menu
            key={row.key}
            actions={[
              { id: ACTIONS.rename, title: KIN_DEAL_STAGES.rename },
              {
                id: ACTIONS.up,
                title: KIN_DEAL_STAGES.up,
                attributes: { disabled: index === 0 },
              },
              {
                id: ACTIONS.down,
                title: KIN_DEAL_STAGES.down,
                attributes: { disabled: index === rows.length - 1 },
              },
              {
                id: ACTIONS.remove,
                title: KIN_DEAL_STAGES.remove,
                attributes: { destructive: true, disabled: rows.length === 1 },
              },
            ]}
            onPressAction={({ nativeEvent: { event } }) => {
              if (busy) return;
              if (event === ACTIONS.rename) rename(row);
              else if (event === ACTIONS.up && index > 0) shift(index, -1);
              else if (event === ACTIONS.down && index < rows.length - 1) shift(index, 1);
              else if (event === ACTIONS.remove && rows.length > 1) {
                if (openOf(row) === 0) remove(row, null);
                else setRemoving(row);
              }
            }}
          >
            <View pointerEvents="none">
              <ListRowLayout
                label={row.name}
                {...(row.id === null ? {} : { detail: KIN_DEAL_STAGES.openDeals(openOf(row)) })}
              />
            </View>
          </Menu>
        ))}
        {rows.length >= 12 ? (
          <ListRowLayout label={KIN_DEAL_STAGES.limit} disabled />
        ) : (
          <ListActionRow icon="plus" label={KIN_DEAL_STAGES.add} disabled={busy} onPress={add} />
        )}
      </ListSection>
      <Ends />
      <QuietDays {...props} held={held} />
    </KinWorkFrame>
  );
}

/** "A deal goes quiet after N days": the owner level sets it; everyone else reads it. */
function QuietDays(props: KinWorkTarget & { readonly held: KinDealStagesResult }) {
  const days = props.held.quietDays;
  const save = useKinDealQuietDaysSet(props);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (days === undefined) return null;
  const footer = props.held.can
    ? KIN_DEAL_QUIET.detail
    : `${KIN_DEAL_QUIET.detail} ${KIN_DEAL_QUIET.readOnly}`;
  const change = () =>
    Dialog.prompt({
      title: KIN_DEAL_QUIET.title,
      message: KIN_DEAL_QUIET.label,
      initialValue: String(days),
      confirmText: KIN_DEAL_QUIET.save,
      onConfirm: (typed) => {
        const invalid = kinDealQuietProblem(typed);
        if (invalid !== null) {
          setProblem(invalid);
          return;
        }
        if (Number(typed) === days) return;
        setBusy(true);
        setProblem(null);
        void save(Number(typed)).then((outcome) => {
          setBusy(false);
          if (!outcome.ok) setProblem(outcome.problem);
        });
      },
    });
  return (
    <ListSection title={KIN_DEAL_QUIET.title} footer={footer}>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      {props.held.can ? (
        <ListActionRow
          label={KIN_DEAL_QUIET.days(days)}
          accessibilityLabel={`${KIN_DEAL_QUIET.title} ${KIN_DEAL_QUIET.days(days)}`}
          loading={busy}
          onPress={change}
        />
      ) : (
        <ListRowLayout label={KIN_DEAL_QUIET.days(days)} />
      )}
    </ListSection>
  );
}

function Ends() {
  return (
    <ListSection title={KIN_DEAL_STAGES.ends}>
      <ListRowLayout icon="star" label="Won" detail={KIN_DEAL_STAGES.wonHint} />
      <ListRowLayout icon="xmark" label="Lost" detail={KIN_DEAL_STAGES.lostHint} />
    </ListSection>
  );
}

/** Removing a stage with open deals asks where they go first; nothing is stranded. */
function RemoveStage(props: {
  readonly row: Row;
  readonly open: number;
  readonly others: ReadonlyArray<Row>;
  readonly onRemove: (to: string) => void;
  readonly onCancel: () => void;
}) {
  const [to, setTo] = useState<string | null>(props.others[0]?.id ?? null);
  return (
    <ListSection
      title={KIN_DEAL_STAGES.removeTitle(props.row.name)}
      footer={KIN_DEAL_STAGES.removeNote}
    >
      <ListRowLayout label={KIN_DEAL_STAGES.removeDetail(props.open)} />
      {props.others.map((row) =>
        row.id === null ? null : (
          <ListChoiceRow
            key={row.key}
            label={row.name}
            selected={to === row.id}
            onPress={() => setTo(row.id)}
          />
        ),
      )}
      <ListActionRow
        tone="danger"
        label={KIN_DEAL_STAGES.removeConfirm(props.open)}
        disabled={to === null}
        onPress={() => {
          if (to !== null) props.onRemove(to);
        }}
      />
      <ListActionRow label="Cancel" onPress={props.onCancel} />
    </ListSection>
  );
}
