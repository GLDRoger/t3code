import { KIN_GATE_FAILED, type KinGate } from "@t3tools/client-runtime/kin/kinAccess";
import { KIN_OFFLINE_PAGE, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinHostLink } from "@t3tools/client-runtime/kin/kinHost";
import {
  KIN_WORK_PRIVATE,
  kinWorkStaleNotice,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import {
  KIN_TASKS,
  type KinTaskLine,
  type KinTaskStep,
} from "@t3tools/client-runtime/kin/kinTasksList";
import { KIN_WORK_COPY, type KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinWorkTimelineLine } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_FORM_COPY,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import type { EnvironmentId, KinRecordKey } from "@t3tools/contracts";
import { type ComponentRef, createContext, useEffect, useRef, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { RowPressable } from "../../../components/ui/RowPressable";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { useBarOverlap } from "../../../components/ui/useBarInset";
import { cn } from "../../../lib/cn";
import { MOBILE_SHAPE } from "../../../lib/designTokens";
import { retryKinAccess } from "../state/kinClient";
import { useKinHost, useKinHostAt } from "../state/useKinHost";
import { KinLoadFailed } from "./KinLoadFailed";
import { KinAvatar } from "./KinAvatar";
import { KinWorkStateSymbol } from "./KinWorkStateSymbol";

type Bar = React.ComponentProps<typeof AppBar>;

/**
 * Scrolls the screen so a node sits above the keyboard and anything pinned over it; null where
 * the screen can't. UIKit only keeps the focused field itself in view.
 */
export const KinWorkAboveKeyboard = createContext<
  ((node: ComponentRef<typeof View>) => void) | null
>(null);

/** A Work screen that isn't a list: everything sits in the scroll view that clears the bar. */
export function KinWorkFrame(
  props: Pick<
    Bar,
    "title" | "onBack" | "guardBack" | "onClose" | "confirm" | "actions" | "menus" | "refresh"
  > & {
    /** A form: taps reach its buttons while the keyboard is up. */
    readonly form?: boolean;
    /** A problem drawn at the top: the form scrolls up to it whenever it changes. */
    readonly showTop?: string | null;
    /** Pinned under the page and above the keyboard, such as a note composer. */
    readonly footer?: {
      readonly node: React.ReactNode;
      /** The space under it with the keyboard closed, which the keyboard covers when open. */
      readonly bottomInset: number;
    };
    readonly children: React.ReactNode;
  },
) {
  const { form, showTop, footer, children, ...bar } = props;
  const [footerHeight, setFooterHeight] = useState(0);
  const scroll = useRef<ComponentRef<typeof ScreenScrollView>>(null);
  const footerSpace = useRef(0);
  const [aboveKeyboard] = useState(
    () => (node: ComponentRef<typeof View>) =>
      scroll.current?.scrollResponderScrollNativeHandleToKeyboard(
        node,
        footerSpace.current + 8,
        true,
      ),
  );
  const barOverlap = useBarOverlap();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the native scroll view so a save's problem, drawn at the top, isn't left under the header
  useEffect(() => {
    if (showTop === null || showTop === undefined || showTop === "") return;
    scroll.current?.scrollTo({ y: 0, animated: true });
  }, [showTop]);
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar {...bar} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          ref={scroll}
          className="flex-1"
          // Every frame, not only a form: a task page's pickers have a search field too, and
          // without these a tap on a found row only closes the keyboard.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          // A form insets itself under the bar: React Native clamps a scroll above offset 0, so
          // with UIKit's automatic inset a problem drawn at the top could never be scrolled to.
          contentInsetAdjustmentBehavior={form ? "never" : "automatic"}
          scrollIndicatorInsets={form ? { top: barOverlap } : undefined}
          contentContainerStyle={{
            padding: 16,
            paddingTop: form ? 16 + barOverlap : 16,
            paddingBottom: 32 + footerHeight,
            gap: 20,
          }}
        >
          <KinWorkAboveKeyboard value={aboveKeyboard}>{children}</KinWorkAboveKeyboard>
        </ScreenScrollView>
        {footer === undefined ? null : (
          <KeyboardStickyView
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
            offset={{ closed: 0, opened: footer.bottomInset }}
          >
            <View
              onLayout={(event) => {
                footerSpace.current = event.nativeEvent.layout.height;
                setFooterHeight(event.nativeEvent.layout.height);
              }}
            >
              {footer.node}
            </View>
          </KeyboardStickyView>
        )}
      </ScreenContent>
    </View>
  );
}

export function KinWorkLoading(props: { readonly label: string }) {
  return (
    <View
      className="items-center py-12"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={props.label}
    >
      <AppActivityIndicator />
    </View>
  );
}

/** A small lock and a word beside whatever only the owner sees. */
export function KinWorkPrivateMark(props: { readonly label?: string }) {
  return (
    <View className="flex-row items-center gap-1" accessible accessibilityLabel={KIN_WORK_PRIVATE}>
      <SymbolView name="lock" size={12} tintColorClassName="accent-icon-muted" type="monochrome" />
      {props.label === "" ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.label ?? KIN_WORK_PRIVATE}
        </Text>
      )}
    </View>
  );
}

