import { useAtomValue } from "@effect/atom-react";
import {
  KIN_STATEMENT_ACTION_LABELS,
  KIN_STATEMENT_EMPTY_SELECTION,
  KIN_STATEMENT_PAGE,
  KIN_STATEMENT_SECTION_TITLES,
  kinStatementActionOf,
  kinStatementActionsFor,
  kinStatementApplyInput,
  kinStatementConfirm,
  kinStatementFailureText,
  kinStatementNeedsPassword,
  kinStatementOpenSuggestions,
  kinStatementPasswordLines,
  kinStatementPick,
  kinStatementRowNote,
  kinStatementSections,
  kinStatementSetAction,
  kinStatementStatusLines,
  kinStatementTargetLine,
  kinStatementToggle,
  kinStatementUseSuggestions,
  type KinStatementPasswordView,
  type KinStatementReviewView,
  type KinStatementSectionId,
  type KinStatementSelection,
} from "@t3tools/client-runtime/kin/kinStatementPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
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

type ReviewCard = KinStatementReviewView["card"];
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

function Section(props: {
  readonly id: KinStatementSectionId;
  readonly count: number;
  readonly openAtFirst: boolean;
  readonly aside?: string;
  readonly children: (shown: number) => ReactNode;
}) {
  const [open, setOpen] = useState(props.openAtFirst);
  const [shown, setShown] = useState(KIN_STATEMENT_PAGE);
  const title = KIN_STATEMENT_SECTION_TITLES[props.id];
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
          {props.children(shown)}
          {props.count > shown ? (
            <Button
              size="compact"
              tone="text"
              label={`Show ${Math.min(KIN_STATEMENT_PAGE, props.count - shown)} more of ${props.count - shown}`}
              onPress={() => setShown(shown + KIN_STATEMENT_PAGE)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A statement's review on the phone: closed sections on a long statement, a page of rows at a
 * time, and one Confirm for exactly the rows shown (`kin.work.statementApply`).
 */
export const KinStatementReviewCard = memo(function KinStatementReviewCard(props: {
  readonly review: KinStatementReviewView;
  readonly environmentId: EnvironmentId;
}) {
  const { review, environmentId } = props;
  const { card } = review;
  const canApply = useAtomValue(kinClient.statementApply.permissionAtom(environmentId));
  const apply = useAtomCommand(kinClient.statementApply, { reportFailure: false });
  const undo = useAtomCommand(kinClient.statementUndo, { reportFailure: false });
  const [held, setHeld] = useState<{
    readonly hash: string;
    readonly selection: KinStatementSelection;
  }>({
    hash: card.hash,
    selection: KIN_STATEMENT_EMPTY_SELECTION,
  });
  const selection = held.hash === card.hash ? held.selection : KIN_STATEMENT_EMPTY_SELECTION;
  const change = (update: (selection: KinStatementSelection) => KinStatementSelection) =>
    setHeld((prev) => ({
      hash: card.hash,
      selection: update(prev.hash === card.hash ? prev.selection : KIN_STATEMENT_EMPTY_SELECTION),
    }));
  const [pending, setPending] = useState<"apply" | "undo" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const confirm = kinStatementConfirm(review, selection);
  const editable = card.status !== "applied" && canApply && pending === null;

  const send = async (what: "apply" | "undo") => {
    if (pending !== null) return;
    setPending(what);
    setFailure(null);
    const result =
      what === "apply"
        ? await apply({ environmentId, input: kinStatementApplyInput(review, selection) })
        : await undo({
            environmentId,
            input: { orgId: review.orgId, statementId: card.statementId },
          });
    setPending(null);
    if (AsyncResult.isFailure(result))
      setFailure(kinStatementFailureText(squashAtomCommandFailure(result)));
  };

  const rows = { card, selection, editable, onChange: change };
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
      </View>
      {kinStatementSections(card).map((section) => (
        <Section
          key={section.id}
          id={section.id}
          count={section.count}
          openAtFirst={section.openAtFirst}
          {...(section.id === "matched" && selection.unticked.size > 0
            ? { aside: `${selection.unticked.size} held back` }
            : {})}
        >
          {(shown) =>
            section.id === "matched" ? (
              <MatchedRows {...rows} shown={shown} />
            ) : section.id === "choose" ? (
              <ChooseRows {...rows} shown={shown} />
            ) : (
              <UnmatchedRows {...rows} shown={shown} />
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
      {!canApply ? (
        <Text textRole="caption" className="text-foreground-muted">
          This phone can't confirm here. Pair it again with the server that runs Kin.
        </Text>
      ) : card.status === "applied" ? (
        <Button
          size="compact"
          label="Undo this statement"
          loading={pending === "undo"}
          disabled={pending !== null}
          onPress={() => void send("undo")}
        />
      ) : (
        <View className="gap-1 pt-1">
          <Button
            tone="primary"
            fullWidth
            label={confirm.label}
            loading={pending === "apply"}
            disabled={pending !== null || confirm.count === 0}
            onPress={() => void send("apply")}
          />
          <Text textRole="caption" className="text-center text-foreground-muted">
            Rows you leave stay unexplained for later.
          </Text>
        </View>
      )}
    </Frame>
  );
});

interface RowsProps {
  readonly card: ReviewCard;
  readonly shown: number;
  readonly selection: KinStatementSelection;
  readonly editable: boolean;
  readonly onChange: (update: (selection: KinStatementSelection) => KinStatementSelection) => void;
}

function MatchedRows(props: RowsProps) {
  return (
    <View>
      {props.card.matched.slice(0, props.shown).map((one) => {
        const ticked = !props.selection.unticked.has(one.row);
        return (
          <Pressable
            key={one.row}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ticked, disabled: !props.editable }}
            accessibilityLabel={`${one.text}, ${one.amount}, to ${kinStatementTargetLine(one.target)}`}
            disabled={!props.editable}
            onPress={() => props.onChange((selection) => kinStatementToggle(selection, one.row))}
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
  return (
    <View className="gap-2">
      {props.card.choose.slice(0, props.shown).map((one) => {
        const picked = props.selection.picks.get(one.row);
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
                  disabled={!props.editable}
                  onPress={() =>
                    props.onChange((selection) =>
                      kinStatementPick(selection, one.row, option.option),
                    )
                  }
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function UnmatchedRows(props: RowsProps) {
  const open = kinStatementOpenSuggestions(props.card, props.selection);
  return (
    <View className="gap-2">
      {open === 0 || !props.editable ? null : (
        <Button
          size="compact"
          label={`Use Kin's suggestions for ${open} ${open === 1 ? "row" : "rows"}`}
          onPress={() =>
            props.onChange((selection) => kinStatementUseSuggestions(props.card, selection))
          }
        />
      )}
      {props.card.unmatched.slice(0, props.shown).map((one) => {
        const action = kinStatementActionOf(props.selection, one);
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
                  onPress={() =>
                    props.onChange((selection) => kinStatementSetAction(selection, one.row, choice))
                  }
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
