import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_DEALS,
  kinDealChangeText,
  kinDealMoves,
  kinDealNext,
  kinDealNextStage,
  kinDealPill,
  kinDealQuoteChoices,
  kinDealStageName,
  kinDealStrip,
  kinDealWithoutConcern,
  kinDealWhen,
} from "@t3tools/client-runtime/kin/kinDeals";
import { kinMoneyText } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_WORK_NEW_COPY,
  kinWorkAssignees,
  kinWorkDueText,
  kinWorkName,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinDealMove,
  type KinDealPage,
  type KinDealRow,
  type KinDealUpdateInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { uuidv4 } from "../../lib/uuid";
import { KinAsideNote } from "./KinAttention";
import { KinDayField } from "./components/KinDayField";
import { KinDealOwnerRow, KinDealQuoteRow } from "./components/KinDealPicks";
import { KinLoadFailed } from "./components/KinLoadFailed";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkTextField,
} from "./components/KinWorkPieces";
import { KinDealNextLine } from "./KinDealsList";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinDealPage, useKinDealSend } from "./state/useKinDeals";
import { useKinInvoiceFromQuote } from "./state/useKinMoneyAnswers";
import { useKinWorkDirectory, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinDealParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The deal's short handle, such as `DL-7`. */
  readonly deal: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** One deal: its stage and moves, value, next step, details and what happened to it. */
export function KinDealScreen({ route }: StaticScreenProps<KinDealParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.deal));
  if (environmentId === null || orgId === null || key === null)
    return (
      <KinWorkFrame title={KIN_DEALS.title} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" title={KIN_DEALS.title} detail={KIN_DEALS.gone} />
      </KinWorkFrame>
    );
  return <KinDealStates key={key} environmentId={environmentId} orgId={orgId} dealKey={key} />;
}

type DealTarget = KinWorkTarget & { readonly dealKey: KinRecordKey };

function KinDealStates(props: DealTarget) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const { state, refresh } = useKinDealPage(target, props.dealKey);
  const directory = useKinWorkDirectory(target, true);
  if (state._tag === "ready")
    return <KinDealBody {...props} page={state.value} directory={directory} onRefresh={refresh} />;
  return (
    <KinWorkFrame title={KIN_DEALS.title} onBack={() => navigation.goBack()}>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading deal" />
      ) : state._tag === "failed" ? (
        <KinLoadFailed title={KIN_DEALS.loadFailed} cause={state.cause} onRetry={refresh} />
      ) : (
        <EmptyState variant="plain" title={KIN_DEALS.title} detail={KIN_DEALS.gone} />
      )}
    </KinWorkFrame>
  );
}

const PILL_TONE = {
  open: "text-primary-text",
  won: "text-success-foreground",
  lost: "text-danger-foreground",
} as const;

