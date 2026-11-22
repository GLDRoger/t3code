import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_MEMORY_FORGET,
  KIN_MEMORY_FORGOTTEN,
  KIN_MEMORY_LOAD_FAILED,
  KIN_MEMORY_NO_EDITS,
  KIN_MEMORY_SEARCH_PLACEHOLDER,
  KIN_MEMORY_SETTINGS,
  createKinMemoryActions,
  kinMemoryView,
  kinTeamMemoryView,
  type KinMemoryItemView,
  type KinMemoryOriginView,
  type KinMemoryRow,
  KIN_MEMORY_COPY,
} from "@t3tools/client-runtime/kin/kinMemoryScreen";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import type { EnvironmentId, KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { GlobeIcon, MessageSquareIcon, BrainIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import { KinGateView } from "./KinWorkParts";
import { KinSettingsFormDialog } from "./settings/KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsShowAll,
} from "./settings/KinSettingsLayout";
import { useKinGate } from "./useKinHost";

interface KinMemoryTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

/** A section shows this many before "Show all": a busy company's agents remember hundreds. */
const SHOWN = 40;

/** What the owner's leads remember, and who may know each thing. */
export function KinMemoryView(props: KinMemoryTarget & { readonly find?: string }) {
  const gate = useKinGate(
    kinClient.memorySetVisibility.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  return gate === null ? (
    <KinMemoryBody {...props} />
  ) : (
    <KinGateView
      gate={gate}
      refused={{ title: KIN_MEMORY_COPY.ownerOnly, detail: KIN_MEMORY_COPY.ownerOnlyDetail }}
      label="Memory"
    />
  );
}

type Group = {
  readonly row: Extract<KinMemoryRow, { readonly type: "section" }>;
  readonly items: Array<KinMemoryItemView>;
};

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
  const [opened, setOpened] = useState<KinMemoryItemId | null>(null);
  const [forgetting, setForgetting] = useState<KinMemoryItemView | null>(null);
  const [edits, setEdits] = useState(KIN_MEMORY_NO_EDITS);
  const [search, setSearch] = useState(find ?? "");
  // The sections whose every memory is shown, by key.
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  // Which change the shared problem line belongs under.
  const [changed, setChanged] = useState<"team" | "items">("items");
  // Whose words and which agent an item names; until these arrive a row says "a teammate" or "an agent".
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  const agents = useAtomValue(
    kinClient.leads({ environmentId, input: { orgId, includeRetired: true } }),
  );
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
  if (list === null)
    return (
      <KinSettingsPage purpose={KIN_MEMORY_SETTINGS.purpose}>
        <KinSettingsSection title={KIN_MEMORY_SETTINGS.remembered}>
          {AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={() => appAtomRegistry.refresh(listAtom)}>
              {KIN_MEMORY_LOAD_FAILED}
            </KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={4} />
          )}
        </KinSettingsSection>
      </KinSettingsPage>
    );
  const view = kinMemoryView(list, edits, search, {
    people: Option.getOrNull(AsyncResult.value(people))?.people ?? [],
    agents: Option.getOrNull(AsyncResult.value(agents))?.leads ?? [],
  });
  const team = kinTeamMemoryView(list, edits);
  const groups: Array<Group> = [];
  for (const row of view.rows) {
    if (row.type === "section") groups.push({ row, items: [] });
    else groups.at(-1)?.items.push(row.item);
  }
  const open = groups.flatMap((group) => group.items).find((item) => item.itemId === opened);
  const itemsProblem = changed === "items" ? edits.problem : null;
  return (
    <KinSettingsPage purpose={KIN_MEMORY_SETTINGS.purpose}>
      {team === null ? null : (
        <KinSettingsSection problem={changed === "team" ? edits.problem : null}>
          <KinSettingsRow
            title={KIN_MEMORY_SETTINGS.teamRow}
            detail={team.detail}
            wrap
            control={
              <Switch
                aria-label={KIN_MEMORY_SETTINGS.teamRow}
                checked={team.on}
                disabled={!canSetTeamMemory || team.busy}
                onCheckedChange={(on) => {
                  setChanged("team");
                  void actions.setTeamMemory(list, on);
                }}
              />
            }
          />
        </KinSettingsSection>
      )}
      {view.searchable ? (
        <Input
          type="search"
          aria-label={KIN_MEMORY_SEARCH_PLACEHOLDER}
          placeholder={KIN_MEMORY_SEARCH_PLACEHOLDER}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      ) : null}
      {groups.length === 0 ? (
        <KinSettingsSection title={KIN_MEMORY_SETTINGS.remembered} problem={itemsProblem}>
          <KinSettingsEmpty>{view.noMatch ?? KIN_MEMORY_SETTINGS.empty}</KinSettingsEmpty>
        </KinSettingsSection>
      ) : (
        groups.map((group, index) => (
          <KinSettingsSection
            key={group.row.key}
            title={group.row.title}
            description={group.row.hint}
            problem={index === 0 ? itemsProblem : null}
            action={
              group.row.state === "suggested" && view.confirmAll !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    if (view.confirmAll === null) return;
                    setChanged("items");
                    void actions.confirmAll(list, view.confirmAll);
                  }}
                >
                  {view.confirmAll.label}
                </Button>
              ) : undefined
            }
          >
            {(showAll.has(group.row.key) ? group.items : group.items.slice(0, SHOWN)).map(
              (item) => (
                <KinSettingsRow
                  key={item.itemId}
                  title={item.title}
                  detail={item.preview ?? item.from ?? item.origin?.line}
                  openLabel={`${KIN_MEMORY_SETTINGS.open}: ${item.title}`}
                  onOpen={() => setOpened(item.itemId)}
                />
              ),
            )}
            {showAll.has(group.row.key) || group.items.length <= SHOWN ? null : (
              <KinSettingsShowAll
                label={KIN_SETTINGS_COPY.showAll(group.items.length)}
                onShow={() => setShowAll(new Set(showAll).add(group.row.key))}
              />
            )}
          </KinSettingsSection>
        ))
      )}
      <KinMemoryForgotten
        environmentId={environmentId}
        orgId={orgId}
        onRestored={() => appAtomRegistry.refresh(listAtom)}
      />
      {open === undefined ? null : (
        <KinMemoryItemDialog
          environmentId={environmentId}
          orgId={orgId}
          item={open}
          hint={KIN_MEMORY_SETTINGS.whoKnows(open.state, team?.on === false)}
          onChange={(to) => {
            setChanged("items");
            setOpened(null);
            void actions.change(list, open.itemId, to);
          }}
          onForget={() => setForgetting(open)}
          onClose={() => setOpened(null)}
        />
      )}
      <KinConfirm
        ask={
          forgetting === null
            ? null
            : {
                title: KIN_MEMORY_FORGET.title,
                detail: KIN_MEMORY_FORGET.body(forgetting.title),
                action: KIN_MEMORY_FORGET.action,
                destructive: true,
              }
        }
        onConfirm={() => {
          if (forgetting === null) return;
          setChanged("items");
          setOpened(null);
          void actions.forget(list, forgetting.itemId);
        }}
        onClose={() => setForgetting(null)}
      />
    </KinSettingsPage>
  );
}

