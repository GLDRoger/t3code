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
  kinStatementUndoLabel,
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
import { ChevronRightIcon } from "lucide-react";
import { memo, useId, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { CardFrame } from "./KinCards";
import { kinClient } from "./kinClient";

const CANT_ACT_TEXT =
  "This browser can't confirm here. Pair it again with the server that runs Kin.";

type Shown = ReturnType<typeof kinStatementShown>;
type Row = {
  readonly row: number;
  readonly date: string;
  readonly text: string;
  readonly amount: string;
};

const day = (iso: string) => {
  const [, month, date] = iso.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1] ?? ""}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A statement row's own words: its day, narration and amount, on one line where it fits. */
function RowLine(props: { readonly row: Row; readonly muted?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
        {day(props.row.date)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 line-clamp-2 break-words",
          props.muted === true ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {props.row.text}
      </span>
      <span className="shrink-0 text-xs font-medium tabular-nums">{props.row.amount}</span>
    </div>
  );
}

/** A row this statement already recorded and an undo kept: what holds it, and nothing to change. */
function RecordedRow(props: { readonly row: Row & { readonly recorded: string } }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <RowLine row={props.row} muted />
      <span className="text-xs text-muted-foreground sm:pl-14">{props.row.recorded}</span>
    </li>
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
  const bodyId = useId();
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
    <div className="flex flex-col border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className="flex min-h-9 items-center gap-1.5 rounded-md text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
        <span className="flex-1">{KIN_STATEMENT_SECTION_TITLES[props.id]}</span>
        {props.aside === undefined ? null : (
          <span className="text-xs text-muted-foreground">{props.aside}</span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">{props.count}</span>
      </button>
      {open ? (
        <div id={bodyId} className="flex flex-col gap-1 pb-1">
          {props.children(Math.min(shown, props.loaded))}
          {props.count > shown ? (
            <Button
              size="xs"
              variant="ghost"
              aria-busy={loading}
              disabled={loading}
              onClick={() => void more()}
            >
              Show {Math.min(KIN_STATEMENT_PAGE, props.count - shown)} more of {props.count - shown}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A statement's review: what Kin matched, what needs a pick, and what is left. Each tap goes to
 * the server, which keeps the selection, so Confirm applies it whole on a statement of any size.
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
      size="sm"
      variant="ghost"
      aria-busy={pending === "reread"}
      disabled={pending !== null}
      onClick={() => void readAgainNow()}
    >
      Read again
    </Button>
  );

  const status = kinStatementStatusLines(card);
  const undoBefore = kinStatementUndoLabel(card);
  const rows = { shown, editable, onChange: (next: KinStatementSelectChange) => void change(next) };
  const held = kinStatementTotal(card, "matched") - (card.chosen?.matched ?? 0);
  // Matches held back for a check are ticked in one tap, without opening their section.
  const heldAll =
    card.heldBack !== undefined && editable && !kinStatementAllTicked(card, selection)
      ? kinStatementTotal(card, "matched")
      : 0;
  return (
    <CardFrame eyebrow="Bank statement" label={`Bank statement: ${card.title}`}>
      <p className="font-medium text-foreground">{card.title}</p>
      <div className="flex flex-col gap-0.5">
        {card.summary.map((line) => (
          <p
            key={line}
            className={cn(
              "text-xs",
              card.balance === "off" && /add up|follow on| apart\. /.test(line)
                ? "font-medium text-warning-foreground"
                : "text-muted-foreground",
            )}
          >
            {line}
          </p>
        ))}
        {card.heldBack === undefined ||
        (card.status !== "open" && card.status !== "undone") ? null : (
          <p className="text-xs font-medium text-warning-foreground">{card.heldBack}</p>
        )}
      </div>
      {heldAll === 0 ? null : (
        <div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void change({ _tag: "tickAll", ticked: true })}
          >
            Tick all {heldAll} matches
          </Button>
        </div>
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
      {status.map((line) => (
        <p key={line} role="status" className="text-xs font-medium text-foreground">
          {line}
        </p>
      ))}
      {rereadNote === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {rereadNote}
        </p>
      )}
      {failure === null ? null : (
        <p role="alert" className="text-xs font-medium text-destructive-foreground">
          {failure}
        </p>
      )}
      {card.status === "replaced" ? null : !canApply ? (
        <p className="text-xs text-muted-foreground">{CANT_ACT_TEXT}</p>
      ) : card.status === "applied" ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button
            size="sm"
            variant="outline"
            aria-busy={pending === "undo"}
            disabled={pending !== null}
            onClick={() => void send("undo")}
          >
            Undo this statement
          </Button>
          {readAgain}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            aria-busy={pending === "apply" || shown.sending}
            disabled={pending !== null || shown.sending || confirm.count === 0}
            onClick={() => void send("apply")}
          >
            {confirm.label}
          </Button>
          <span className="text-xs text-muted-foreground">
            Rows you leave stay unexplained for later.
          </span>
          <span className="ms-auto flex gap-1.5">
            {undoBefore === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                aria-busy={pending === "undo"}
                disabled={pending !== null}
                onClick={() => void send("undo")}
              >
                {undoBefore}
              </Button>
            )}
            {readAgain}
          </span>
        </div>
      )}
    </CardFrame>
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
    <ul className="flex flex-col">
      {!props.editable ? null : (
        <li>
          <Button
            size="xs"
            variant="outline"
            onClick={() => props.onChange({ _tag: "tickAll", ticked: !all })}
          >
            {all ? "Untick all" : "Tick all"}
          </Button>
        </li>
      )}
      {rows.matched.slice(0, props.count).map((one) => {
        if (one.recorded !== undefined)
          return <RecordedRow key={one.row} row={{ ...one, recorded: one.recorded }} />;
        const ticked = kinStatementTicked(selection, one.row);
        return (
          <li key={one.row}>
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md py-1.5">
              <Checkbox
                className="mt-0.5"
                checked={ticked}
                disabled={!props.editable}
                onCheckedChange={() =>
                  props.onChange({ _tag: "tick", row: one.row, ticked: !ticked })
                }
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <RowLine row={one} muted={!ticked} />
                <span className="text-xs text-muted-foreground">
                  {kinStatementTargetLine(one.target)}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function ChooseRows(props: RowsProps) {
  const { rows, selection } = props.shown;
  return (
    <ul className="flex flex-col gap-2">
      {rows.choose.slice(0, props.count).map((one) => {
        if (one.recorded !== undefined)
          return <RecordedRow key={one.row} row={{ ...one, recorded: one.recorded }} />;
        const picked = kinStatementPickOf(selection, one.row);
        const taken = one.options.flatMap((option) => {
          const other = kinStatementTakenBy(rows.choose, selection, one.row, option);
          return other === undefined ? [] : [{ option, other }];
        });
        return (
          <li key={one.row} className="flex flex-col gap-1 py-1">
            <RowLine row={one} />
            <div
              role="group"
              aria-label={`Matches for ${one.text}`}
              className="flex flex-col gap-1 sm:pl-14"
            >
              {one.options.map((option) => (
                <Button
                  key={option.option}
                  size="sm-multiline"
                  variant={picked === option.option ? "default" : "outline"}
                  aria-pressed={picked === option.option}
                  disabled={!props.editable || taken.some((one) => one.option === option)}
                  onClick={() =>
                    props.onChange({
                      _tag: "pick",
                      row: one.row,
                      option: picked === option.option ? null : option.option,
                    })
                  }
                >
                  {kinStatementTargetLine(option)}
                </Button>
              ))}
              {taken.map(({ option, other }) => (
                <p key={option.option} className="text-xs text-muted-foreground">
                  {option.key} is picked for the {day(other.date)} row of {other.amount}.
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function UnmatchedRows(props: RowsProps) {
  const { card, rows, selection } = props.shown;
  const open = kinStatementOpenSuggestions(rows.unmatched, selection);
  const whole = rows.unmatched.length >= kinStatementTotal(card, "unmatched");
  return (
    <ul className="flex flex-col gap-1.5">
      {!kinStatementSuggestionsLeft(card, rows.unmatched, selection) || !props.editable ? null : (
        <li>
          <Button
            size="xs"
            variant="outline"
            onClick={() => props.onChange({ _tag: "suggestions" })}
          >
            {whole
              ? `Use Kin's suggestions for ${open} ${open === 1 ? "row" : "rows"}`
              : "Use Kin's suggestions"}
          </Button>
        </li>
      )}
      {rows.unmatched.slice(0, props.count).map((one) => {
        if (one.recorded !== undefined)
          return <RecordedRow key={one.row} row={{ ...one, recorded: one.recorded }} />;
        const action = kinStatementActionOf(selection, one);
        const note = kinStatementRowNote(one, action);
        return (
          <li key={one.row} className="flex flex-col gap-1 py-1">
            <RowLine row={one} muted={action === "later"} />
            <div className="flex flex-wrap items-center gap-1 sm:pl-14">
              <div
                role="radiogroup"
                aria-label={`What ${one.text} is`}
                className="flex flex-wrap gap-1"
              >
                {kinStatementActionsFor(one).map((choice) => (
                  <Button
                    key={choice}
                    size="xs"
                    role="radio"
                    variant={action === choice ? "secondary" : "ghost-muted"}
                    aria-checked={action === choice}
                    disabled={!props.editable}
                    onClick={() => props.onChange({ _tag: "action", row: one.row, action: choice })}
                  >
                    {KIN_STATEMENT_ACTION_LABELS[choice]}
                  </Button>
                ))}
              </div>
              {note === null ? null : <span className="text-xs text-muted-foreground">{note}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A locked statement's password. It goes to Kin once over the guarded command, redacted on the
 * way, and never into a message: the lead only learns the file opened.
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
  const inputId = useId();
  const input = { orgId: password.orgId, statementId: card.statementId };

  const open = async () => {
    if (pending || value === "") return;
    setPending(true);
    setFailure(null);
    const result = await unlock({
      environmentId,
      input: { ...input, password: Redacted.make(value), remember },
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

  const lines = kinStatementPasswordLines(card);
  return (
    <CardFrame eyebrow="Locked statement" label={`Locked statement: ${card.fileName}`}>
      {lines.map((line, index) => (
        <p
          key={line}
          role={index === 0 && card.status === "wrong" ? "alert" : undefined}
          className={cn(
            index === 0 ? "text-foreground" : "text-xs text-muted-foreground",
            card.status === "wrong" && index === 0 && "font-medium text-warning-foreground",
          )}
        >
          {line}
        </p>
      ))}
      {failure === null ? null : (
        <p role="alert" className="text-xs font-medium text-destructive-foreground">
          {failure}
        </p>
      )}
      {!canUnlock ? null : kinStatementNeedsPassword(card) ? (
        <form
          className="flex flex-col gap-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault();
            void open();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Password for {card.fileName}
          </label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Statement password"
              value={value}
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button type="submit" size="sm" aria-busy={pending} disabled={pending || value === ""}>
              Open
            </Button>
          </div>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={remember}
              disabled={pending}
              onCheckedChange={(next) => setRemember(next)}
            />
            Remember for this account, so the next statement opens on its own
          </label>
        </form>
      ) : card.status === "opened" && card.remembered !== undefined ? (
        <div className="pt-1">
          <Button
            size="xs"
            variant="ghost"
            aria-busy={pending}
            disabled={pending}
            onClick={() => void forgetIt()}
          >
            Forget the password
          </Button>
        </div>
      ) : null}
    </CardFrame>
  );
});