function KinDealBody(
  props: DealTarget & {
    readonly page: KinDealPage;
    readonly directory: KinWorkDirectory;
    readonly onRefresh: () => void;
  },
) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const { environmentId, orgId, page } = props;
  const target = { environmentId, orgId };
  const { deal, stages } = page;
  const quotes = kinDealQuoteChoices(page);
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const send = useKinDealSend(target);
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const canProject = useAtomValue(kinClient.workProjectCreate.permissionAtom(environmentId));
  const canInvoice = useAtomValue(kinClient.workInvoiceFromQuote.permissionAtom(environmentId));
  const invoice = useKinInvoiceFromQuote(target);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [becameClient, setBecameClient] = useState(false);
  // One id for the page's life: a retried invoice never makes a second.
  const [requestId] = useState(uuidv4);

  const move = async (to: KinDealMove) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await send.move(deal, to);
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    if (outcome.value.becameClient === true) setBecameClient(true);
  };
  // The reason is required: an empty answer asks again.
  const askLost = () =>
    Dialog.prompt({
      title: KIN_DEALS.lostAsk,
      message: KIN_DEALS.lostHint,
      initialValue: "",
      confirmText: KIN_DEALS.lostConfirm,
      onConfirm: (typed) => {
        const reason = typed.trim().slice(0, 280);
        if (reason === "") return askLost();
        void move({ _tag: "lost", reason });
      },
    });
  const change = async (input: Omit<KinDealUpdateInput, "orgId">) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await send.update(input);
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
  };
  const openTask = (task: KinRecordKey) =>
    openRecord("KinWorkItem", { environmentId, orgId, task });
  const nextStage = kinDealNextStage(deal, stages);
  const when = kinDealWhen(deal, names, now);
  const next = kinDealNext(deal, names, now);
  const lastStage = kinDealStageName(stages, deal.stage);
  const offersProject = ownerLevel && canProject;
  const offersInvoice = ownerLevel && canInvoice && deal.quote !== undefined;
  const moveMenu: AppBarMenu = {
    title: KIN_DEALS.moveTo,
    icon: "ellipsis",
    items: kinDealMoves(deal, stages).map((choice) => ({
      id: choice.id,
      title: choice.label,
      selected: choice.current,
      disabled: busy || choice.current,
      destructive: choice.id === "lost",
      onPress: () => (choice.to === null ? askLost() : void move(choice.to)),
    })),
  };

  return (
    <KinWorkFrame
      title="Deal"
      onBack={() => navigation.goBack()}
      refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
      {...(deal.can.move ? { menus: [moveMenu] } : {})}
    >
      <View className="gap-1 px-2">
        <View className="flex-row items-center gap-2">
          <View className="rounded-full bg-subtle px-2 py-0.5">
            <Text textRole="footnote" className={cn("font-t3-medium", PILL_TONE[deal.state])}>
              {kinDealPill(deal, stages)}
            </Text>
          </View>
          <Text textRole="footnote" className="text-foreground-muted">
            {deal.key}
          </Text>
          {deal.sensitive ? <KinWorkPrivateMark /> : null}
        </View>
        <Text
          textRole="headline"
          accessibilityRole="header"
          className="font-t3-bold text-foreground"
        >
          {deal.title}
        </Text>
        {deal.value === undefined && when === null ? null : (
          <View className="flex-row flex-wrap items-baseline gap-2">
            {deal.value === undefined ? null : (
              <Text textRole="title" className="font-t3-medium text-foreground tabular-nums">
                {kinMoneyText(deal.value)}
              </Text>
            )}
            {when === null ? null : (
              <Text textRole="footnote" className="text-foreground-muted">
                {when}
              </Text>
            )}
          </View>
        )}
      </View>
      <KinAsideNote {...target} record={deal.key} names={names} />

      {deal.state !== "open" ? null : <DealStrip deal={deal} stages={stages} />}

      {!deal.can.move ? null : (
        <View className="flex-row flex-wrap gap-2 px-2">
          {deal.state === "open" ? (
            <>
              {nextStage === null ? null : (
                <Button
                  size="compact"
                  tone="outline"
                  icon="arrow.right"
                  label={KIN_DEALS.moveToStage(nextStage.name)}
                  disabled={busy}
                  onPress={() => void move({ _tag: "stage", stage: nextStage.id })}
                />
              )}
              <Button
                size="compact"
                tone="outline"
                icon="star"
                label={KIN_DEALS.won}
                disabled={busy}
                onPress={() => void move({ _tag: "won" })}
              />
              <Button
                size="compact"
                tone="outline"
                icon="xmark"
                label={KIN_DEALS.lost}
                disabled={busy}
                onPress={askLost}
              />
            </>
          ) : (
            <Button
              size="compact"
              tone="outline"
              icon="arrow.uturn.backward"
              label={KIN_DEALS.reopen}
              disabled={busy}
              onPress={() => void move({ _tag: "reopen" })}
            />
          )}
          {!deal.can.edit ? null : (
            <Button
              size="compact"
              tone="outline"
              icon="pencil"
              label={KIN_DEALS.edit}
              disabled={busy}
              onPress={() =>
                navigation.navigate("KinDealEdit", { environmentId, orgId, deal: deal.key })
              }
            />
          )}
        </View>
      )}

      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}

      {deal.state === "open" && deal.quote?.accepted === true && deal.can.move ? (
        <ListSection>
          <View className="gap-3 bg-grouped-card px-4 py-3">
            <Text textRole="body" className="text-foreground">
              {KIN_DEALS.quoteAcceptedHint(deal.quote.title)}
            </Text>
            <View className="flex-row">
              <Button
                size="compact"
                tone="primary"
                icon="star"
                label={KIN_DEALS.markWon}
                disabled={busy}
                onPress={() => void move({ _tag: "won" })}
              />
            </View>
          </View>
        </ListSection>
      ) : null}

      {deal.state === "won" && (offersProject || offersInvoice) ? (
        <ListSection>
          <View className="gap-3 bg-grouped-card px-4 py-3">
            <Text textRole="body" className="text-foreground">
              {becameClient ? `${KIN_DEALS.becameClient(deal.party.title)} ` : ""}
              {KIN_DEALS.whatNext}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {!offersProject ? null : (
                <Button
                  size="compact"
                  tone="primary"
                  icon="plus"
                  label={KIN_DEALS.startProject}
                  onPress={() =>
                    navigation.navigate("KinProjectForm", {
                      environmentId,
                      orgId,
                      party: deal.party.key,
                      partyName: deal.party.title,
                    })
                  }
                />
              )}
              {!offersInvoice || deal.quote === undefined ? null : (
                <Button
                  size="compact"
                  tone="outline"
                  label={KIN_DEALS.invoiceFrom(deal.quote.title)}
                  loading={invoice.busy}
                  disabled={invoice.busy}
                  onPress={() => {
                    if (deal.quote !== undefined) void invoice.make(deal.quote.key, requestId);
                  }}
                />
              )}
            </View>
            {invoice.problem === null ? null : (
              <Text textRole="footnote" className="text-danger-foreground">
                {invoice.problem}
              </Text>
            )}
          </View>
          {invoice.invoice === null ? null : (
            <ListRow
              label={invoice.notice ?? invoice.invoice}
              detail={invoice.invoice}
              onPress={() => {
                if (invoice.invoice !== null) openTask(invoice.invoice);
              }}
            />
          )}
        </ListSection>
      ) : becameClient ? (
        <Notice message={KIN_DEALS.becameClient(deal.party.title)} />
      ) : null}

      {deal.state === "lost" && deal.lostReason !== undefined ? (
        <ListSection>
          <View className="bg-grouped-card px-4 py-3">
            <Text textRole="body" className="text-foreground">
              {KIN_DEALS.lostWhy(deal.lostReason)}
            </Text>
          </View>
        </ListSection>
      ) : null}

      {deal.state !== "open" ? null : (
        <ListSection title={KIN_DEALS.nextStep}>
          {page.steps.length === 0 ? (
            <View className="bg-grouped-card px-4 py-3">
              <KinDealNextLine next={next} />
            </View>
          ) : (
            page.steps.map((step) => {
              const due = kinWorkDueText(
                { dueAt: step.dueAt, dueAllDay: step.dueAllDay },
                names,
                now,
              );
              return (
                <ListRow
                  key={step.key}
                  label={step.late ? KIN_DEALS.late(step.title) : step.title}
                  {...(due === null ? {} : { detail: due })}
                  onPress={() => openTask(step.key)}
                />
              );
            })
          )}
          {deal.can.edit ? <AddStep {...target} deal={deal} names={names} now={now} /> : null}
        </ListSection>
      )}

      {deal.concerns === undefined ? null : (
        <ListSection title={KIN_DEALS.concernsRaised}>
          {deal.concerns.map((concern) => (
            <ListRowLayout
              key={concern.label}
              label={concern.label}
              {...(concern.heard === undefined
                ? {}
                : { description: KIN_DEALS.heard(concern.heard) })}
              accessory={
                deal.can.edit ? (
                  <IconButton
                    icon="xmark"
                    accessibilityLabel={KIN_DEALS.removeConcern(concern.label)}
                    disabled={busy}
                    onPress={() => void change(kinDealWithoutConcern(deal, concern.label))}
                  />
                ) : null
              }
            />
          ))}
        </ListSection>
      )}

      <ListSection title={KIN_DEALS.details}>
        <ListRow
          label={KIN_DEALS.clientField}
          detail={deal.party.title}
          onPress={() => openRecord("KinClient", { environmentId, orgId, party: deal.party.key })}
        />
        {deal.can.give ? (
          <KinDealOwnerRow
            name={kinWorkName(deal.owner, names)}
            assignees={kinWorkAssignees({ ...props.directory, orgId, current: deal.owner })}
            disabled={busy}
            onGive={(to) => void change({ key: deal.key, rev: deal.rev, owner: to })}
          />
        ) : (
          <ListRowLayout label={KIN_DEALS.lookedAfterBy} detail={kinWorkName(deal.owner, names)} />
        )}
        {deal.state !== "open" ? null : deal.next === null ? (
          <ListRowLayout label={KIN_DEALS.nextStep} detail={KIN_DEALS.noNextStep} />
        ) : (
          <ListRow
            label={KIN_DEALS.nextStep}
            detail={deal.next.title}
            onPress={() => {
              if (deal.next !== null) openTask(deal.next.key);
            }}
          />
        )}
        {deal.source === undefined ? null : (
          <ListRowLayout label={KIN_DEALS.cameFrom} detail={deal.source} />
        )}
        {deal.can.edit && quotes !== null ? (
          <KinDealQuoteRow
            quotes={quotes}
            disabled={busy}
            onPick={(quote) => void change({ key: deal.key, rev: deal.rev, quote })}
            onOpen={
              deal.quote === undefined
                ? undefined
                : { title: deal.quote.title, open: () => deal.quote && openTask(deal.quote.key) }
            }
          />
        ) : deal.quote === undefined ? null : (
          <ListRow
            label={KIN_DEALS.quote}
            detail={
              deal.quote.accepted ? KIN_DEALS.quoteAccepted(deal.quote.title) : deal.quote.title
            }
            onPress={() => {
              if (deal.quote !== undefined) openTask(deal.quote.key);
            }}
          />
        )}
        {deal.state !== "lost" || lastStage === null ? null : (
          <ListRowLayout label={KIN_DEALS.lastStage} detail={lastStage} />
        )}
      </ListSection>

      {page.notes === "" ? null : (
        <ListSection>
          <View className="bg-grouped-card px-4 py-3">
            <Text textRole="body" selectable className="text-foreground">
              {page.notes}
            </Text>
          </View>
        </ListSection>
      )}

      {page.changes.length === 0 ? null : (
        <ListSection title={KIN_DEALS.activity}>
          <View className="gap-2 bg-grouped-card px-4 py-3">
            {page.changes.map((change) => (
              <View key={change.seq} className="flex-row gap-2">
                <Text textRole="footnote" className="min-w-0 flex-1 text-foreground">
                  {kinDealChangeText(change, names, now)}
                </Text>
                <Text textRole="footnote" className="shrink-0 text-foreground-muted">
                  {kinWorkDueText({ dueAt: change.at, dueAllDay: false }, names, now)}
                </Text>
              </View>
            ))}
          </View>
        </ListSection>
      )}
    </KinWorkFrame>
  );
}

