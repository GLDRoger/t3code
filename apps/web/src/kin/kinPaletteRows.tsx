import { useAtomValue } from "@effect/atom-react";
import { kinChatListRows } from "@t3tools/client-runtime/kin/kinChatListRows";
import { type KinInboxState, selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinDestination } from "@t3tools/client-runtime/kin/kinNavigation";
import type { KinPlaces } from "@t3tools/client-runtime/kin/kinPlaces";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import type { KinSynced } from "@t3tools/client-runtime/kin/kinStreams";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { KIN_IMPORT } from "@t3tools/client-runtime/kin/kinImport";
import {
  CalendarDaysIcon,
  FileUpIcon,
  ContactRoundIcon,
  FileTextIcon,
  FolderKanbanIcon,
  ListChecksIcon,
  ListIcon,
  type LucideIcon,
  MessagesSquareIcon,
  WalletIcon,
} from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { KinAvatar } from "./KinAvatar";
import { kinDestinationLink } from "./kinListSwitch";
import { KIN_PLACE_PATH } from "./kinPlaces";
import { kinClient } from "./kinClient";
import { kinHostKeptTarget, useKinHost } from "./useKinHost";
import { kinPlacesAtom } from "./kinPlacesAtom";
import { useKinSectionOn, useKinShell } from "./useKinShell";
import { kinSectionNamed } from "@t3tools/client-runtime/kin/kinShell";

const PLACE: Record<
  KinDestination,
  { readonly title: string; readonly icon: LucideIcon; readonly words: ReadonlyArray<string> }
> = {
  chats: {
    title: "Chats: your agents, rooms and people",
    icon: MessagesSquareIcon,
    words: ["chats", "conversations", "messages", "inbox", "agents", "rooms", "people"],
  },
  tasks: {
    title: "Tasks: what's open and who has it",
    icon: ListChecksIcon,
    words: ["work", "tasks", "tracker", "tickets", "assign", "late", "due", "agents", "leads"],
  },
  money: {
    title: "Money: who owes you, what came in and what went out",
    icon: WalletIcon,
    words: ["money", "invoices", "expenses", "owed", "overdue", "received", "spent", "receivables"],
  },
  clients: {
    title: "Clients: what you owe them and what they owe you",
    icon: ContactRoundIcon,
    words: ["clients", "vendors", "crm", "contacts", "owe", "obligations"],
  },
  docs: {
    title: "Docs: what your agents have written up",
    icon: FileTextIcon,
    words: ["docs", "documents", "notes", "plans", "proposals", "writing"],
  },
};

const noPlacesAtom = Atom.make<KinPlaces | null>(null);

/**
 * One row per place this person's menu shows, with its shortcut, then the other words for where
 * things are (Projects, Lists, Dates), each only beside the place that holds it.
 */
export function useKinPlaceRows(): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const target = kinHostKeptTarget(useKinHost());
  // T3's palette tests answer every atom with [], so the places may be absent there.
  const shown = useAtomValue(target === null ? noPlacesAtom : kinPlacesAtom(target));
  // The owner level's, as the host has it: the same gate the host applies to the call.
  const canImport = useAtomValue(
    kinClient.importApply.permissionAtom(target?.environmentId ?? null),
  );
  const dealsOn = useKinSectionOn(target?.environmentId ?? null, "deals");
  const shell = useKinShell(target?.environmentId ?? null);
  const named = (text: string) => kinSectionNamed(shell, text);
  const destinations = shown?.destinations ?? [];
  if (target === null || destinations.length === 0) return [];
  const row = (
    value: string,
    title: string,
    Icon: LucideIcon,
    words: ReadonlyArray<string>,
    run: () => Promise<void>,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:kin-${value}`,
    searchTerms: ["kin", ...words],
    title,
    icon: <Icon className={ITEM_ICON_CLASS} />,
    run,
  });
  const has = (place: KinDestination) => destinations.includes(place);
  const mod = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";
  return [
    ...destinations.map((destination, index) => ({
      ...row(
        destination,
        named(PLACE[destination].title),
        PLACE[destination].icon,
        // The company's own word for Clients finds it too.
        ["go", "open", ...PLACE[destination].words.map(named), ...PLACE[destination].words],
        async () => {
          await navigate(kinDestinationLink(destination, target));
        },
      ),
      description: `${mod}${index + 1}`,
    })),
    ...(has("clients")
      ? [
          row(
            "projects",
            "Projects: how each one is going",
            FolderKanbanIcon,
            ["projects", "status", "health", "blocked", "at risk", "late"],
            async () => {
              await navigate({
                to: KIN_PLACE_PATH.clients,
                params: target,
                search: { tab: "projects" },
              });
            },
          ),
        ]
      : []),
    ...(has("clients") && canImport
      ? [
          row(
            "import",
            named(
              dealsOn
                ? `${KIN_IMPORT.entry}: bring clients, contacts and deals in from a spreadsheet`
                : `${KIN_IMPORT.entry}: bring clients and contacts in from a spreadsheet`,
            ),
            FileUpIcon,
            [
              "import",
              "csv",
              "spreadsheet",
              "upload",
              "excel",
              "crm",
              "contacts",
              ...(dealsOn ? ["deals"] : []),
              "bring in",
            ],
            async () => {
              await navigate({
                to: KIN_PLACE_PATH.clients,
                params: target,
                search: { open: "import" },
              });
            },
          ),
        ]
      : []),
    ...(has("docs")
      ? [
          row(
            "lists",
            "Lists: everything your agents keep track of",
            ListIcon,
            ["lists", "expenses", "invoices", "renewals", "tracking", "register"],
            async () => {
              await navigate({ to: KIN_PLACE_PATH.docs, params: target });
            },
          ),
        ]
      : []),
    ...(has("money")
      ? [
          row(
            "dates",
            "Dates: everything due, across every list",
            CalendarDaysIcon,
            ["dates", "calendar", "due", "agenda", "renewals", "gst", "filing"],
            async () => {
              await navigate({ to: KIN_PLACE_PATH.money, params: target, search: { dates: true } });
            },
          ),
        ]
      : []),
  ];
}

const noInboxAtom = Atom.make(AsyncResult.initial<KinSynced<KinInboxState>, unknown>()).pipe(
  Atom.withLabel("kin:palette-no-inbox"),
);

/** This person's own chats, by the names their Chats list shows, read only while they search. */
export function useKinChatRows(
  environmentId: EnvironmentId | null,
  searching: boolean,
): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const host = useKinHost();
  const inbox = useAtomValue(
    environmentId === null || !searching
      ? noInboxAtom
      : kinClient.inbox({ environmentId, input: {} }),
  );
  if (environmentId === null || inbox._tag !== "Success") return [];
  const rows = kinChatListRows(selectKinInboxView(inbox.value.value), kinDirectory(host));
  return rows.flatMap(({ chat, view }) =>
    view.title === null
      ? []
      : [
          {
            kind: "action" as const,
            value: `action:kin-chat:${chat.chatId}`,
            searchTerms: [view.title],
            title: view.title,
            description: "Chat",
            icon: <KinAvatar avatar={view.avatar} size="xs" />,
            run: async () => {
              await navigate({
                to: "/kin/$environmentId/$orgId/$chatId",
                params: {
                  environmentId,
                  orgId: chat.orgId,
                  chatId: chat.chatId,
                },
              });
            },
          },
        ],
  );
}
