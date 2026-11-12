import { useAtomValue } from "@effect/atom-react";
import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_DOC_CHANGES,
  kinDocChanges,
  type KinDocChange,
  type KinDocMark,
  type KinDocRun,
} from "@t3tools/client-runtime/kin/kinDocChanges";
import { KIN_DOCS } from "@t3tools/client-runtime/kin/kinDocs";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinRecordKey } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinWorkNotice } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

const ADDED = "rounded-sm bg-success/15 text-foreground no-underline";
const REMOVED = "rounded-sm bg-destructive/10 text-muted-foreground line-through";
const ROW_MARK: Record<KinDocMark | "changed", string> = {
  same: "",
  changed: "",
  added: "bg-success/10",
  removed: "bg-destructive/8",
};

function Runs(props: { readonly runs: ReadonlyArray<KinDocRun> }) {
  return props.runs.map((run, index) =>
    run.mark === "same" ? (
      // oxlint-disable-next-line react/no-array-index-key -- runs are positional and never reorder
      <span key={index}>{run.text}</span>
    ) : run.mark === "added" ? (
      // oxlint-disable-next-line react/no-array-index-key -- runs are positional and never reorder
      <ins key={index} className={ADDED}>
        {run.text}
      </ins>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- runs are positional and never reorder
      <del key={index} className={REMOVED}>
        {run.text}
      </del>
    ),
  );
}

const HEADING = ["", "text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"];

function Markdown(props: KinWorkTarget & { readonly markdown: string; readonly mark: KinDocMark }) {
  return (
    <div
      className={cn(
        "leading-relaxed text-foreground",
        props.mark === "added" && "rounded-md bg-success/10 px-3 py-1",
        props.mark === "removed" &&
          "rounded-md bg-destructive/8 px-3 py-1 text-muted-foreground line-through decoration-muted-foreground/60",
      )}
    >
      {props.mark === "same" ? null : (
        <span className="sr-only">
          {props.mark === "added" ? KIN_DOC_CHANGES.added : KIN_DOC_CHANGES.removed}:
        </span>
      )}
      <ChatMarkdown
        text={kinBodyMarkdown(props.markdown)}
        cwd={undefined}
        environmentId={props.environmentId}
      />
    </div>
  );
}

function Change(props: KinWorkTarget & { readonly change: KinDocChange }) {
  const { change } = props;
  switch (change.type) {
    case "block":
      return <Markdown {...props} markdown={change.markdown} mark={change.mark} />;
    case "text":
      return change.block === "heading" ? (
        <p
          role="heading"
          aria-level={change.level}
          className={cn("font-semibold text-foreground", HEADING[change.level] ?? "text-base")}
        >
          <Runs runs={change.runs} />
        </p>
      ) : (
        <p
          className={cn(
            "leading-relaxed text-foreground",
            change.block === "quote" && "border-s-2 border-border ps-4 text-muted-foreground",
          )}
        >
          <Runs runs={change.runs} />
        </p>
      );
    case "list": {
      const List = change.ordered ? "ol" : "ul";
      return (
        <List
          className={cn(
            "flex flex-col gap-1 ps-6 leading-relaxed text-foreground",
            change.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {change.items.map((item, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- list items are positional and never reorder
            <li key={index} className={cn("rounded-sm", ROW_MARK[item.mark])}>
              <Runs runs={item.runs} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-start">
                {change.header.map((cell, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- columns are positional and never reorder
                  <th key={index} className="px-3 py-1.5 text-start font-medium text-foreground">
                    <Runs runs={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {change.rows.map((row, at) => (
                <tr
                  // oxlint-disable-next-line react/no-array-index-key -- rows are positional and never reorder
                  key={at}
                  className={cn("border-b border-border/60 last:border-b-0", ROW_MARK[row.mark])}
                >
                  {row.cells.map((cell, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- columns are positional and never reorder
                    <td key={index} className="px-3 py-1.5 align-top text-foreground">
                      <Runs runs={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs leading-5 text-foreground">
          {change.lines.map((line, index) => (
            <div
              // oxlint-disable-next-line react/no-array-index-key -- lines are positional and never reorder
              key={index}
              className={cn(
                line.mark === "added" && "bg-success/15",
                line.mark === "removed" && "bg-destructive/10 text-muted-foreground line-through",
              )}
            >
              {line.text === "" ? " " : line.text}
            </div>
          ))}
        </pre>
      );
  }
}

/** A long stretch folded to one line that says what it is, opened on request. */
function Folded(
  props: KinWorkTarget & {
    readonly label: string;
    readonly mark: KinDocMark;
    readonly markdown: string;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset",
          props.mark === "same"
            ? "text-muted-foreground"
            : props.mark === "added"
              ? "bg-success/10 text-foreground"
              : "bg-destructive/8 text-foreground",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span className="shrink-0 text-muted-foreground">
          {open ? KIN_DOC_CHANGES.hide : KIN_DOC_CHANGES.show}
        </span>
      </button>
      {open ? <Markdown {...props} /> : null}
    </div>
  );
}

/** Two versions of a doc read as one document, with what came and went marked in place. */
export function KinDocChangesView(
  props: KinWorkTarget & {
    readonly docKey: KinRecordKey;
    readonly from: number;
    readonly to: number;
  },
) {
  const { environmentId, orgId, docKey } = props;
  const fromAtom = kinClient.doc({
    environmentId,
    input: { orgId, key: docKey, version: props.from },
  });
  const toAtom = kinClient.doc({ environmentId, input: { orgId, key: docKey, version: props.to } });
  const from = kinWorkReadState(useAtomValue(fromAtom));
  const to = kinWorkReadState(useAtomValue(toAtom));
  const before = from._tag === "ready" ? from.value.body : null;
  const after = to._tag === "ready" ? to.value.body : null;
  const view = before === null || after === null ? null : kinDocChanges(before, after);
  if (from._tag === "loading" || to._tag === "loading")
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading changes">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    );
  if (view === null)
    return (
      <KinWorkNotice
        title="Couldn't load the changes"
        detail="Check your connection to the server and try again."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              appAtomRegistry.refresh(fromAtom);
              appAtomRegistry.refresh(toAtom);
            }}
          >
            Retry
          </Button>
        }
      />
    );
  if (view.identical) return <KinWorkNotice {...KIN_DOCS.noChanges} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{KIN_DOC_CHANGES.legend}</p>
      {view.parts.map((part) =>
        part.type === "shown" ? (
          <Change key={part.id} {...props} change={part.change} />
        ) : (
          <Folded
            key={part.id}
            {...props}
            label={part.label}
            mark={part.mark}
            markdown={part.markdown}
          />
        ),
      )}
    </div>
  );
}
