import {
  KIN_WORK_PRIVATE,
  KIN_WORK_REFRESH_FAILED,
  KIN_WORK_STALE,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_COPY, type KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_WORK_AREAS,
  type KinWorkArea,
  type KinWorkTimelineLine,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_FORM_COPY,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import type { EnvironmentId, KinRecordKey } from "@t3tools/contracts";
import { Pressable, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { cn } from "../../../lib/cn";
import { useKinHostAt } from "../state/useKinHost";
import { KinWorkStateSymbol } from "./KinWorkStateSymbol";

type Bar = React.ComponentProps<typeof AppBar>;

/** A Work screen that isn't a list: everything sits in the scroll view that clears the bar. */
export function KinWorkFrame(
  props: Pick<Bar, "title" | "onBack" | "onClose" | "confirm" | "actions" | "menus" | "refresh"> & {
    /** A form: taps reach its buttons while the keyboard is up. */
    readonly form?: boolean;
    readonly children: React.ReactNode;
  },
) {
  const { form, children, ...bar } = props;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar {...bar} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          {...(form
            ? { keyboardShouldPersistTaps: "handled", keyboardDismissMode: "interactive" }
            : {})}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

export type KinWorkAreas = {
  readonly area: KinWorkArea;
  readonly onArea: (area: KinWorkArea) => void;
};

/** Tasks, clients or projects: the three parts of Work, at the head of each list. */
export function KinWorkAreaSwitch(props: KinWorkAreas) {
  return (
    <View className="px-4">
      <SegmentedControl
        options={KIN_WORK_AREAS.map((held) => ({ value: held.id, label: held.label }))}
        selected={props.area}
        onSelect={props.onArea}
      />
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
            <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
              {row.line}
            </Text>
          </View>
          {row.late ? (
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              Late
            </Text>
          ) : null}
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

/** Rows older than the host's: offline says so; a failed read while connected offers a retry. */
export function KinWorkStaleNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly onRetry: () => void;
}) {
  const host = useKinHostAt(props.environmentId);
  if (host._tag !== "host" || !host.connected) return <Notice message={KIN_WORK_STALE} />;
  return (
    <Notice
      message={KIN_WORK_REFRESH_FAILED}
      action={{ label: "Try again", onPress: props.onRetry }}
    />
  );
}