/** The stages in order: those reached filled, the current one named in full. */
function DealStrip(props: { readonly deal: KinDealRow; readonly stages: KinDealPage["stages"] }) {
  const strip = kinDealStrip(props.deal, props.stages);
  const current = strip.find((step) => step.current);
  return (
    <View
      accessible
      accessibilityLabel={`${KIN_DEALS.stage}: ${current?.name ?? ""}`}
      className="flex-row gap-1 px-2"
    >
      {strip.map((step) => (
        <View key={step.id} className="min-w-0 flex-1 gap-1">
          <View
            className={cn("h-1 rounded-full", step.reached ? "bg-primary" : "bg-subtle-strong")}
          />
          <Text
            textRole="footnote"
            numberOfLines={1}
            className={step.current ? "font-t3-medium text-foreground" : "text-foreground-muted"}
          >
            {step.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A follow-up of ours, linked to the deal: what, and the day if there is one. */
function AddStep(
  props: KinWorkTarget & {
    readonly deal: KinDealRow;
    readonly names: KinWorkDirectory["names"];
    readonly now: Date;
  },
) {
  const send = useKinDealSend(props);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(uuidv4);
  if (!open)
    return <ListActionRow icon="plus" label={KIN_DEALS.addStep} onPress={() => setOpen(true)} />;
  const add = async () => {
    if (busy || title.trim() === "") return;
    setBusy(true);
    setProblem(null);
    const outcome = await send.step(
      props.deal.key,
      { title: title.trim(), ...(day === null ? {} : { dueAt: day, dueAllDay: true }) },
      requestId,
    );
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    setTitle("");
    setDay(null);
    setRequestId(uuidv4());
    setOpen(false);
  };
  return (
    <>
      <View className="bg-grouped-card">
        <KinWorkTextField
          label={KIN_DEALS.nextStep}
          value={title}
          autoFocus
          maxLength={280}
          disabled={busy}
          onChangeText={setTitle}
        />
      </View>
      <KinDayField
        label={KIN_WORK_NEW_COPY.dueLabel}
        day={day}
        zone={props.names.zone}
        now={props.now}
        disabled={busy}
        onPick={setDay}
      />
      {problem === null ? null : (
        <View className="bg-grouped-card px-4 py-2">
          <Text textRole="footnote" className="text-danger-foreground">
            {problem}
          </Text>
        </View>
      )}
      <ListActionRow
        icon="plus"
        label={KIN_DEALS.addStep}
        loading={busy}
        disabled={title.trim() === ""}
        onPress={() => void add()}
      />
      <ListActionRow label="Cancel" disabled={busy} onPress={() => setOpen(false)} />
    </>
  );
}
