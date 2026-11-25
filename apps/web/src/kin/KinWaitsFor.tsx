import type { KinWaitsForGroup } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_WAITS_FOR_COPY,
  type KinDirectory,
  kinWaitingRowView,
  kinWaitsForDetail,
} from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinChatSummary } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

/**
 * What waits on someone else that the viewer may see, one fold per person, closed at first. Its
 * rows are to look at only: a click opens what each asks, and none has an answer button.
 */
export function KinWaitsForFolds(props: {
  readonly groups: ReadonlyArray<KinWaitsForGroup>;
  readonly chats: ReadonlyArray<KinChatSummary>;
  readonly directory: KinDirectory;
}) {
  return props.groups.map((group) => (
    <KinWaitsForFold key={group.personId} {...props} group={group} />
  ));
}

function KinWaitsForFold(props: {
  readonly group: KinWaitsForGroup;
  readonly chats: ReadonlyArray<KinChatSummary>;
  readonly directory: KinDirectory;
}) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <Button
        variant="ghost"
        size="sm-multiline"
        aria-expanded={open}
        aria-label={KIN_WAITS_FOR_COPY.foldLabel(group.items.length, group.name)}
        className="justify-start"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span className="min-w-0 flex-1 text-start font-medium">
          {KIN_WAITS_FOR_COPY.fold(group.name, group.items.length)}
        </span>
        <Badge size="sm" variant="outline">
          {group.items.length}
        </Badge>
      </Button>
      {open ? (
        <ul className="flex flex-col p-1">
          {group.items.map((item) => (
            <KinWaitsForRow
              key={item.waitingId}
              row={kinWaitingRowView(item, props.chats, props.directory.agentNames)}
              detail={kinWaitsForDetail(item)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function KinWaitsForRow(props: {
  readonly row: ReturnType<typeof kinWaitingRowView>;
  readonly detail: ReadonlyArray<string>;
}) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-xs font-medium text-foreground">
          {row.label} · {row.chatTitle}
        </span>
        {row.text === null ? null : (
          <span className="line-clamp-2 text-xs text-muted-foreground">{row.text}</span>
        )}
        <span className="text-xs text-muted-foreground">{row.waitsFor}</span>
        {open
          ? props.detail.map((line) => (
              <span key={line} className="whitespace-pre-line text-xs text-foreground">
                {line}
              </span>
            ))
          : null}
      </button>
    </li>
  );
}