/**
 * One memory in full: its words, where it came from, and who may know it. The first way it can
 * go is the button; the other sits beside Cancel, and Forget asks first.
 */
function KinMemoryItemDialog(
  props: KinMemoryTarget & {
    readonly item: KinMemoryItemView;
    readonly hint: string;
    readonly onChange: (to: "team" | "only_owner") => void;
    readonly onForget: () => void;
    readonly onClose: () => void;
  },
) {
  const { item } = props;
  const [first, second] = item.actions;
  return (
    <KinSettingsFormDialog
      title={item.title}
      description={props.hint}
      submitLabel={first?.label ?? ""}
      busy={item.busy}
      remove={
        <Button type="button" variant="ghost-destructive" onClick={props.onForget}>
          {item.forget.label}
        </Button>
      }
      secondary={
        second === undefined ? undefined : (
          <Button type="button" variant="outline" onClick={() => props.onChange(second.to)}>
            {second.label}
          </Button>
        )
      }
      onSubmit={() => {
        if (first !== undefined) props.onChange(first.to);
      }}
      onClose={props.onClose}
    >
      {item.preview === null ? null : (
        <p className="whitespace-pre-wrap text-pretty text-sm text-foreground">{item.preview}</p>
      )}
      {item.from === null ? null : <p className="text-xs text-muted-foreground">{item.from}</p>}
      {item.origin === null ? null : (
        <KinMemoryOrigin
          environmentId={props.environmentId}
          orgId={props.orgId}
          origin={item.origin}
        />
      )}
    </KinSettingsFormDialog>
  );
}

/** What the owner forgot, with a way to bring each back; nothing at all when there is none. */
function KinMemoryForgotten(props: KinMemoryTarget & { readonly onRestored: () => void }) {
  const { environmentId, orgId } = props;
  const forgottenAtom = kinClient.memory({ environmentId, input: { orgId, forgotten: true } });
  const result = useAtomValue(forgottenAtom);
  const restore = useAtomCommand(kinClient.memoryRestore, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const items = Option.getOrNull(AsyncResult.value(result))?.items ?? null;
  if (items === null || items.length === 0) return null;
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
    <KinSettingsSection title={KIN_MEMORY_FORGOTTEN.title} problem={failed}>
      {[...items]
        .reverse()
        .slice(0, all ? undefined : SHOWN)
        .map((item) => (
          <KinSettingsRow
            key={item.itemId}
            title={item.title}
            detail={item.preview}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                aria-label={`${KIN_MEMORY_FORGOTTEN.restore} ${item.title}`}
                onClick={() => void bringBack(item.itemId)}
              >
                {KIN_MEMORY_FORGOTTEN.restore}
              </Button>
            }
          />
        ))}
      {all || items.length <= SHOWN ? null : (
        <KinSettingsShowAll
          label={KIN_SETTINGS_COPY.showAll(items.length)}
          onShow={() => setAll(true)}
        />
      )}
    </KinSettingsSection>
  );
}

const ORIGIN_ICON = { said: MessageSquareIcon, worked_out: BrainIcon, outside: GlobeIcon };

/** Who said it or which agent worked it out, when, and their words in full. */
function KinMemoryOrigin(props: KinMemoryTarget & { readonly origin: KinMemoryOriginView }) {
  const { origin } = props;
  const Icon = ORIGIN_ICON[origin.kind];
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>
        {origin.opens === null ? (
          origin.line
        ) : (
          <Link
            to="/kin/$environmentId/$orgId/$chatId"
            params={{
              environmentId: props.environmentId,
              orgId: props.orgId,
              chatId: origin.opens.chatId,
            }}
            search={{ message: origin.opens.messageId }}
            className="rounded-sm underline underline-offset-2 outline-none ring-ring hover:text-foreground focus-visible:ring-2"
          >
            {origin.line}
          </Link>
        )}
        {origin.quote === null ? null : (
          <>
            {" "}
            <span className="text-foreground/80">“{origin.quote}”</span>
          </>
        )}
      </span>
    </p>
  );
}