const TICK_LABEL = { done: KIN_WORK_COPY.done, reopen: KIN_WORK_COPY.reopen } as const;

export function KinWorkTaskRow(props: {
  readonly row: KinWorkRowView;
  readonly saving: boolean;
  readonly onPress: () => void;
  /** Null where this phone or this host can't change a task. */
  readonly onAct: ((action: KinWorkAction) => void) | null;
  /** Inside a rounded section the row keeps to the section's edges. */
  readonly inset?: boolean;
}) {
  const { row, onAct } = props;
  const tick = onAct === null ? null : row.tick;
  return (
    <>
      <View className={cn("flex-row items-start", props.saving && "opacity-60")}>
        {tick === null || onAct === null ? (
          <View className="h-12 w-12 items-center justify-center pl-2">
            <KinWorkStateSymbol state={row.state} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${TICK_LABEL[tick]}: ${row.title}`}
            disabled={props.saving}
            onPress={() => onAct({ type: "state", state: tick === "done" ? "done" : "open" })}
            className="h-12 w-12 items-center justify-center pl-2 active:opacity-60"
          >
            <KinWorkStateSymbol state={row.state} />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={row.accessibilityLabel}
          onPress={props.onPress}
          className={cn(
            "min-h-16 min-w-0 flex-1 flex-row items-start gap-3 py-3 active:opacity-60",
            props.inset ? "pr-4" : "pr-5",
          )}
        >
          <View className="min-w-0 flex-1 gap-0.5">
            <Text textRole="body" numberOfLines={2} className="text-foreground">
              {row.title}
            </Text>
            {/* Who has it never gives way: the rest of the line cuts off before it does. */}
            <View className="min-w-0 flex-row items-center gap-1.5">
              <KinAvatar avatar={row.ownerAvatar} size="mini" />
              <Text
                textRole="footnote"
                numberOfLines={1}
                className="max-w-[60%] shrink-0 text-foreground"
              >
                {row.holder}
              </Text>
              {row.detail === "" ? null : (
                <Text
                  textRole="footnote"
                  numberOfLines={1}
                  className="min-w-0 shrink text-foreground-muted"
                >
                  {`· ${row.detail}`}
                </Text>
              )}
            </View>
          </View>
          {row.markText === null ? null : (
            <Text
              textRole="footnote"
              className={cn(
                "font-t3-medium",
                row.mark === "late"
                  ? "text-danger-foreground"
                  : row.mark === "handed_back"
                    ? "text-foreground-muted"
                    : "text-warning-foreground",
              )}
            >
              {row.markText}
            </Text>
          )}
        </Pressable>
      </View>
      {row.suggested && onAct !== null ? (
        <View className="flex-row gap-2 pb-3 pl-12 pr-5">
          <Button
            tone="secondary"
            size="compact"
            label={KIN_WORK_COPY.keep}
            accessibilityLabel={`${KIN_WORK_COPY.keep}: ${row.title}`}
            disabled={props.saving}
            onPress={() => onAct({ type: "confirm" })}
          />
          <Button
            tone="text"
            size="compact"
            label={KIN_WORK_COPY.decline}
            accessibilityLabel={`${KIN_WORK_COPY.decline}: ${row.title}`}
            disabled={props.saving}
            onPress={() => onAct({ type: "decline" })}
          />
        </View>
      ) : null}
      <View className="ml-12 h-px bg-border-subtle" />
    </>
  );
}

/** What a row's step is doing: on its way, done in the host's words, or refused with its reason. */
export type KinTaskStepStatus =
  | { readonly kind: "busy"; readonly id: string }
  | { readonly kind: "done"; readonly text: string; readonly widgetId?: string }
  | { readonly kind: "failed"; readonly text: string; readonly widgetId?: string };

const LEAD_TONE = {
  late: "text-danger-foreground",
  soon: "text-warning-foreground",
  working: "text-update-foreground",
} as const;

const groupRadius = Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;

/**
 * One task on Tasks, inside its group's card: the circle that marks it done, the title on at most
 * two lines, who has it and one coloured word, and its one step with that step's buttons.
 */
export function KinTaskRow(props: {
  readonly row: KinWorkRowView;
  readonly line: KinTaskLine;
  readonly avatar: KinAvatarView;
  readonly step: KinTaskStep | null;
  readonly status: KinTaskStepStatus | null;
  readonly first: boolean;
  readonly last: boolean;
  readonly saving: boolean;
  readonly onPress: () => void;
  /** Null where this phone or this host can't change a task. */
  readonly onAct: ((action: KinWorkAction) => void) | null;
  /** Null where this phone can't answer a card. */
  readonly onChoose: ((optionId: string) => void) | null;
  readonly onOpenCard: () => void;
  readonly onNudge: () => void;
  readonly onGive: () => void;
}) {
  const { row, line, step, status, onAct } = props;
  const tick = onAct === null ? null : row.tick;
  const busy = status?.kind === "busy";
  const symbol = <KinWorkStateSymbol state={row.state} />;
  return (
    <View
      className="mx-4 overflow-hidden border-continuous bg-grouped-card"
      style={{
        borderTopLeftRadius: props.first ? groupRadius : 0,
        borderTopRightRadius: props.first ? groupRadius : 0,
        borderBottomLeftRadius: props.last ? groupRadius : 0,
        borderBottomRightRadius: props.last ? groupRadius : 0,
      }}
    >
      {props.first ? null : <View className="ml-12 h-px bg-border-subtle" />}
      <View className={cn("flex-row items-start", props.saving && "opacity-60")}>
        {tick === null || onAct === null ? (
          <View className="w-12 items-center pt-3">{symbol}</View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${TICK_LABEL[tick]}: ${row.title}`}
            disabled={props.saving}
            onPress={() => onAct({ type: "state", state: tick === "done" ? "done" : "open" })}
            className="w-12 items-center pt-3 pb-2 active:opacity-60"
          >
            {symbol}
          </Pressable>
        )}
        <View className="min-w-0 flex-1 gap-2 py-3 pr-4">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={row.accessibilityLabel}
            onPress={props.onPress}
            className="gap-0.5 active:opacity-60"
          >
            <Text textRole="body" numberOfLines={2} className="text-foreground">
              {row.title}
            </Text>
            {/* Who has it never gives way: the rest of the line cuts off before it does. */}
            <View className="min-w-0 flex-row items-center gap-1.5">
              <KinAvatar avatar={props.avatar} size="mini" />
              <Text
                textRole="footnote"
                numberOfLines={1}
                className="max-w-[50%] shrink-0 text-foreground"
              >
                {line.holder}
              </Text>
              <Text
                textRole="footnote"
                numberOfLines={1}
                className="min-w-0 shrink text-foreground-muted"
              >
                {"· "}
                {line.lead === null ? null : (
                  <Text className={cn("font-t3-medium", LEAD_TONE[line.lead.tone])}>
                    {line.lead.text}
                  </Text>
                )}
                {line.lead !== null && line.rest !== "" ? " · " : null}
                {line.rest}
              </Text>
            </View>
          </Pressable>
          {step === null || step.line === null ? null : (
            <View className="flex-row items-start gap-1.5">
              <SymbolView
                name={step.kind === "send" ? "doc.text" : "text.bubble"}
                size={14}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
              <Text
                textRole="footnote"
                numberOfLines={2}
                className="min-w-0 flex-1 text-foreground"
              >
                {step.line}
              </Text>
            </View>
          )}
          {step?.kind !== "send" || step.mayHaveGone === null ? null : (
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              {step.mayHaveGone}
            </Text>
          )}
          {step === null ? null : status?.kind === "done" ? (
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {status.text}
            </Text>
          ) : (
            <>
              <KinTaskStepButtons
                step={step}
                title={row.title}
                busyId={busy ? status.id : null}
                onChoose={props.onChoose}
                onOpenCard={props.onOpenCard}
                onNudge={props.onNudge}
                onGive={props.onGive}
              />
              {status?.kind === "failed" ? (
                <Text
                  accessibilityRole="alert"
                  textRole="footnote"
                  className="text-danger-foreground"
                >
                  {status.text}
                </Text>
              ) : null}
            </>
          )}
          {row.suggested && onAct !== null ? (
            <View className="flex-row gap-2">
              <Button
                tone="secondary"
                size="compact"
                label={KIN_WORK_COPY.keep}
                accessibilityLabel={`${KIN_WORK_COPY.keep}: ${row.title}`}
                disabled={props.saving}
                onPress={() => onAct({ type: "confirm" })}
              />
              <Button
                tone="text"
                size="compact"
                label={KIN_WORK_COPY.decline}
                accessibilityLabel={`${KIN_WORK_COPY.decline}: ${row.title}`}
                disabled={props.saving}
                onPress={() => onAct({ type: "decline" })}
              />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function KinTaskStepButtons(props: {
  readonly step: KinTaskStep;
  readonly title: string;
  readonly busyId: string | null;
  readonly onChoose: ((optionId: string) => void) | null;
  readonly onOpenCard: () => void;
  readonly onNudge: () => void;
  readonly onGive: () => void;
}) {
  const { step, busyId, onChoose } = props;
  const busy = busyId !== null;
  const label = (what: string) => `${what}: ${props.title}`;
  if (step.kind === "nudge")
    return (
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          tone="secondary"
          size="compact"
          icon={step.nudged ? "checkmark" : "bell"}
          label={step.nudged ? KIN_TASKS.nudged : KIN_TASKS.nudge(step.name)}
          accessibilityLabel={label(step.nudged ? KIN_TASKS.nudged : KIN_TASKS.nudge(step.name))}
          loading={busyId === "nudge"}
          disabled={busy || step.nudged}
          onPress={props.onNudge}
        />
        {step.give ? (
          <Button
            tone="text"
            size="compact"
            label={KIN_TASKS.giveTo}
            accessibilityLabel={label(KIN_TASKS.giveTo)}
            disabled={busy}
            onPress={props.onGive}
          />
        ) : null}
      </View>
    );
  if (step.kind === "send")
    return (
      <View className="flex-row flex-wrap items-center gap-2">
        {step.approve === null || onChoose === null ? null : (
          <Button
            tone="primary"
            size="compact"
            icon="checkmark"
            label={KIN_TASKS.approve}
            accessibilityLabel={label(KIN_TASKS.approve)}
            loading={busyId === step.approve.optionId}
            disabled={busy}
            onPress={() => onChoose(step.approve!.optionId)}
          />
        )}
        <Button
          tone="secondary"
          size="compact"
          label={KIN_TASKS.review}
          accessibilityLabel={label(KIN_TASKS.review)}
          disabled={busy}
          onPress={props.onOpenCard}
        />
      </View>
    );
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {onChoose === null
        ? null
        : step.options.map((option) => (
            <Button
              key={option.optionId}
              tone="secondary"
              size="compact"
              label={option.label}
              accessibilityHint={KIN_TASKS.replyHint}
              loading={busyId === option.optionId}
              disabled={busy}
              onPress={() => onChoose(option.optionId)}
            />
          ))}
      <Button
        tone="text"
        size="compact"
        label={KIN_TASKS.other}
        accessibilityLabel={label(KIN_TASKS.other)}
        disabled={busy}
        onPress={props.onOpenCard}
      />
    </View>
  );
}

/** Nothing needs the reader: said in a card where Needs you's rows would be. */
export function KinTasksAllClear() {
  return (
    <View
      className="mx-4 flex-row items-start gap-3.5 border-continuous bg-grouped-card px-4 py-5"
      style={{ borderRadius: groupRadius }}
    >
      <SymbolView name="checkmark.circle" size={22} tintColorClassName="accent-icon-muted" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {KIN_TASKS.clearTitle}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_TASKS.clearDetail}
        </Text>
      </View>
    </View>
  );
}

/** Who did what and when, newest first. A line about a task opens it. */
export function KinWorkTimelineLines(props: {
  readonly lines: ReadonlyArray<KinWorkTimelineLine>;
  readonly onOpenTask: (key: KinRecordKey) => void;
}) {
  return (
    <>
      {props.lines.map((line) => {
        const { task } = line;
        const body = (
          <>
            <Text textRole="footnote" className="w-16 text-foreground-muted">
              {line.when}
            </Text>
            <Text textRole="footnote" className="min-w-0 flex-1 text-foreground">
              {line.text}
              {line.about === null ? null : (
                <Text textRole="footnote" className="text-foreground-muted">
                  {` · ${line.about}`}
                </Text>
              )}
            </Text>
          </>
        );
        return task === null ? (
          <View key={line.key} className="flex-row gap-3">
            {body}
          </View>
        ) : (
          <Pressable
            key={line.key}
            accessibilityRole="button"
            accessibilityHint="Opens the task"
            onPress={() => props.onOpenTask(task)}
            className="flex-row gap-3 active:opacity-60"
          >
            {body}
          </Pressable>
        );
      })}
    </>
  );
}

/** Why a change didn't go through, with the way on where there is one. */
export function KinWorkProblemNotice(props: {
  readonly problem: KinWorkFormProblem;
  /** Opens the one that already has this name. */
  readonly onOpenExisting?: (key: KinRecordKey) => void;
  readonly onDismiss?: () => void;
}) {
  const { problem, onOpenExisting } = props;
  return (
    <Notice
      message={problem.text}
      tone={problem.kind === "failed" || problem.kind === "invalid" ? "danger" : "default"}
      {...(problem.kind === "duplicate" && onOpenExisting !== undefined
        ? {
            action: {
              label: KIN_WORK_FORM_COPY.openExisting,
              onPress: () => onOpenExisting(problem.existing),
            },
          }
        : props.onDismiss === undefined
          ? {}
          : { onDismiss: props.onDismiss })}
    />
  );
}

/** One labelled field of a form, with what someone else changed it to while it was being typed. */
export function KinWorkTextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
  readonly autoFocus?: boolean;
  readonly isPrivate?: boolean;
  readonly hint?: string;
  readonly moved?: string | undefined;
  readonly keyboard?: "email" | "phone" | "numbers" | "plain";
}) {
  const keyboard = props.keyboard ?? "sentences";
  return (
    <View className="gap-2 px-4 py-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        {props.isPrivate ? <KinWorkPrivateMark /> : null}
      </View>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        editable={!props.disabled}
        autoFocus={props.autoFocus}
        multiline={props.multiline}
        maxLength={props.maxLength}
        autoCapitalize={keyboard === "sentences" ? "sentences" : "none"}
        autoCorrect={keyboard === "sentences"}
        keyboardType={
          keyboard === "email"
            ? "email-address"
            : keyboard === "phone"
              ? "phone-pad"
              : keyboard === "numbers"
                ? "numbers-and-punctuation"
                : "default"
        }
        onChangeText={props.onChangeText}
        textAlignVertical={props.multiline ? "top" : "center"}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-placeholder"
        className={cn(
          "font-sans text-base text-foreground",
          props.multiline ? "min-h-20" : "min-h-8",
        )}
      />
      {props.hint === undefined ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.hint}
        </Text>
      )}
      {props.moved === undefined ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          It now says: {props.moved.trim() || "nothing"}
        </Text>
      )}
    </View>
  );
}

