import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_IMPORT,
  KIN_IMPORT_DATE_FORMATS,
  KIN_IMPORT_NO_CHOICES,
  KIN_IMPORT_TARGET_LABELS,
  KIN_IMPORT_TARGETS,
  kinImportCheckButton,
  kinImportChooseClient,
  kinImportChooseStage,
  kinImportClientChoice,
  kinImportCloseName,
  kinImportDecisions,
  kinImportDoneLine,
  kinImportFileLine,
  kinImportKeptLine,
  kinImportLeftOutLine,
  kinImportMatchedBy,
  kinImportMoreLine,
  kinImportNeedsLook,
  kinImportNoticed,
  kinImportOwnersLine,
  kinImportProgress,
  kinImportReady,
  kinImportRunLine,
  kinImportRunningByLine,
  kinImportRunningLine,
  kinImportRunningOf,
  kinImportStoppedLines,
  kinImportWriting,
  kinImportStageChoice,
  kinImportStageLine,
  kinImportStagePick,
  kinImportTiles,
  kinImportTooBig,
  kinImportUndoneLine,
  kinImportUndoneLines,
  type KinImportChoices,
} from "@t3tools/client-runtime/kin/kinImport";
import { isKinCurrency } from "@t3tools/contracts";
import type {
  KinImportApplied,
  KinImportCheck,
  KinImportClientDecision,
  KinImportFile,
  KinImportMapping,
  KinImportTarget,
  KinImportUndone,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { NO_LINK, targetOf } from "./KinWorkFormScreens";
import { useKinImportRuns, useKinImportSend } from "./state/useKinImport";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinImportParams = {
  readonly environmentId: string;
  readonly orgId: string;
};

const OTHER = "other";
type Busy = { readonly doing: "reading" | "checking" | "importing"; readonly rows: number };

/** Clients → Import a file: the same steps as the web's, one list at a time. */
export function KinImportScreen({ route }: StaticScreenProps<KinImportParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null)
    return (
      <KinWorkFrame title={KIN_IMPORT.entry} onBack={() => navigation.goBack()}>
        {NO_LINK}
      </KinWorkFrame>
    );
  return <Importing {...target} />;
}

