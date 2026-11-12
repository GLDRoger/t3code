import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WORK_STALE,
  kinWorkDraftFor,
  type KinWorkDraft,
  type KinWorkRef,
  type KinWorkRowView,
} from "@t3tools/client-runtime/kin/kinWork";
import { kinWorkApplied, type KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_CLIENTS,
  KIN_CLIENT_FAILED,
  KIN_CLIENT_GONE,
  KIN_PROJECTS,
  kinClientPageView,
  kinClientRow,
  kinClientsNothing,
  kinWorkTimeline,
  type KinClientRowView,
  type KinContactView,
  type KinOwedView,
  type KinProjectRowView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KIN_WORK_FORM_COPY,
  kinWorkSend,
  type KinWorkFormProblem,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinContact, KinPartyPage, KinRecord, KinRecordKey } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { EllipsisIcon, MailIcon, PencilIcon, PhoneIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { KinDocsUnder } from "./KinDocsList";
import { KinClientDialog, KinContactDialog, KinProjectDialog } from "./KinWorkForms";
import { KinWorkPlaceLists } from "./KinWorkPlaceLists";
import {
  KinWorkHealthBadge,
  KinWorkNotice,
  KinWorkPrivateMark,
  KinWorkProblem,
  KinWorkRowSkeletons,
  KinWorkSection,
  KinWorkTimeline,
} from "./KinWorkParts";
import { KinWorkRow } from "./KinWorkTasks";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { kinHostConnected } from "./useKinHost";
import {
  useKinClientPage,
  useKinClientsList,
  useKinWorkHistory,
  type KinWorkChangesHandle,
  type KinWorkChoices,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

/** Everyone the company owes something to or is owed by, with what matters at a glance. */
export function KinWorkClientsList(
  props: KinWorkTarget & {
    readonly live: KinWorkLive;
    readonly stale: boolean;
    readonly directory: KinWorkDirectory;
    readonly onOpen: (key: KinRecordKey) => void;
    readonly onAdd: (() => void) | null;
  },
) {
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const { state, list } = useKinClientsList(props, props.stale ? null : props.live.seq);
  const { filter } = state;
  const rows = state.records.map((row) => kinClientRow(row, names, now));
  const nothing = kinClientsNothing(filter);
  return (
    <LegendList<KinClientRowView>
      data={rows}
      keyExtractor={(row) => row.key}
      extraData={state}
      recycleItems
      onEndReached={() => void list.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-1">
          {props.stale || state.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <ToggleGroup
              variant="pill"
              size="sm"
              aria-label="Show"
              value={[filter.closed ? "closed" : "active"]}
              onValueChange={(value) => {
                if (value[0] !== undefined)
                  list.setFilter({ ...filter, closed: value[0] === "closed" });
              }}
            >
              <Toggle value="active">Active</Toggle>
              <Toggle value="closed">{KIN_CLIENTS.closed}</Toggle>
            </ToggleGroup>
            <div className="min-w-0 flex-1">
              <Input
                type="search"
                aria-label={KIN_CLIENTS.search}
                placeholder={KIN_CLIENTS.search}
                value={filter.text}
                onChange={(event) => list.setFilter({ ...filter, text: event.currentTarget.value })}
              />
            </div>
          </div>
        </div>
      }
      ListEmptyComponent={
        <div className="mx-auto w-full max-w-3xl px-4">
          {state.loading ? (
            <div role="status" aria-label="Loading clients">
              <KinWorkRowSkeletons />
            </div>
          ) : state.failed !== null ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <Alert variant="error">
                <AlertDescription>
                  {KIN_CLIENTS.loadFailed}. Check your connection.
                </AlertDescription>
              </Alert>
              <Button size="sm" variant="outline" onClick={list.refresh}>
                Retry
              </Button>
            </div>
          ) : (
            <KinWorkNotice
              title={nothing.title}
              detail={nothing.detail}
              {...(nothing.offerNew && props.onAdd !== null
                ? {
                    action: (
                      <Button onClick={props.onAdd}>
                        <PlusIcon />
                        {KIN_CLIENTS.add}
                      </Button>
                    ),
                  }
                : {})}
            />
          )}
        </div>
      }
      ListFooterComponent={
        !state.more ? null : (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3">
            <p className="text-xs text-muted-foreground" role="status">
              {state.moreFailed
                ? "Couldn't load more."
                : `Showing ${rows.length} of ${state.total ?? rows.length}`}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={state.loadingMore}
              aria-busy={state.loadingMore}
              onClick={() => void list.loadMore()}
            >
              {state.moreFailed ? "Try again" : "Show more"}
            </Button>
          </div>
        )
      }
      renderItem={({ item: row }) => (
        <div className="mx-auto w-full max-w-3xl border-b border-border/60 px-4 py-1">
          <button
            type="button"
            aria-label={row.accessibilityLabel}
            onClick={() => props.onOpen(row.key)}
            className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm text-foreground">{row.name}</span>
                {row.private ? <KinWorkPrivateMark /> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">{row.line}</span>
              {row.next === null ? null : (
                <span className="truncate text-xs text-muted-foreground">{row.next}</span>
              )}
            </span>
            {row.late ? (
              <Badge size="sm" variant="error">
                Late
              </Badge>
            ) : null}
          </button>
        </div>
      )}
      estimatedItemSize={64}
      drawDistance={640}
      className={cn("min-h-0 flex-1 overscroll-contain pb-6", state.refreshing && "opacity-70")}
    />
  );
}

/** A project as a row that opens it, on a client's page and in the projects list. */
export function KinWorkProjectRow(props: {
  readonly row: KinProjectRowView;
  readonly onOpen: () => void;
}) {
  const { row } = props;
  return (
    <button
      type="button"
      aria-label={row.accessibilityLabel}
      onClick={props.onOpen}
      className="flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-foreground">{row.name}</span>
          {row.private ? <KinWorkPrivateMark /> : null}
        </span>
        {row.line === "" ? null : (
          <span className="truncate text-xs text-muted-foreground">{row.line}</span>
        )}
      </span>
      {row.health === null ? null : <KinWorkHealthBadge health={row.health} />}
    </button>
  );
}

type ClientDialog =
  | { readonly type: "edit" }
  | { readonly type: "contact"; readonly key: KinRecordKey | null }
  | { readonly type: "project" }
  | null;

/** One client: what is owed each way, who to reach, its projects, terms, notes and history. */
export function KinWorkClientPage(
  props: KinWorkTarget & {
    readonly clientKey: KinRecordKey;
    readonly directory: KinWorkDirectory;
    readonly changes: KinWorkChangesHandle;
    readonly choices: KinWorkChoices;
    readonly canChangeTasks: boolean;
    readonly onOpenTask: (key: KinRecordKey) => void;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
    readonly onOpenDoc: (key: KinRecordKey) => void;
    /** Opens the task list narrowed to this client. */
    readonly onSeeAll: (party: KinWorkRef) => void;
    /** Opens the new-task form already about this client; null where tasks can't be added. */
    readonly onAddTask: ((draft: KinWorkDraft) => void) | null;
    /** Opens one of the lists agents set up, narrowed to this client. */
    readonly onOpenList: (open: KinListOpen) => void;
  },
) {
  const { state, refresh } = useKinClientPage(props, props.clientKey);
  if (state._tag === "loading")
    return (
      <div className="mx-auto w-full max-w-3xl p-4" role="status" aria-label="Loading client">
        <KinWorkRowSkeletons />
      </div>
    );
  if (state._tag === "gone") return <KinWorkNotice {...KIN_CLIENT_GONE} />;
  if (state._tag === "refused" || state._tag === "failed")
    return (
      <KinWorkNotice
        {...KIN_CLIENT_FAILED}
        action={
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        }
      />
    );
  return <ClientPage {...props} page={state.value} stale={state.stale} onRefresh={refresh} />;
}

function ClientPage(
  props: Parameters<typeof KinWorkClientPage>[0] & {
    readonly page: KinPartyPage;
    readonly stale: boolean;
    readonly onRefresh: () => void;
  },
) {
  const { environmentId, orgId, page } = props;
  const { names } = props.directory;
  const { state: changed, changes } = props.changes;
  const canChange = useAtomValue(kinClient.workClientUpdate.permissionAtom(environmentId));
  const update = useAtomCommand(kinClient.workClientUpdate, { reportFailure: false });
  const now = new Date(useNowMinuteMs());
  const [dialog, setDialog] = useState<ClientDialog>(null);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useKinWorkHistory(props, props.clientKey, page.seq);
  const privateId = useId();

  const applied = (records: ReadonlyArray<KinRecord>) =>
    records.map((record) => kinWorkApplied(record, changed));
  const view = kinClientPageView(
    {
      ...page,
      weOwe: { ...page.weOwe, records: applied(page.weOwe.records) },
      theyOwe: { ...page.theyOwe, records: applied(page.theyOwe.records) },
    },
    names,
    now,
  );
  const act = (key: KinRecordKey, action: KinWorkAction) => {
    const record = [...page.weOwe.records, ...page.theyOwe.records].find(
      (held) => held.key === key,
    );
    if (record !== undefined) void changes.run(kinWorkApplied(record, changed), action, names);
  };
  const change = async (input: { readonly active?: boolean; readonly sensitive?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        update({ environmentId, input: { orgId, key: view.key, rev: view.rev, ...input } }),
      noun: "client",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onRefresh();
    else {
      setProblem(outcome.problem);
      if (outcome.problem.kind === "conflict") props.onRefresh();
    }
  };
  const editingContact: KinContact | null =
    dialog?.type === "contact" && dialog.key !== null
      ? (page.contacts.find((contact) => contact.key === dialog.key) ?? null)
      : null;
  const owed = (title: string, side: KinOwedView, empty: string, add: React.ReactNode) => (
    <KinWorkSection title={side.total === 0 ? title : `${title} · ${side.total}`} action={add}>
      {side.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {side.rows.map((row: KinWorkRowView) => (
            <li key={row.key} className="border-b border-border/60 last:border-b-0">
              <KinWorkRow
                row={row}
                saving={changed.pending[row.key] !== undefined}
                onOpen={() => props.onOpenTask(row.key)}
                onAct={props.canChangeTasks ? (action) => act(row.key, action) : null}
              />
            </li>
          ))}
        </ul>
      )}
      {side.more === null ? null : (
        <div>
          <Button size="xs" variant="ghost" onClick={() => props.onSeeAll(view.ref)}>
            {side.more}
          </Button>
        </div>
      )}
    </KinWorkSection>
  );
  const addTask = (side: "ours" | "theirs", label: string) =>
    props.onAddTask === null || view.closed ? undefined : (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => props.onAddTask?.(kinWorkDraftFor({ party: view.ref, side }))}
      >
        <PlusIcon />
        {label}
      </Button>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-3 pb-8">
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-lg font-medium text-foreground">{view.name}</h2>
                {view.privacy.private ? <KinWorkPrivateMark /> : null}
              </div>
              <p className="text-sm text-muted-foreground">{view.line}</p>
            </div>
            {canChange ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDialog({ type: "edit" })}
                >
                  <PencilIcon />
                  {KIN_CLIENTS.edit}
                </Button>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="icon-sm" variant="ghost" aria-label="More" disabled={busy} />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => void change({ active: view.closed })}>
                      {view.closed ? KIN_CLIENTS.reopen : KIN_CLIENTS.close}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            ) : null}
          </div>
          {props.stale ? (
            <p role="status" className="text-xs text-muted-foreground">
              {KIN_WORK_STALE}
            </p>
          ) : null}
          {problem === null ? null : (
            <KinWorkProblem problem={problem} onOpenExisting={props.onOpenClient} />
          )}
        </div>
        {owed(
          KIN_CLIENTS.weOwe,
          view.weOwe,
          KIN_CLIENTS.nothingOwed,
          addTask("ours", KIN_CLIENTS.addWeOwe),
        )}
        {owed(
          KIN_CLIENTS.theyOwe,
          view.theyOwe,
          KIN_CLIENTS.nothingOwing,
          addTask("theirs", KIN_CLIENTS.addTheyOwe),
        )}
        <KinWorkPlaceLists
          environmentId={environmentId}
          orgId={orgId}
          place={{ party: { key: view.key, title: view.name } }}
          seq={props.stale ? null : page.seq}
          directory={props.directory}
          onOpenList={props.onOpenList}
          onOpenKey={props.onOpenTask}
        />
        <KinWorkSection
          title={KIN_CLIENTS.projects}
          action={
            canChange && !view.closed ? (
              <Button size="xs" variant="ghost" onClick={() => setDialog({ type: "project" })}>
                <PlusIcon />
                {KIN_PROJECTS.add}
              </Button>
            ) : undefined
          }
        >
          {view.projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noProjects}</p>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {view.projects.map((row) => (
                <li key={row.key}>
                  <KinWorkProjectRow row={row} onOpen={() => props.onOpenProject(row.key)} />
                </li>
              ))}
            </ul>
          )}
        </KinWorkSection>
        <KinDocsUnder
          environmentId={props.environmentId}
          orgId={props.orgId}
          directory={props.directory}
          under={{ party: props.clientKey }}
          onOpen={props.onOpenDoc}
        />
        <KinWorkSection
          title={KIN_CLIENTS.contacts}
          action={
            canChange ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setDialog({ type: "contact", key: null })}
              >
                <PlusIcon />
                {KIN_CLIENTS.addContact}
              </Button>
            ) : undefined
          }
        >
          {view.contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noContacts}</p>
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {view.contacts.map((contact) => (
                  <li key={contact.key}>
                    <ContactRow
                      contact={contact}
                      onEdit={
                        canChange ? () => setDialog({ type: "contact", key: contact.key }) : null
                      }
                    />
                  </li>
                ))}
              </ul>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <KinWorkPrivateMark />
                {KIN_CLIENTS.detailsPrivate}
              </p>
            </>
          )}
        </KinWorkSection>
        <KinWorkSection title={KIN_CLIENTS.terms} action={<KinWorkPrivateMark />}>
          {view.terms === null ? (
            <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noTerms}</p>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-foreground">{view.terms}</p>
          )}
          <p className="text-xs text-muted-foreground">{KIN_CLIENTS.termsPrivate}</p>
        </KinWorkSection>
        <KinWorkSection title={KIN_CLIENTS.notes}>
          {view.notes === null ? (
            <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noNotes}</p>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-foreground">{view.notes}</p>
          )}
        </KinWorkSection>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor={privateId}>{KIN_CLIENTS.privateLabel}</Label>
            <p className="text-xs text-muted-foreground">{view.privacy.note}</p>
          </div>
          <Switch
            id={privateId}
            checked={view.privacy.private}
            disabled={!canChange || busy}
            onCheckedChange={(checked) => void change({ sensitive: checked })}
          />
        </div>
        <KinWorkSection title={KIN_CLIENTS.history}>
          {history.state.loading ? (
            <div role="status" aria-label="Loading history">
              <KinWorkRowSkeletons />
            </div>
          ) : history.state.failed !== null ? (
            <div>
              <Button size="xs" variant="outline" onClick={history.list.refresh}>
                Retry
              </Button>
            </div>
          ) : history.state.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_CLIENTS.noHistory}</p>
          ) : (
            <KinWorkTimeline
              lines={kinWorkTimeline(history.state.records, names, now, view.key)}
              onOpenTask={props.onOpenTask}
            />
          )}
          {history.state.more ? (
            <div>
              <Button
                size="xs"
                variant="outline"
                disabled={history.state.loadingMore}
                aria-busy={history.state.loadingMore}
                onClick={() => void history.list.loadMore()}
              >
                {history.state.moreFailed ? "Try again" : KIN_CLIENTS.earlier}
              </Button>
            </div>
          ) : null}
        </KinWorkSection>
      </div>
      {dialog?.type === "edit" ? (
        <KinClientDialog
          environmentId={environmentId}
          orgId={orgId}
          editing={page.party}
          onSaved={() => {
            setDialog(null);
            props.onRefresh();
          }}
          onOpenExisting={(key) => {
            setDialog(null);
            props.onOpenClient(key);
          }}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.type === "contact" ? (
        <KinContactDialog
          environmentId={environmentId}
          orgId={orgId}
          party={view.ref}
          editing={editingContact}
          onSaved={() => {
            setDialog(null);
            props.onRefresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.type === "project" ? (
        <KinProjectDialog
          environmentId={environmentId}
          orgId={orgId}
          editing={null}
          party={view.ref}
          choices={props.choices}
          onSaved={(key) => {
            setDialog(null);
            props.onOpenProject(key);
          }}
          onOpenExisting={(key) => {
            setDialog(null);
            props.onOpenProject(key);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

const DETAIL_LINK =
  "inline-flex min-w-0 items-center gap-1.5 rounded-sm text-sm text-foreground underline-offset-2 outline-none ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset";

/** Someone to reach: a tap on the email or the number hands it to the device's own app. */
function ContactRow(props: {
  readonly contact: KinContactView;
  readonly onEdit: (() => void) | null;
}) {
  const { contact } = props;
  const detail = (
    Icon: typeof MailIcon,
    value: KinContactView["email"],
    label: string,
  ): React.ReactNode =>
    value === null ? null : value.href === null ? (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{value.text}</span>
      </span>
    ) : (
      <a href={value.href} aria-label={`${label} ${contact.name}`} className={DETAIL_LINK}>
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{value.text}</span>
      </a>
    );
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm text-foreground">
          {contact.name}
          {contact.role === null ? null : (
            <span className="text-muted-foreground"> · {contact.role}</span>
          )}
          {contact.closed ? (
            <span className="text-muted-foreground"> · No longer a contact</span>
          ) : null}
        </p>
        {contact.email === null && contact.phone === null ? null : (
          <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
            {detail(MailIcon, contact.email, "Email")}
            {detail(PhoneIcon, contact.phone, "Call")}
          </div>
        )}
        {contact.notes === null ? null : (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{contact.notes}</p>
        )}
      </div>
      {props.onEdit === null ? null : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${KIN_WORK_FORM_COPY.contact.editTitle}: ${contact.name}`}
          onClick={props.onEdit}
        >
          <PencilIcon />
        </Button>
      )}
    </div>
  );
}