/**
 * Rows older than the host's: offline says so; a failed read while connected offers a retry;
 * nothing is said while the first connection attempt is still under way.
 */
export function KinWorkStaleNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly onRetry: () => void;
}) {
  const notice = kinWorkStaleNotice(kinHostLink(useKinHostAt(props.environmentId)));
  if (notice === null) return null;
  return (
    <Notice
      message={notice.message}
      {...(notice.retry ? { action: { label: KIN_RETRY, onPress: props.onRetry } } : {})}
    />
  );
}

/**
 * A secondary block as one row, its title and a summary, that unfolds the block's rows under it in
 * the same group; with `onOpen` the row opens a screen instead.
 */
export function KinFoldSection(props: {
  readonly title: string;
  readonly summary: string | null;
  readonly onOpen?: () => void;
  readonly children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { onOpen } = props;
  return (
    <ListSection>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[props.title, props.summary].filter((part) => part !== null).join(". ")}
        {...(onOpen === undefined ? { accessibilityState: { expanded: open } } : {})}
        onPress={onOpen ?? (() => setOpen(!open))}
        className="bg-grouped-card"
      >
        <ListRowLayout
          label={props.title}
          {...(props.summary === null ? {} : { description: props.summary })}
          accessory={
            <SymbolView
              name={onOpen !== undefined ? "chevron.right" : open ? "chevron.up" : "chevron.down"}
              size={13}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          }
        />
      </RowPressable>
      {open && onOpen === undefined ? props.children : null}
    </ListSection>
  );
}

/** A gate whose read of what this person may open failed, with a Retry of that read. */
function KinGateFailed() {
  const host = useKinHost();
  return (
    <KinLoadFailed
      title={KIN_GATE_FAILED}
      cause={null}
      onRetry={() => {
        if (host._tag === "host") retryKinAccess(host.environmentId);
      }}
    />
  );
}

/** A gated page before its reads: a spinner, offline, or the page's own refusal. */
export function KinGateView(props: {
  readonly gate: Exclude<KinGate, null>;
  readonly refused: { readonly title: string; readonly detail: string };
  readonly offline?: { readonly title: string; readonly detail: string };
  /** What is loading, for VoiceOver. */
  readonly label: string;
}) {
  if (props.gate === "refused") return <EmptyState variant="plain" {...props.refused} />;
  if (props.gate === "offline")
    return <EmptyState variant="plain" {...(props.offline ?? KIN_OFFLINE_PAGE)} />;
  if (props.gate === "failed") return <KinGateFailed />;
  return (
    <View
      className="items-center py-12"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Loading ${props.label}`}
    >
      <AppActivityIndicator />
    </View>
  );
}
