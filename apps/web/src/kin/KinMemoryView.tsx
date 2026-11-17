import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_MEMORY_EMPTY,
  KIN_MEMORY_FORGET,
  KIN_MEMORY_FORGOTTEN,
  KIN_MEMORY_LOAD_FAILED,
  KIN_MEMORY_NO_EDITS,
  KIN_MEMORY_SEARCH_PLACEHOLDER,
  createKinMemoryActions,
  kinMemoryView,
  kinTeamMemoryView,
  type KinMemoryActions,
  type KinMemoryConfirmAll,
  type KinMemoryItemView,
  type KinMemoryOriginView,
  type KinMemoryRow,
  type KinTeamMemoryView,
  KIN_MEMORY_COPY,
} from "@t3tools/client-runtime/kin/kinMemoryScreen";
import type {
  EnvironmentId,
  KinMemoryItemId,
  KinMemoryListResult,
  KinOrgId,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { GlobeIcon, MessageSquareIcon, SparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { KinWorkSection } from "./KinWorkParts";

interface KinMemoryTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

/** What the owner's leads remember, and who may know each thing. */
export function KinMemoryView(props: KinMemoryTarget & { readonly find?: string }) {
  const allowed = useAtomValue(kinClient.memorySetVisibility.permissionAtom(props.environmentId));
  return (
    <>
      {allowed ? (
        <KinMemoryBody {...props} />
      ) : (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>{KIN_MEMORY_COPY.ownerOnly}</EmptyTitle>
            <EmptyDescription>{KIN_MEMORY_COPY.ownerOnlyDetail}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

function KinMemoryBody({
  environmentId,
  orgId,
  find,
}: KinMemoryTarget & { readonly find?: string }) {
  const listAtom = kinClient.memory({ environmentId, input: { orgId } });
  const result = useAtomValue(listAtom);
  const setVisibility = useAtomCommand(kinClient.memorySetVisibility, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.memoryConfirm, { reportFailure: false });
  const forget = useAtomCommand(kinClient.memoryForget, { reportFailure: false });
  const setTeamMemory = useAtomCommand(kinClient.memorySetTeamMemory, { reportFailure: false });
  const canSetTeamMemory = useAtomValue(
    kinClient.memorySetTeamMemory.permissionAtom(environmentId),
  );
  const [forgetting, setForgetting] = useState<KinMemoryItemView | null>(null);
  const [edits, setEdits] = useState(KIN_MEMORY_NO_EDITS);
  const [search, setSearch] = useState(find ?? "");
  // Whose words and which agent an item names; until these arrive a row says "a teammate" or "an agent".
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  const agents = useAtomValue(
    kinClient.leads({ environmentId, input: { orgId, includeRetired: true } }),
  );
  // Quotes read in full, kept here because the list recycles its rows.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [actions] = useState(() =>
    createKinMemoryActions({
      orgId,
      setVisibility: (input) => setVisibility({ environmentId, input }),
      confirmSuggestions: (input) => confirm({ environmentId, input }),
      forget: (input) => forget({ environmentId, input }),
      setTeamMemory: (input) => setTeamMemory({ environmentId, input }),
      update: setEdits,
      refresh: () => appAtomRegistry.refresh(listAtom),
    }),
  );
  // What was last read stays up while it is read again.
  const list = Option.getOrNull(AsyncResult.value(result));
  if (list === null) {
    return AsyncResult.isFailure(result) ? (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{KIN_MEMORY_LOAD_FAILED}</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={() => appAtomRegistry.refresh(listAtom)}>
          Retry
        </Button>
      </div>
    ) : (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4"
        role="status"
        aria-label={KIN_MEMORY_COPY.loading}
      >
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    );
  }
  const view = kinMemoryView(list, edits, search, {
    people: Option.getOrNull(AsyncResult.value(people))?.people ?? [],
    agents: Option.getOrNull(AsyncResult.value(agents))?.leads ?? [],
  });
  const team = kinTeamMemoryView(list, edits);
  const teamSwitch =
    team === null ? null : (
      <KinTeamMemorySwitch
        view={team}
        disabled={!canSetTeamMemory}
        onChange={(on) => void actions.setTeamMemory(list, on)}
      />
    );
  const forgotten = (
    <KinMemoryForgotten
      environmentId={environmentId}
      orgId={orgId}
      onRestored={() => appAtomRegistry.refresh(listAtom)}
    />
  );
  if (view.total === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        {teamSwitch === null && edits.problem === null ? null : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-2">
            {teamSwitch}
            {edits.problem === null ? null : (
              <Alert variant="error">
                <AlertDescription>{edits.problem}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>{KIN_MEMORY_EMPTY.title}</EmptyTitle>
            <EmptyDescription>{KIN_MEMORY_EMPTY.detail}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        {forgotten}
      </div>
    );
  }
  return (
    <>
      {/* The leads of a busy company remember hundreds of things; only the rows in view mount. */}
      <LegendList<KinMemoryRow>
        data={view.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        extraData={[view.confirmAll, opened]}
        recycleItems
        ListHeaderComponent={
          view.searchable || edits.problem !== null || teamSwitch !== null ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-2">
              {teamSwitch}
              {view.searchable ? (
                <Input
                  type="search"
                  aria-label={KIN_MEMORY_SEARCH_PLACEHOLDER}
                  placeholder={KIN_MEMORY_SEARCH_PLACEHOLDER}
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
              ) : null}
              {edits.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{edits.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          ) : null
        }
        ListEmptyComponent={
          <p
            role="status"
            className="mx-auto w-full max-w-3xl px-4 py-6 text-sm text-muted-foreground"
          >
            {view.noMatch}
          </p>
        }
        renderItem={({ item: row }) => (
          <div className="mx-auto w-full max-w-3xl px-4">
            {row.type === "section" ? (
              <KinMemorySection
                row={row}
                confirmAll={row.state === "suggested" ? view.confirmAll : null}
                onConfirmAll={(all) => void actions.confirmAll(list, all)}
              />
            ) : (
              <KinMemoryItem
                row={row}
                list={list}
                actions={actions}
                onForget={setForgetting}
                quoteOpen={opened.has(row.item.itemId)}
                onToggleQuote={() =>
                  setOpened((current) => {
                    const next = new Set(current);
                    if (!next.delete(row.item.itemId)) next.add(row.item.itemId);
                    return next;
                  })
                }
              />
            )}
          </div>
        )}
        ListFooterComponent={forgotten}
        estimatedItemSize={64}
        drawDistance={640}
        className="min-h-0 flex-1 overscroll-contain pb-6"
      />
      <AlertDialog
        open={forgetting !== null}
        onOpenChange={(open) => {
          if (!open) setForgetting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_MEMORY_FORGET.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {forgetting === null ? null : KIN_MEMORY_FORGET.body(forgetting.title)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (forgetting !== null) void actions.forget(list, forgetting.itemId);
                setForgetting(null);
              }}
            >
              {KIN_MEMORY_FORGET.action}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Whether agents use what the team can know in chats with teammates, said true either way. */
function KinTeamMemorySwitch(props: {
  readonly view: KinTeamMemoryView;
  readonly disabled: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{props.view.label}</Label>
        <p className="text-xs text-muted-foreground">{props.view.detail}</p>
      </div>
      <Switch
        id={id}
        checked={props.view.on}
        disabled={props.disabled || props.view.busy}
        onCheckedChange={props.onChange}
      />
    </div>
  );
}

/** What the owner forgot, one line that opens to the list with a way to bring each back. */
function KinMemoryForgotten(props: KinMemoryTarget & { readonly onRestored: () => void }) {
  const { environmentId, orgId } = props;
  const forgottenAtom = kinClient.memory({ environmentId, input: { orgId, forgotten: true } });
  const result = useAtomValue(forgottenAtom);
  const restore = useAtomCommand(kinClient.memoryRestore, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const items = Option.getOrNull(AsyncResult.value(result))?.items ?? null;
  if (items === null) return null;
  const bringBack = async (itemId: KinMemoryItemId) => {
    setBusy(itemId);
    setFailed(null);
    const outcome = await restore({ environmentId, input: { orgId, itemId } });
    setBusy(null);
    if (AsyncResult.isSuccess(outcome)) {
      appAtomRegistry.refresh(forgottenAtom);
      props.onRestored();
    } else
      setFailed(kinFailureText(squashAtomCommandFailure(outcome), KIN_MEMORY_FORGOTTEN.failed));
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6">
      <KinWorkSection
        title={KIN_MEMORY_FORGOTTEN.title}
        fold={{ summary: KIN_MEMORY_FORGOTTEN.count(items.length) }}
      >
        {failed ? (
          <Alert variant="error">
            <AlertDescription>{failed}</AlertDescription>
          </Alert>
        ) : null}
        <ul className="flex flex-col">
          {[...items].reverse().map((item) => (
            <li
              key={item.itemId}
              className="flex items-start gap-3 border-b border-border/60 py-2 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm text-foreground">{item.title}</span>
                {item.preview === undefined ? null : (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.preview}</span>
                )}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                aria-label={`${KIN_MEMORY_FORGOTTEN.restore} ${item.title}`}
                onClick={() => void bringBack(item.itemId)}
              >
                {KIN_MEMORY_FORGOTTEN.restore}
              </Button>
            </li>
          ))}
        </ul>
      </KinWorkSection>
    </div>
  );
}

function KinMemorySection(props: {
  readonly row: Extract<KinMemoryRow, { readonly type: "section" }>;
  readonly confirmAll: KinMemoryConfirmAll | null;
  readonly onConfirmAll: (all: KinMemoryConfirmAll) => void;
}) {
  const { row, confirmAll } = props;
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b pt-6 pb-2">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">
          {row.title} <span className="font-normal text-muted-foreground">{row.count}</span>
        </h2>
        <p className="text-xs text-muted-foreground">{row.hint}</p>
      </div>
      {confirmAll === null ? null : (
        <Button size="sm" onClick={() => props.onConfirmAll(confirmAll)}>
          {confirmAll.label}
        </Button>
      )}
    </div>
  );
}

function KinMemoryItem(props: {
  readonly row: Extract<KinMemoryRow, { readonly type: "item" }>;
  readonly list: KinMemoryListResult;
  readonly actions: KinMemoryActions;
  readonly onForget: (item: KinMemoryItemView) => void;
  readonly quoteOpen: boolean;
  readonly onToggleQuote: () => void;
}) {
  const { item } = props.row;
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">{item.title}</span>
        {item.preview === null ? null : (
          <span className="line-clamp-2 text-xs text-muted-foreground">{item.preview}</span>
        )}
        {item.from === null ? null : (
          <span className="text-xs text-muted-foreground">{item.from}</span>
        )}
        {item.origin === null ? null : (
          <KinMemoryOrigin
            origin={item.origin}
            open={props.quoteOpen}
            onToggle={props.onToggleQuote}
          />
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {item.actions.map((action) => (
          <Button
            key={action.to}
            size="xs"
            variant={action.to === "team" ? "outline" : "ghost"}
            disabled={item.busy}
            aria-label={action.accessibilityLabel}
            onClick={() => void props.actions.change(props.list, item.itemId, action.to)}
          >
            {action.label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={item.busy}
          aria-label={item.forget.accessibilityLabel}
          onClick={() => props.onForget(item)}
        >
          {item.forget.label}
        </Button>
      </div>
    </div>
  );
}

const ORIGIN_ICON = { said: MessageSquareIcon, worked_out: SparklesIcon, outside: GlobeIcon };

/** One quiet line: who said it or which agent worked it out, when, and the words if any. */
function KinMemoryOrigin(props: {
  readonly origin: KinMemoryOriginView;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const { origin, open } = props;
  const Icon = ORIGIN_ICON[origin.kind];
  if (origin.quote === null) {
    return (
      <span className="flex items-start gap-1.5 pt-0.5 text-xs text-muted-foreground">
        <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
        {origin.line}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={props.onToggle}
      className="flex cursor-pointer items-start gap-1.5 rounded-sm pt-0.5 text-start text-xs text-muted-foreground outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
    >
      <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className={open ? undefined : "line-clamp-2"}>
        {origin.line} <span className="text-foreground/80">“{origin.quote}”</span>
      </span>
    </button>
  );
}