/** A row whose value is picked from a menu: a column's destination, a decision, a stage. */
function PickRow(props: {
  readonly label: string;
  readonly detail?: string;
  readonly value: string | null;
  readonly placeholder?: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onPick: (id: string) => void;
}) {
  const shown =
    props.options.find((one) => one.id === props.value)?.label ?? props.placeholder ?? "";
  return (
    <Menu
      actions={props.options.map((one) => ({
        id: one.id,
        title: one.label,
        state: one.id === props.value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent: { event } }) => {
        if (props.disabled !== true) props.onPick(event);
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout
          label={props.label}
          {...(props.detail === undefined ? {} : { description: props.detail })}
          detail={shown}
        />
      </View>
    </Menu>
  );
}

function Importing(props: KinWorkTarget) {
  const navigation = useNavigation();
  const host = useKinImportSend(props);
  const { state: runs, refresh } = useKinImportRuns(props);
  const directory = useKinWorkDirectory(props, true);
  const nameOf = (personId: string) => directory.names.people.get(personId) ?? "Someone";
  const [picked, setPicked] = useState<KinImportFile | null>(null);
  const [checked, setChecked] = useState<KinImportCheck | null>(null);
  const [mapping, setMapping] = useState<KinImportMapping | null>(null);
  const [choices, setChoices] = useState<KinImportChoices>(KIN_IMPORT_NO_CHOICES);
  const [applied, setApplied] = useState<KinImportApplied | null>(null);
  const [undone, setUndone] = useState<KinImportUndone | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const writing = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const step = applied !== null ? 3 : checked?.checked === true ? 2 : checked !== null ? 1 : 0;

  const send = async (
    file: KinImportFile,
    nextMapping: KinImportMapping | undefined,
    nextChoices: KinImportChoices,
    rows: number,
  ) => {
    setProblem(null);
    setBusy({ doing: nextMapping === undefined ? "reading" : "checking", rows });
    const outcome = await host.check({
      file,
      ...(nextMapping === undefined ? {} : { mapping: nextMapping }),
      decisions: kinImportDecisions(nextChoices),
    });
    setBusy(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setChecked(outcome.value);
    setMapping(outcome.value.mapping);
  };

  const choose = async () => {
    setProblem(null);
    const { getDocumentAsync } = await import("expo-document-picker");
    const endHandoff = beginForegroundHandoff();
    let asset: { readonly uri: string; readonly name: string; readonly size?: number } | undefined;
    try {
      const result = await getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      asset = result.canceled ? undefined : result.assets[0];
    } finally {
      endHandoff();
    }
    if (asset === undefined) return;
    const tooBig = kinImportTooBig(asset.size ?? 0);
    if (tooBig !== null) return setProblem(tooBig);
    setBusy({ doing: "reading", rows: 0 });
    const { File } = await import("expo-file-system");
    const data = await new File(asset.uri).base64();
    const file = { name: (asset.name.trim() || "file.csv").slice(0, 200), data };
    setPicked(file);
    setChoices(KIN_IMPORT_NO_CHOICES);
    setApplied(null);
    setUndone(null);
    await send(file, undefined, KIN_IMPORT_NO_CHOICES, 0);
  };

  const recheck = (next: KinImportMapping) => {
    setMapping(next);
    if (picked !== null && checked !== null) void send(picked, next, choices, checked.rows);
  };

  const importNow = async () => {
    // A second press before the first re-renders would otherwise send the file twice.
    if (picked === null || checked === null || mapping === null || writing.current) return;
    writing.current = true;
    setProblem(null);
    setBusy({ doing: "importing", rows: checked.rows });
    const outcome = await host.apply({
      file: picked,
      mapping,
      decisions: kinImportDecisions(choices),
      batch: checked.batch,
    });
    writing.current = false;
    setBusy(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setApplied(outcome.value);
  };

  const undoBatch = async (batch: string) => {
    if (writing.current) return;
    writing.current = true;
    setProblem(null);
    setUndoing(batch);
    const outcome = await host.undo(batch);
    writing.current = false;
    setUndoing(null);
    if (!outcome.ok) return setProblem(outcome.problem);
    setUndone(outcome.value);
  };

  const startOver = () => {
    setPicked(null);
    setChecked(null);
    setMapping(null);
    setApplied(null);
    setUndone(null);
    setChoices(KIN_IMPORT_NO_CHOICES);
  };

  // The host's own count of each run, live on the imports topic; this screen's own runs first.
  const running = runs._tag === "ready" ? runs.value.running : undefined;
  const mine =
    busy?.doing === "checking"
      ? kinImportRunningOf(running, "check", checked?.batch ?? null)
      : busy?.doing === "importing"
        ? kinImportRunningOf(running, "apply", checked?.batch ?? null)
        : undoing !== null
          ? kinImportRunningOf(running, "undo", undoing)
          : null;
  const others = (running ?? []).filter((one) => one !== mine);
  // Someone's import or undo, or this one's from before the screen closed: a second waits for it.
  const othersWriting = kinImportWriting(others);
  const mineLine = mine === null ? null : kinImportRunningLine(mine);
  const notices = (
    <>
      {busy === null && undoing === null ? null : (
        <Notice
          message={
            mineLine ??
            (busy === null ? KIN_IMPORT.undoing : kinImportProgress(busy.doing, busy.rows))
          }
        />
      )}
      {others.map((one) => (
        <Notice
          key={`${one.action}:${one.batch}:${one.by}:${one.at}`}
          message={kinImportRunningByLine(one, nameOf(one.by))}
        />
      ))}
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      {undone === null ? null : (
        <ListSection title={KIN_IMPORT.undone}>
          {kinImportUndoneLines(undone).map((line) => (
            <ListRowLayout key={line} label={line} />
          ))}
        </ListSection>
      )}
    </>
  );
  const working = busy !== null || undoing !== null;
  const back = () => {
    if (step === 2 && checked !== null) setChecked({ ...checked, checked: false });
    else if (step === 1) startOver();
    else navigation.goBack();
  };

  if (step === 0)
    return (
      <KinWorkFrame
        title={KIN_IMPORT.entry}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
      >
        <Text textRole="headline" className="px-2">
          {KIN_IMPORT.title}
        </Text>
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_IMPORT.intro}
        </Text>
        <Button
          tone="primary"
          label={KIN_IMPORT.chooseFile}
          disabled={working}
          onPress={() => void choose()}
        />
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_IMPORT.limits}
        </Text>
        {notices}
        <ListSection title={KIN_IMPORT.earlier}>
          {runs._tag === "loading" ? (
            <KinWorkLoading label={KIN_IMPORT.earlier} />
          ) : runs._tag === "failed" ? (
            <KinLoadFailed title={KIN_IMPORT.earlier} cause={runs.cause} onRetry={refresh} />
          ) : runs._tag === "refused" ? (
            <ListRowLayout label={KIN_IMPORT.onlyOwner} disabled />
          ) : runs._tag === "gone" || runs.value.runs.length === 0 ? (
            <ListRowLayout label={KIN_IMPORT.noneEarlier} disabled />
          ) : (
            runs.value.runs.flatMap((run) => {
              const why = kinImportUndoneLine(run, nameOf);
              const description = [why, ...kinImportStoppedLines(run)]
                .filter((line) => line !== null)
                .join("\n");
              return [
                <ListRowLayout
                  key={run.batch}
                  icon="doc.text"
                  label={kinImportRunLine(run, nameOf(run.by))}
                  {...(description === "" ? {} : { description })}
                />,
                ...(why === null
                  ? [
                      <ListActionRow
                        key={`${run.batch}:undo`}
                        icon="arrow.uturn.backward"
                        label={KIN_IMPORT.undo}
                        tone="danger"
                        disabled={working || othersWriting}
                        onPress={() => void undoBatch(run.batch)}
                      />,
                    ]
                  : []),
              ];
            })
          )}
        </ListSection>
      </KinWorkFrame>
    );

  if (step === 1 && checked !== null && mapping !== null && picked !== null)
    return (
      <KinWorkFrame
        title={KIN_IMPORT.steps[1]}
        onBack={back}
        confirm={{
          label: kinImportCheckButton(checked.rows),
          onPress: () => void send(picked, mapping, choices, checked.rows),
          loading: busy !== null,
          disabled: working,
        }}
      >
        <Text textRole="headline" className="px-2">
          {kinImportFileLine(picked.name, checked.rows)}
        </Text>
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_IMPORT.columnsIntro}
        </Text>
        {notices}
        <ListSection title={KIN_IMPORT.goesTo}>
          {checked.columns
            .map((column, at) => ({ ...column, at }))
            .map((column) => (
              <PickRow
                key={`column-${column.at}`}
                label={column.header || KIN_IMPORT.unnamed}
                detail={column.note ?? column.sample}
                value={mapping.columns[column.at] ?? "skip"}
                options={KIN_IMPORT_TARGETS.map((id) => ({
                  id,
                  label: KIN_IMPORT_TARGET_LABELS[id],
                }))}
                disabled={working}
                onPick={(id) =>
                  setMapping({
                    ...mapping,
                    columns: mapping.columns.map((one, at) =>
                      at === column.at ? (id as KinImportTarget) : one,
                    ),
                  })
                }
              />
            ))}
        </ListSection>
      </KinWorkFrame>
    );

  if (step === 2 && checked !== null && mapping !== null)
    return (
      <KinWorkFrame
        title={KIN_IMPORT.steps[2]}
        onBack={back}
        confirm={{
          label: KIN_IMPORT.import,
          onPress: () => void importNow(),
          loading: busy?.doing === "importing",
          disabled: working || othersWriting || !kinImportReady(checked, choices),
        }}
      >
        {notices}
        {checked.asks.currency || checked.asks.dateFormat ? (
          <ListSection title={KIN_IMPORT.decide}>
            {checked.asks.currency ? (
              <PickRow
                label={KIN_IMPORT.currencyAsk}
                value={mapping.currency ?? null}
                placeholder={KIN_IMPORT.currencyPick}
                options={[
                  ...new Set([
                    checked.homeCurrency,
                    ...(mapping.currency === undefined ? [] : [mapping.currency]),
                  ]),
                ]
                  .map((id) => ({ id, label: id }))
                  .concat([{ id: OTHER, label: KIN_IMPORT.otherCurrency }])}
                disabled={working}
                onPick={(id) =>
                  id !== OTHER
                    ? recheck({ ...mapping, currency: id })
                    : Dialog.prompt({
                        title: KIN_IMPORT.otherCurrency,
                        message: KIN_IMPORT.currencyCode,
                        initialValue: "",
                        confirmText: KIN_IMPORT.currencyPick,
                        onConfirm: (typed) => {
                          const code = typed.trim().toUpperCase();
                          if (isKinCurrency(code)) recheck({ ...mapping, currency: code });
                        },
                      })
                }
              />
            ) : null}
            {checked.asks.dateFormat ? (
              <PickRow
                label={`${KIN_IMPORT.dateAsk} ${checked.asks.dateExamples.join(", ")} ${KIN_IMPORT.dateAskAfter}`}
                value={mapping.dateFormat ?? null}
                placeholder={KIN_IMPORT.decide}
                options={KIN_IMPORT_DATE_FORMATS}
                disabled={working}
                onPick={(id) => recheck({ ...mapping, dateFormat: id === "mdy" ? "mdy" : "dmy" })}
              />
            ) : null}
          </ListSection>
        ) : null}
        <ListSection title={KIN_IMPORT.whatWillHappen}>
          {kinImportTiles(checked).map((tile) => (
            <ListRowLayout
              key={tile.id}
              label={tile.label}
              detail={tile.value.toLocaleString("en-US")}
              {...(tile.alert ? { icon: "exclamationmark.triangle" as const } : {})}
            />
          ))}
        </ListSection>
        {checked.matches.length + checked.decide.length === 0 ? null : (
          <ListSection title={KIN_IMPORT.matchesTitle} footer={KIN_IMPORT.matchesHint}>
            {checked.matches.map((match) => (
              <PickRow
                key={match.source}
                label={`${match.name} → ${match.existing}`}
                detail={[
                  kinImportMatchedBy(match),
                  ...(match.kept.length === 0 ? [] : [kinImportKeptLine(match.kept)]),
                ].join(" · ")}
                value={kinImportClientChoice(checked, choices, match.source)}
                options={[
                  { id: "same", label: KIN_IMPORT.sameCompany },
                  { id: "skip", label: KIN_IMPORT.leaveOut },
                ]}
                disabled={working}
                onPick={(id) =>
                  setChoices(
                    kinImportChooseClient(choices, match.source, id as KinImportClientDecision),
                  )
                }
              />
            ))}
            {checked.decide.map((near) => (
              <PickRow
                key={near.source}
                label={`${near.name} → ${near.candidates.map((one) => one.name).join(", ")}`}
                detail={kinImportCloseName}
                value={kinImportClientChoice(checked, choices, near.source)}
                placeholder={KIN_IMPORT.decide}
                options={[
                  ...near.candidates.map((one) => ({
                    id: one.key,
                    label: `${KIN_IMPORT.sameCompany}: ${one.name}`,
                  })),
                  { id: "new", label: KIN_IMPORT.newOne },
                  { id: "skip", label: KIN_IMPORT.leaveOut },
                ]}
                disabled={working}
                onPick={(id) =>
                  setChoices(
                    kinImportChooseClient(choices, near.source, id as KinImportClientDecision),
                  )
                }
              />
            ))}
          </ListSection>
        )}
        {kinImportNeedsLook(checked) === 0 ? null : (
          <ListSection title={`${KIN_IMPORT.needLook} · ${kinImportNeedsLook(checked)}`}>
            {checked.stages.map((stage) => (
              <PickRow
                key={stage.value}
                label={kinImportStageLine(stage)}
                value={kinImportStageChoice(checked, choices, stage.value)}
                placeholder={KIN_IMPORT.decide}
                options={[
                  ...checked.companyStages.map((one) => ({
                    id: one.id,
                    label: kinImportStagePick(one),
                  })),
                  { id: "skip", label: KIN_IMPORT.leaveOut },
                ]}
                disabled={working}
                onPick={(id) => setChoices(kinImportChooseStage(choices, stage.value, id))}
              />
            ))}
            {checked.ownersUnknown === 0 ? null : (
              <ListRowLayout label={kinImportOwnersLine(checked.ownersUnknown)} />
            )}
          </ListSection>
        )}
        {checked.leftOut.length + checked.notImported.length === 0 ? null : (
          <ListSection
            title={KIN_IMPORT.leftOut}
            {...(kinImportMoreLine(checked.more) === null
              ? {}
              : { footer: kinImportMoreLine(checked.more) ?? "" })}
          >
            {checked.notImported.map((one) => (
              <ListRowLayout key={one.header} label={one.header} description={one.reason} />
            ))}
            {checked.leftOut.slice(0, 30).map((one) => (
              <ListRowLayout key={`${one.line}:${one.reason}`} label={kinImportLeftOutLine(one)} />
            ))}
          </ListSection>
        )}
        {kinImportReady(checked, choices) ? null : (
          <Text textRole="footnote" className="px-2 text-foreground-muted">
            {KIN_IMPORT.decideFirst}
          </Text>
        )}
      </KinWorkFrame>
    );

  return (
    <KinWorkFrame
      title={KIN_IMPORT.imported}
      onBack={() => navigation.goBack()}
      confirm={{ label: KIN_IMPORT.close, onPress: () => navigation.goBack() }}
    >
      {applied === null ? null : (
        <>
          <Text textRole="body" className="px-2">
            {kinImportDoneLine(applied)}
          </Text>
          {kinImportNoticed(applied).length === 0 ? null : (
            <ListSection title={KIN_IMPORT.noticed}>
              {kinImportNoticed(applied).map((line) => (
                <ListRowLayout key={line} icon="exclamationmark.triangle" label={line} />
              ))}
            </ListSection>
          )}
          {applied.leftOut.length === 0 ? null : (
            <ListSection title={KIN_IMPORT.leftOut}>
              {applied.leftOut.slice(0, 30).map((one) => (
                <ListRowLayout
                  key={`${one.line}:${one.reason}`}
                  label={kinImportLeftOutLine(one)}
                />
              ))}
            </ListSection>
          )}
          {notices}
          {undone === null ? (
            <ListSection footer={KIN_IMPORT.undoAfter}>
              <ListActionRow
                icon="arrow.uturn.backward"
                label={KIN_IMPORT.undo}
                tone="danger"
                disabled={working || othersWriting}
                onPress={() => void undoBatch(applied.batch)}
              />
            </ListSection>
          ) : (
            <Button label={KIN_IMPORT.another} onPress={startOver} />
          )}
        </>
      )}
    </KinWorkFrame>
  );
}
