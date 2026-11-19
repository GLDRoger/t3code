import { useAtomValue } from "@effect/atom-react";
import { kinChatListRows } from "@t3tools/client-runtime/kin/kinChatListRows";
import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import type { KinDestination } from "@t3tools/client-runtime/kin/kinNavigation";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDaysIcon,
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
import { kinDestinationLink, kinShownDestinationsAtom } from "./kinListSwitch";
import { KIN_PLACE_PATH } from "./kinPlaces";
import { useKinInbox } from "./useKinHost";

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

/**
 * One row per place this person's menu shows, with its shortcut, then the other words for where
 * things are (Projects, Lists, Dates), each only beside the place that holds it.
 */
export function useKinPlaceRows(): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const shown = useAtomValue(kinShownDestinationsAtom);
  if (shown === null) return [];
  const { target, destinations } = shown;
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
        PLACE[destination].title,
        PLACE[destination].icon,
        ["go", "open", ...PLACE[destination].words],
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
              await navigate({ to: KIN_PLACE_PATH.clients, params: target });
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

/** This person's own chats, by the names their Chats list shows, while they search. */
export function useKinChatRows(searching: boolean): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const { host, state } = useKinInbox();
  if (!searching || state._tag !== "ready") return [];
  const rows = kinChatListRows(selectKinInboxView(state.inbox.value), kinDirectory(host));
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
                  environmentId: state.environmentId,
                  orgId: chat.orgId,
                  chatId: chat.chatId,
                },
              });
            },
          },
        ],
  );
}
