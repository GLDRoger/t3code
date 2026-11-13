import { useAtomValue } from "@effect/atom-react";
import {
  KIN_STATEMENT_ACTION_LABELS,
  KIN_STATEMENT_PAGE,
  KIN_STATEMENT_SECTION_TITLES,
  kinStatementActionOf,
  kinStatementActionsFor,
  kinStatementAllTicked,
  kinStatementAnswered,
  kinStatementApplyInput,
  kinStatementConfirm,
  kinStatementFailureText,
  kinStatementLoaded,
  kinStatementLocal,
  kinStatementNeedsPassword,
  kinStatementOpenSuggestions,
  kinStatementPasswordLines,
  kinStatementPickOf,
  kinStatementQueue,
  kinStatementRereadText,
  kinStatementRowNote,
  kinStatementRowsInput,
  kinStatementSections,
  kinStatementShown,
  kinStatementStatusLines,
  kinStatementSuggestionsLeft,
  kinStatementTakenBy,
  kinStatementTargetLine,
  kinStatementTicked,
  kinStatementTotal,
  type KinStatementPasswordView,
  type KinStatementReviewView,
  type KinStatementSectionId,
} from "@t3tools/client-runtime/kin/kinStatementPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinStatementSelectChange } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/reactivity";
import { memo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { SecretTextInput } from "../../../components/ui/SecretTextInput";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

type Shown = ReturnType<typeof kinStatementShown>;
type Row = { readonly date: string; readonly text: string; readonly amount: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const [, month, date] = iso.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ""}`;
};

function Frame(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View
      accessibilityLabel={props.label}
      className="gap-2 rounded-[20px] border border-border bg-card-alt px-4 py-3"
    >
      {props.children}
    </View>
  );
}

function RowLine(props: { readonly row: Row; readonly muted?: boolean }) {
  return (
    <View className="gap-0.5">
      <View className="flex-row items-baseline gap-2">
        <Text
          textRole="footnote"
          numberOfLines={1}
          className={cn(
            "min-w-0 flex-1",
            props.muted === true ? "text-foreground-muted" : "text-foreground",
          )}
        >
          {props.row.text}
        </Text>
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          {props.row.amount}
        </Text>
      </View>
      <Text textRole="caption" className="text-foreground-muted">
        {day(props.row.date)}
      </Text>
    </View>
  );
}

/** A row this statement already recorded and an undo kept: what holds it, and nothing to change. */
function RecordedRow(props: { readonly row: Row; readonly recorded: string }) {
  return (
    <View className="gap-0.5 py-1.5">
      <RowLine row={props.row} muted />
      <Text textRole="caption" className="text-foreground-muted">
        {props.recorded}
      </Text>
    </View>
  );
}

/** A section shows a page at a time; past the rows the card carries, it reads the next page. */
function Section(props: {
  readonly id: KinStatementSectionId;
  readonly count: number;
  readonly loaded: number;
  readonly openAtFirst: boolean;
  readonly aside?: string;
  readonly onLoad: () => Promise<boolean>;
  readonly children: (shown: number) => ReactNode;
}) {
  const [open, setOpen] = useState(props.openAtFirst);
  const [shown, setShown] = useState(KIN_STATEMENT_PAGE);
  const [loading, setLoading] = useState(false);
  const title = KIN_STATEMENT_SECTION_TITLES[props.id];
  const more = async () => {
    const next = shown + KIN_STATEMENT_PAGE;
    if (next > props.loaded && props.loaded < props.count) {
      setLoading(true);
      const loaded = await props.onLoad();
      setLoading(false);
      if (!loaded) return;
    }
    setShown(next);
  };
  return (
    <View className="border-t border-border pt-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${props.count}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-11 flex-row items-center gap-2 active:opacity-70"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={13}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
          weight="semibold"
        />
        <Text textRole="footnote" className="flex-1 font-t3-medium text-foreground">
          {title}
        </Text>
        {props.aside === undefined ? null : (
          <Text textRole="caption" className="text-foreground-muted">
            {props.aside}
          </Text>
        )}
        <Text textRole="footnote" className="text-foreground-muted">
          {props.count}
        </Text>
      </Pressable>
      {open ? (
        <View className="gap-1 pb-1">
          {props.children(Math.min(shown, props.loaded))}
          {props.count > shown ? (
            <Button
              size="compact"
              tone="text"
              label={`Show ${Math.min(KIN_STATEMENT_PAGE, props.count - shown)} more of ${props.count - shown}`}
              loading={loading}
              onPress={() => void more()}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A statement's review on the phone: closed sections on a long statement, a page of rows at a
 * time. Each tap goes to the server (`kin.work.statementSelect`), which keeps the selection, so
 * Confirm applies it whole on a statement of any size.
 */
export const KinStatementReviewCard = memo(function KinStatementReviewCard(props: {
  readonly review: KinStatementReviewView;
  readonly environmentId: EnvironmentId;
}) {
  const { review, environmentId } = props;
  const canApply = useAtomValue(kinClient.statementApply.permissionAtom(environmentId));
  const apply = useAtomCommand(kinClient.statementApply, { reportFailure: false });
  const undo = useAtomCommand(kinClient.statementUndo, { reportFailure: false });
  const select = useAtomCommand(kinClient.statementSelect, { reportFailure: false });
  const readRows = useAtomCommand(kinClient.statementRows, { reportFailure: false });
  const reread = useAtomCommand(kinClient.statementReread, { reportFailure: false });
  const [rereadNote, setRereadNote] = useState<string | null>(null);
  const [local, setLocal] = useState(() => kinStatementLocal(review.card.hash));
  const shown = kinStatementShown(review.card, local);
  const { card, selection } = shown;
  const [pending, setPending] = useState<"apply" | "undo" | "reread" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const confirm = kinStatementConfirm(card);
  const editable =
    (card.status === "open" || card.status === "undone") && canApply && pending === null;

  const change = async (next: KinStatementSelectChange) => {
    const hash = card.hash;
    setFailure(null);
    setLocal((prev) => kinStatementQueue(prev, hash, next));
    const result = await select({
      environmentId,
      input: { orgId: review.orgId, statementId: card.statementId, hash, change: next },
    });
    const reply = Option.getOrNull(AsyncResult.value(result))?.card ?? null;
    setLocal((prev) => kinStatementAnswered(prev, hash, reply));
    if (AsyncResult.isFailure(result))
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
  };
  const load = async (section: KinStatementSectionId) => {
    const hash = card.hash;
    const result = await readRows({
      environmentId,
      input: kinStatementRowsInput(review, section, shown.rows[section].length),
    });
    if (AsyncResult.isFailure(result)) {
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
      return false;
    }
    const page = Option.getOrNull(AsyncResult.value(result));
    if (page !== null) setLocal((prev) => kinStatementLoaded(prev, hash, page));
    return page !== null;
  };
  const target = { orgId: review.orgId, statementId: card.statementId };
  const send = async (what: "apply" | "undo") => {
    if (pending !== null) return;
    setPending(what);
    setFailure(null);
    setRereadNote(null);
    const result =
      what === "apply"
        ? await apply({ environmentId, input: kinStatementApplyInput(review, selection) })
        : await undo({ environmentId, input: target });
    setPending(null);
    if (AsyncResult.isFailure(result))
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
  };
  const readAgainNow = async () => {
    if (pending !== null) return;
    setPending("reread");
    setFailure(null);
    setRereadNote(null);
    const result = await reread({ environmentId, input: target });
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
      return;
    }
    const answer = Option.getOrNull(AsyncResult.value(result));
    if (answer !== null) setRereadNote(kinStatementRereadText(answer.status));
  };
  const readAgain = (
    <Button
      size="compact"
      tone="text"
      label="Read again"
      loading={pending === "reread"}
      disabled={pending !== null}
      onPress={() => void readAgainNow()}
    />
  );

  const rows = { shown, editable, onChange: (next: KinStatementSelectChange) => void change(next) };
  const held = kinStatementTotal(card, "matched") - (card.chosen?.matched ?? 0);
  // Matches held back for a check are ticked in one tap, without opening their section.
  const heldAll =
    card.heldBack !== undefined && editable && !kinStatementAllTicked(card, selection)
      ? kinStatementTotal(card, "matched")
      : 0;
  return (
    <Frame label={`Bank statement: ${card.title}`}>
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        Bank statement
      </Text>
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        {card.title}
      </Text>
      <View className="gap-0.5">
        {card.summary.map((line) => (
          <Text
            key={line}
            textRole="caption"
            className={
              card.balance === "off" && /add up|follow on/.test(line)
                ? "font-t3-medium text-warning-foreground"
                : "text-foreground-muted"
            }
          >
            {line}
          </Text>
        ))}
        {card.heldBack === undefined ||
        (card.status !== "open" && card.status !== "undone") ? null : (
          <Text textRole="caption" className="font-t3-medium text-warning-foreground">
            {card.heldBack}
          </Text>
        )}
      </View>
      {heldAll === 0 ? null : (
        <Button
          size="compact"
          label={`Tick all ${heldAll} matches`}
          onPress={() => void change({ _tag: "tickAll", ticked: true })}
        />
      )}
      {kinStatementSections(card).map((section) => (
        <Section
          key={section.id}
          id={section.id}
          count={section.count}
          loaded={shown.rows[section.id].length}
          openAtFirst={section.openAtFirst}
          onLoad={() => load(section.id)}
          {...(section.id === "matched" && card.chosen !== undefined && held > 0
            ? { aside: `${held} not ticked` }
            : {})}
        >
          {(count) =>
            section.id === "matched" ? (
              <MatchedRows {...rows} count={count} />
            ) : section.id === "choose" ? (
              <ChooseRows {...rows} count={count} />
            ) : (
              <UnmatchedRows {...rows} count={count} />
            )
          }
        </Section>
      ))}
      {kinStatementStatusLines(card).map((line) => (
        <Text
          key={line}
          textRole="footnote"
          accessibilityLiveRegion="polite"
          className="text-foreground"
        >
          {line}
        </Text>
      ))}
      {rereadNote === null ? null : (
        <Text accessibilityLiveRegion="polite" textRole="caption" className="text-foreground-muted">
          {rereadNote}
        </Text>
      )}
      {failure === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          textRole="caption"
          className="font-t3-medium text-danger-foreground"
        >
          {failure}
        </Text>
      )}
      {card.status === "replaced" ? null : !canApply ? (
        <Text textRole="caption" className="text-foreground-muted">
          This phone can't confirm here. Pair it again with the server that runs Kin.
        </Text>
      ) : card.status === "applied" ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            size="compact"
            label="Undo this statement"
            loading={pending === "undo"}
            disabled={pending !== null}
            onPress={() => void send("undo")}
          />
          {readAgain}
        </View>
      ) : (
        <View className="gap-1 pt-1">
          <Button
            tone="primary"
            fullWidth
            label={confirm.label}
            loading={pending === "apply"}
            disabled={pending !== null || shown.sending || confirm.count === 0}
            onPress={() => void send("apply")}
          />
          <Text textRole="caption" className="text-center text-foreground-muted">
            Rows you leave stay unexplained for later.
          </Text>
          {readAgain}
        </View>
      )}
    </Frame>
  );
});

interface RowsProps {
  readonly shown: Shown;
  readonly count: number;
  readonly editable: boolean;
  readonly onChange: (change: KinStatementSelectChange) => void;
}

function MatchedRows(props: RowsProps) {
  const { card, rows, selection } = props.shown;
  const all = kinStatementAllTicked(card, selection);
  return (
    <View>
      {!props.editable ? null : (
        <Button
          size="compact"
          label={all ? "Untick all" : "Tick all"}
          onPress={() => props.onChange({ _tag: "tickAll", ticked: !all })}
        />
      )}
      {rows.matched.slice(0, props.count).map((one) => {
        if (one.recorded !== undefined)
          return <RecordedRow key={one.row} row={one} recorded={one.recorded} />;
        const ticked = kinStatementTicked(selection, one.row);
        return (
          <Pressable
            key={one.row}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ticked, disabled: !props.editable }}
            accessibilityLabel={`${one.text}, ${one.amount}, to ${kinStatementTargetLine(one.target)}`}
            disabled={!props.editable}
            onPress={() => props.onChange({ _tag: "tick", row: one.row, ticked: !ticked })}
            className="min-h-11 flex-row items-start gap-3 py-1.5 active:opacity-70"
          >
            <SymbolView
              name={ticked ? "checkmark.circle.fill" : "circle"}
              size={20}
              tintColorClassName={ticked ? "accent-primary" : "accent-icon-muted"}
              type="monochrome"
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <RowLine row={one} muted={!ticked} />
              <Text textRole="caption" className="text-foreground-muted">
                {kinStatementTargetLine(one.target)}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function ChooseRows(props: RowsProps) {
  const { rows, selection } = props.shown;
  return (
    <View className="gap-2">
      {rows.choose.slice(0, props.count).map((one) => {
        if (one.recorded !== undefined)
          return <RecordedRow key={one.row} row={one} recorded={one.recorded} />;
        const picked = kinStatementPickOf(selection, one.row);
        const taken = one.options.flatMap((option) => {
          const other = kinStatementTakenBy(rows.choose, selection, one.row, option);
          return other === undefined ? [] : [{ option, other }];
        });
        return (
          <View key={one.row} className="gap-1.5 py-1">
            <RowLine row={one} />
            <View className="flex-row flex-wrap gap-1.5">
              {one.options.map((option) => (
                <Chip
                  key={option.option}
                  size="small"
                  label={kinStatementTargetLine(option)}
                  selected={picked === option.option}
                  disabled={!props.editable || taken.some((one) => one.option === option)}
                  onPress={() =>
                    props.onChange({
                      _tag: "pick",
                      row: one.row,
                      option: picked === option.option ? null : option.option,
                    })
                  }
                />
              ))}
            </View>
            {taken.map(({ option, other }) => (
              <Text key={option.option} textRole="caption" className="text-foreground-muted">
                {option.key} is picked for the {day(other.date)} row of {other.amount}.
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

function UnmatchedRows(props: RowsProps) {
  const { card, rows, selection } = props.shown;
  const open = kinStatementOpenSuggestions(rows.unmatched, selection);
  const whole = rows.unmatched.length >= kinStatementTotal(card, "unmatched");
  return (
    <View className="gap-2">
      {!kinStatementSuggestionsLeft(card, rows.unmatched, selection) || !props.editable ? null : (
        <Button
          size="compact"
          label={
            whole
              ? `Use Kin's suggestions for ${open} ${open === 1 ? "row" : "rows"}`
              : "Use Kin's suggestions"
          }
          onPress={() => props.onChange({ _tag: "suggestions" })}
        />
      )}
      {rows.unmatched.slice(0, props.count).map((one) => {
        if (one.recorded !== undefined)
          return <RecordedRow key={one.row} row={one} recorded={one.recorded} />;
        const action = kinStatementActionOf(selection, one);
        const note = kinStatementRowNote(one, action);
        return (
          <View key={one.row} className="gap-1.5 py-1">
            <RowLine row={one} muted={action === "later"} />
            <View className="flex-row flex-wrap gap-1.5">
              {kinStatementActionsFor(one).map((choice) => (
                <Chip
                  key={choice}
                  size="small"
                  label={KIN_STATEMENT_ACTION_LABELS[choice]}
                  accessibilityLabel={`${KIN_STATEMENT_ACTION_LABELS[choice]}: ${one.text}`}
                  selected={action === choice}
                  disabled={!props.editable}
                  onPress={() => props.onChange({ _tag: "action", row: one.row, action: choice })}
                />
              ))}
            </View>
            {note === null ? null : (
              <Text textRole="caption" className="text-foreground-muted">
                {note}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * A locked statement's password, typed into a masked field and sent once to Kin over
 * `kin.work.statementUnlock`, redacted; never a message, so the lead only learns it opened.
 */
export const KinStatementPasswordCard = memo(function KinStatementPasswordCard(props: {
  readonly password: KinStatementPasswordView;
  readonly environmentId: EnvironmentId;
}) {
  const { password, environmentId } = props;
  const { card } = password;
  const canUnlock = useAtomValue(kinClient.statementUnlock.permissionAtom(environmentId));
  const unlock = useAtomCommand(kinClient.statementUnlock, { reportFailure: false });
  const forget = useAtomCommand(kinClient.statementForgetPassword, { reportFailure: false });
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = { orgId: password.orgId, statementId: card.statementId };

  const open = async (typed: string) => {
    if (pending || typed === "") return;
    setPending(true);
    setFailure(null);
    const result = await unlock({
      environmentId,
      input: { ...input, password: Redacted.make(typed), remember },
    });
    setPending(false);
    setValue("");
    if (AsyncResult.isFailure(result))
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
  };
  const forgetIt = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const result = await forget({ environmentId, input });
    setPending(false);
    if (AsyncResult.isFailure(result))
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
  };

  return (
    <Frame label={`Locked statement: ${card.fileName}`}>
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        Locked statement
      </Text>
      {kinStatementPasswordLines(card).map((line, index) => (
        <Text
          key={line}
          textRole={index === 0 ? "footnote" : "caption"}
          accessibilityLiveRegion={index === 0 && card.status === "wrong" ? "polite" : "none"}
          className={
            index === 0
              ? card.status === "wrong"
                ? "font-t3-medium text-warning-foreground"
                : "text-foreground"
              : "text-foreground-muted"
          }
        >
          {line}
        </Text>
      ))}
      {failure === null ? null : (
        <Text
          accessibilityRole="alert"
          textRole="caption"
          className="font-t3-medium text-danger-foreground"
        >
          {failure}
        </Text>
      )}
      {!canUnlock ? null : kinStatementNeedsPassword(card) ? (
        <View className="gap-2 pt-1">
          <SecretTextInput
            accessibilityLabel={`Password for ${card.fileName}`}
            placeholder="Statement password"
            value={value}
            onChangeText={setValue}
            editable={!pending}
            onSubmitEditing={(typed) => void open(typed)}
          />
          <View className="min-h-11 flex-row items-center gap-3">
            <Text textRole="caption" className="min-w-0 flex-1 text-foreground-muted">
              Remember for this account, so the next statement opens on its own
            </Text>
            <ThemedSwitch
              accessibilityLabel="Remember the password for this account"
              value={remember}
              disabled={pending}
              onValueChange={setRemember}
            />
          </View>
          <Button
            tone="primary"
            fullWidth
            label="Open"
            loading={pending}
            disabled={value === ""}
            onPress={() => void open(value)}
          />
        </View>
      ) : card.status === "opened" && card.remembered !== undefined ? (
        <Button
          size="compact"
          tone="text"
          label="Forget the password"
          loading={pending}
          onPress={() => void forgetIt()}
        />
      ) : null}
    </Frame>
  );
});
