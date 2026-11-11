import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_ASSIGN,
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  createKinWorkActions,
  kinWorkAssignees,
  kinWorkItemState,
  kinWorkItemView,
  type KinWorkAssignee,
  type KinWorkItemView,
  type KinWorkLinkView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_RECORD_CHANGES_CAP,
  type KinRecordDetail,
  type KinRecordKey,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  ExternalLinkIcon,
  LinkIcon,
  ListChecksIcon,
  MessageSquareIcon,
  NotebookTextIcon,
  PlayIcon,
} from "lucide-react";
import { useState } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../components/ui/menu";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinWorkStateIcon } from "./KinWorkStateIcon";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const LINK_ICON: Record<KinWorkLinkView["kind"], typeof LinkIcon> = {
  pull_request: PullRequestGlyph.pullRequest,
  worker: PlayIcon,
  message: MessageSquareIcon,
  task: ListChecksIcon,
  note: NotebookTextIcon,
  link: LinkIcon,
};

/** One task beside the list: where it stands, who has it, what it links to and how it got here. */
export function KinWorkItemSheet(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly directory: KinWorkDirectory;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, itemKey } = props;
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const result = useAtomValue(itemAtom);
  const [given, setGiven] = useState<KinRecordDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canGive = useAtomValue(kinClient.workAssign.permissionAtom(environmentId));
  const create = useAtomCommand(kinClient.workCreate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const [actions] = useState(() =>
    createKinWorkActions({
      orgId,
      create: (input) => create({ environmentId, input }),
      assign: (input) => assign({ environmentId, input }),
      reread: () => appAtomRegistry.refresh(itemAtom),
    }),
  );
  const now = new Date(useNowMinuteMs());
  const state = kinWorkItemState(result, given);

  const give = async (item: KinRecordDetail, to: KinWorkAssignee) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await actions.give(item, to.principal);
    setBusy(false);
    if (outcome.ok) setGiven(outcome.item);
    else setProblem(outcome.problem);
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <SheetPopup side="right">
        {state._tag === "ready" ? (
          <KinWorkItem
            {...props}
            item={state.item}
            view={kinWorkItemView(state.item, props.directory.names, now, KIN_RECORD_CHANGES_CAP)}
            busy={busy}
            problem={problem}
            onGive={canGive ? (to) => void give(state.item, to) : null}
          />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>
                {state._tag === "gone"
                  ? KIN_WORK_GONE.title
                  : state._tag === "failed"
                    ? KIN_WORK_ITEM_FAILED.title
                    : itemKey}
              </SheetTitle>
              <SheetDescription>
                {state._tag === "gone"
                  ? KIN_WORK_GONE.detail
                  : state._tag === "failed"
                    ? KIN_WORK_ITEM_FAILED.detail
                    : "Loading…"}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col items-start gap-3 px-6 pb-6">
              {state._tag === "loading" ? (
                <div className="flex w-full flex-col gap-2" role="status" aria-label="Loading task">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-3.5 w-2/5" />
                </div>
              ) : state._tag === "failed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => appAtomRegistry.refresh(itemAtom)}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          </>
        )}
      </SheetPopup>
    </Sheet>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function KinWorkItem(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    readonly view: KinWorkItemView;
    readonly directory: KinWorkDirectory;
    readonly busy: boolean;
    readonly problem: string | null;
    readonly onGive: ((to: KinWorkAssignee) => void) | null;
    readonly onClose: () => void;
  },
) {
  const { view, environmentId, orgId } = props;
  const { orgs, people, names } = props.directory;
  const assignees = kinWorkAssignees({
    orgs,
    orgId,
    people,
    names,
    current: view.owner.principal,
  });
  return (
    <>
      <SheetHeader>
        <div className="flex flex-col gap-1 pe-8">
          <SheetDescription>{view.heading}</SheetDescription>
          <SheetTitle>{view.title}</SheetTitle>
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <KinWorkStateIcon state={view.state} />
            <span>{view.status}</span>
            {view.late ? (
              <Badge size="sm" variant="error">
                Late
              </Badge>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">With</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <KinAvatar avatar={view.owner.avatar} size="sm" />
              <span className="truncate text-foreground">{view.owner.name}</span>
            </dd>
            <dt className="text-muted-foreground">Due</dt>
            <dd className="text-foreground first-letter:uppercase">{view.due ?? "No date"}</dd>
          </dl>
          {view.given === null ? null : (
            <p className="text-xs text-muted-foreground">{view.given}</p>
          )}
          {view.remarks.map((remark) => (
            <p key={remark} className="text-xs text-muted-foreground">
              {remark}
            </p>
          ))}
        </div>
        {props.problem === null ? null : (
          <Alert variant="error">
            <AlertDescription>{props.problem}</AlertDescription>
          </Alert>
        )}
        {props.onGive === null && view.owner.principal._tag !== "agent" ? null : (
          <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
              {props.onGive === null || view.assignLabel === null ? null : (
                <GiveMenu
                  label={view.assignLabel}
                  assignees={assignees}
                  busy={props.busy}
                  onGive={props.onGive}
                />
              )}
              {view.owner.principal._tag === "agent" ? (
                <KinWorkLeadChat
                  environmentId={environmentId}
                  orgId={orgId}
                  agentId={view.owner.principal.agentId}
                  name={view.owner.name}
                  onOpen={props.onClose}
                />
              ) : null}
            </div>
            {props.onGive === null || view.assignLabel === null ? null : (
              <p className="text-xs text-muted-foreground">{KIN_WORK_ASSIGN.leadsHint}</p>
            )}
          </div>
        )}
        {view.notes === null ? null : (
          <Section title="Notes">
            <p className="whitespace-pre-wrap text-sm text-foreground">{view.notes}</p>
          </Section>
        )}
        {view.links.length === 0 ? null : (
          <Section title="Links">
            <ul className="flex flex-col">
              {view.links.map((link) => (
                <li key={link.key}>
                  <KinWorkLink
                    link={link}
                    environmentId={environmentId}
                    orgId={orgId}
                    onOpen={props.onClose}
                  />
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="History">
          <ol className="flex flex-col gap-1.5">
            {view.history.map((line) => (
              <li key={line.key} className="flex gap-3 text-sm">
                <span className="w-14 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
                  {line.when}
                </span>
                <span className="min-w-0 flex-1 text-foreground">{line.text}</span>
              </li>
            ))}
          </ol>
          {view.historyNote === null ? null : (
            <p className="text-xs text-muted-foreground">{view.historyNote}</p>
          )}
        </Section>
      </div>
    </>
  );
}

function GiveMenu(props: {
  readonly label: string;
  readonly assignees: ReturnType<typeof kinWorkAssignees>;
  readonly busy: boolean;
  readonly onGive: (to: KinWorkAssignee) => void;
}) {
  const { assignees } = props;
  const group = (title: string, rows: ReadonlyArray<KinWorkAssignee>) =>
    rows.length === 0 ? null : (
      <MenuGroup>
        <MenuGroupLabel>{title}</MenuGroupLabel>
        {rows.map((row) => (
          <MenuItem key={row.key} disabled={row.current} onClick={() => props.onGive(row)}>
            <KinAvatar avatar={row.avatar} size="xs" />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            {row.current ? <span className="text-xs text-muted-foreground">Has it</span> : null}
          </MenuItem>
        ))}
      </MenuGroup>
    );
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="outline" disabled={props.busy} aria-busy={props.busy} />}
      >
        {props.label}
      </MenuTrigger>
      <MenuPopup align="start">
        {group(KIN_WORK_ASSIGN.leads, assignees.leads)}
        {group(KIN_WORK_ASSIGN.people, assignees.people)}
      </MenuPopup>
    </Menu>
  );
}

/** The owner's chat with the lead that has the task, which is where it reports back. */
function KinWorkLeadChat(
  props: KinWorkTarget & {
    readonly agentId: string;
    readonly name: string;
    readonly onOpen: () => void;
  },
) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const lead = Option.getOrNull(AsyncResult.value(result))?.leads.find(
    (held) => held.agentId === props.agentId,
  );
  if (lead === undefined) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={props.onOpen}
      render={
        <Link
          to="/kin/$environmentId/$orgId/$chatId"
          params={{ environmentId, orgId, chatId: lead.ownerChatId }}
        />
      }
    >
      <MessageSquareIcon />
      Chat with {props.name}
    </Button>
  );
}

const LINK_ROW =
  "flex min-h-9 w-full items-center gap-3 rounded-md px-1 py-1.5 text-start text-sm outline-none ring-ring";
const LINK_ROW_OPENS = "hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

function KinWorkLink(
  props: KinWorkTarget & { readonly link: KinWorkLinkView; readonly onOpen: () => void },
) {
  const { link } = props;
  const Icon = LINK_ICON[link.kind];
  const content = (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{link.label}</span>
      {link.detail === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{link.detail}</span>
      )}
    </>
  );
  if (link.open === null) return <div className={LINK_ROW}>{content}</div>;
  if (link.open.type === "chat") {
    return (
      <Link
        to="/kin/$environmentId/$orgId/$chatId"
        params={{
          environmentId: props.environmentId,
          orgId: props.orgId,
          chatId: link.open.chatId,
        }}
        onClick={props.onOpen}
        className={`${LINK_ROW} ${LINK_ROW_OPENS}`}
      >
        {content}
      </Link>
    );
  }
  return (
    <a
      href={link.open.href}
      target="_blank"
      rel="noreferrer"
      className={`${LINK_ROW} ${LINK_ROW_OPENS}`}
    >
      {content}
      <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}
