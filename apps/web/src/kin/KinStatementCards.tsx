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
  kinStatementPasswordLines,
  kinStatementPick,
  kinStatementSections,
  kinStatementSetAction,
  kinStatementStatusLines,
  kinStatementTargetLine,
  kinStatementToggle,
  type KinStatementPasswordView,
  type KinStatementReviewView,
  type KinStatementSectionId,
  type KinStatementSelection,
} from "@t3tools/client-runtime/kin/kinStatementPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
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

type ReviewCard = KinStatementReviewView["card"];
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

function Section(props: {
  readonly id: KinStatementSectionId;
  readonly count: number;
  readonly openAtFirst: boolean;
  readonly aside?: string;
  readonly children: (shown: number) => ReactNode;
}) {
  const [open, setOpen] = useState(props.openAtFirst);
  const [shown, setShown] = useState(KIN_STATEMENT_PAGE);
  const bodyId = useId();
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
          {props.children(shown)}
          {props.count > shown ? (
            <Button size="xs" variant="ghost" onClick={() => setShown(shown + KIN_STATEMENT_PAGE)}>
              Show {Math.min(KIN_STATEMENT_PAGE, props.count - shown)} more of {props.count - shown}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A statement's review: what Kin matched, what needs a pick, and what is left, with one Confirm
 * for exactly the rows shown. Sections stay closed on a long statement, and open a page at a time.
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
  // A new read of the statement is a new card hash, and starts from Kin's proposal again.
  const [held, setHeld] = useState<{
    readonly hash: string;
    readonly selection: KinStatementSelection;
  }>({
    hash: card.hash,
    selection: KIN_STATEMENT_EMPTY_SELECTION,
  });
  const selection = held.hash === card.hash ? held.selection : KIN_STATEMENT_EMPTY_SELECTION;
  const change = (next: KinStatementSelection) => setHeld({ hash: card.hash, selection: next });
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

  const status = kinStatementStatusLines(card);
  return (
    <CardFrame eyebrow="Bank statement" label={`Bank statement: ${card.title}`}>
      <p className="font-medium text-foreground">{card.title}</p>
      <div className="flex flex-col gap-0.5">
        {card.summary.map((line) => (
          <p
            key={line}
            className={cn(
              "text-xs",
              card.balance === "off" && /add up|follow on/.test(line)
                ? "font-medium text-warning-foreground"
                : "text-muted-foreground",
            )}
          >
            {line}
          </p>
        ))}
      </div>
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
              <MatchedRows
                card={card}
                shown={shown}
                selection={selection}
                editable={editable}
                onChange={change}
              />
            ) : section.id === "choose" ? (
              <ChooseRows
                card={card}
                shown={shown}
                selection={selection}
                editable={editable}
                onChange={change}
              />
            ) : (
              <UnmatchedRows
                card={card}
                shown={shown}
                selection={selection}
                editable={editable}
                onChange={change}
              />
            )
          }
        </Section>
      ))}
      {status.map((line) => (
        <p key={line} role="status" className="text-xs font-medium text-foreground">
          {line}
        </p>
      ))}
      {failure === null ? null : (
        <p role="alert" className="text-xs font-medium text-destructive-foreground">
          {failure}
        </p>
      )}
      {!canApply ? (
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
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            aria-busy={pending === "apply"}
            disabled={pending !== null || confirm.count === 0}
            onClick={() => void send("apply")}
          >
            {confirm.label}
          </Button>
          <span className="text-xs text-muted-foreground">
            Rows you leave stay unexplained for later.
          </span>
        </div>
      )}
    </CardFrame>
  );
});

interface RowsProps {
  readonly card: ReviewCard;
  readonly shown: number;
  readonly selection: KinStatementSelection;
  readonly editable: boolean;
  readonly onChange: (next: KinStatementSelection) => void;
}

function MatchedRows(props: RowsProps) {
  return (
    <ul className="flex flex-col">
      {props.card.matched.slice(0, props.shown).map((one) => {
        const ticked = !props.selection.unticked.has(one.row);
        return (
          <li key={one.row}>
            <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md py-1.5">
              <Checkbox
                className="mt-0.5"
                checked={ticked}
                disabled={!props.editable}
                onCheckedChange={() => props.onChange(kinStatementToggle(props.selection, one.row))}
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
  return (
    <ul className="flex flex-col gap-2">
      {props.card.choose.slice(0, props.shown).map((one) => {
        const picked = props.selection.picks.get(one.row);
        return (
          <li key={one.row} className="flex flex-col gap-1 py-1">
            <RowLine row={one} />
            <div
              role="group"
              aria-label={`Matches for ${one.text}`}
              className="flex flex-col gap-1 pl-14"
            >
              {one.options.map((option) => (
                <Button
                  key={option.option}
                  size="sm-multiline"
                  variant={picked === option.option ? "default" : "outline"}
                  aria-pressed={picked === option.option}
                  disabled={!props.editable}
                  onClick={() =>
                    props.onChange(kinStatementPick(props.selection, one.row, option.option))
                  }
                >
                  {kinStatementTargetLine(option)}
                </Button>
              ))}
              {picked === undefined ? (
                <span className="text-xs text-muted-foreground">Unpicked rows wait for later.</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function UnmatchedRows(props: RowsProps) {
  return (
    <ul className="flex flex-col gap-1.5">
      {props.card.unmatched.slice(0, props.shown).map((one) => {
        const action = kinStatementActionOf(props.selection, one);
        return (
          <li key={one.row} className="flex flex-col gap-1 py-1">
            <RowLine row={one} muted={action === "later"} />
            <div className="flex flex-wrap items-center gap-1 pl-14">
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
                    onClick={() =>
                      props.onChange(kinStatementSetAction(props.selection, one.row, choice))
                    }
                  >
                    {KIN_STATEMENT_ACTION_LABELS[choice]}
                  </Button>
                ))}
              </div>
              {action === "expense" && (one.vendor !== undefined || one.category !== undefined) ? (
                <span className="text-xs text-muted-foreground">
                  {[one.vendor, one.category].filter((part) => part !== undefined).join(", ")}
                </span>
              ) : one.why !== undefined && action === one.suggestion ? (
                <span className="text-xs text-muted-foreground">{one.why}</span>
              ) : null}
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
