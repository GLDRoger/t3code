import { useAtomValue } from "@effect/atom-react";
import { kinSearchHit } from "@t3tools/client-runtime/kin/kinDocs";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  BotIcon,
  BrainIcon,
  FileTextIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  UserRoundPlusIcon,
  UsersIcon,
} from "lucide-react";

import {
  buildRootGroups,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  ITEM_ICON_CLASS,
} from "../components/CommandPalette.logic";
import { useOpenKinAgentPage, useKinPaletteAgents } from "./kinAgentPageLink";
import { kinClient } from "./kinClient";
import { kinListShownAt, kinReturnHref } from "./kinListSwitch";
import { kinSearchHitPlace } from "./kinPlaces";
import { kinNewLeadTarget, noKinLeadPermissionAtom, openKinLeadForm } from "./KinNewLeadButton";
import { useKinChatRows, useKinPlaceRows } from "./kinPaletteRows";
import { openKinSettings } from "./kinSettingsAddress";
import { useKinPaletteHits } from "./useKinDocs";
import { useKinHost } from "./useKinHost";
import { useKinListSwitch } from "./useKinListSwitch";

type PaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

/** What Kin is asked for: nothing for a command filter or a single letter. */
const kinPaletteQuery = (query: string) => {
  const text = query.trim();
  return query.startsWith(">") || text.length < 2 ? "" : text;
};

/**
 * Kin's part of the command palette: its commands and search hits, and over Kin's own pages
 * the palette narrowed to them, since Kin doesn't offer T3's coding threads, projects or app
 * settings.
 */
export function useKinPalette(input: {
  readonly pathname: string;
  readonly query: string;
  readonly isActionsOnly: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const inKin = kinListShownAt(input.pathname) === "kin";
  const kinListSwitch = useKinListSwitch();
  const kinPlaceRows = useKinPlaceRows();
  const kinNewLead = kinNewLeadTarget(useKinHost());
  const canCreateKinLead = useAtomValue(
    kinNewLead === null
      ? noKinLeadPermissionAtom
      : kinClient.leadCreate.permissionAtom(kinNewLead.environmentId),
  );
  const canOpenKinMemory = useAtomValue(
    kinNewLead === null
      ? noKinLeadPermissionAtom
      : kinClient.memorySetVisibility.permissionAtom(kinNewLead.environmentId),
  );
  const canOpenKinWork = useAtomValue(
    kinNewLead === null
      ? noKinLeadPermissionAtom
      : kinClient.workRead.permissionAtom(kinNewLead.environmentId),
  );
  const canManageKinTeam = useAtomValue(
    kinNewLead === null
      ? noKinLeadPermissionAtom
      : kinClient.inviteCreate.permissionAtom(kinNewLead.environmentId),
  );
  const kinAgents = useKinPaletteAgents(kinNewLead, canCreateKinLead);
  const kinChatRows = useKinChatRows(
    kinNewLead?.environmentId ?? null,
    !input.isActionsOnly && input.query.trim() !== "",
  );
  const openKinAgentPage = useOpenKinAgentPage();
  const kinHits = useKinPaletteHits(
    canOpenKinWork ? kinNewLead : null,
    kinPaletteQuery(input.query),
  );

  const actionItems: PaletteItem[] = [...kinPlaceRows];

  // Only the way back into Kin: Kin itself doesn't offer the coding threads.
  if (kinListSwitch !== null && kinListSwitch.current === "threads") {
    actionItems.push({
      kind: "action",
      value: "action:kin-switch-list",
      searchTerms: ["kin", "chats", "agents", "leads", "coding", "threads", "switch", "list"],
      title: kinListSwitch.title,
      icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "kin.switchList",
      run: async () => {
        kinListSwitch.switchList();
      },
    });
  }

  if (kinNewLead !== null && canCreateKinLead) {
    actionItems.push({
      kind: "action",
      value: "action:kin-new-lead",
      searchTerms: ["kin", "agent", "lead", "new", "create", "add", "teammate"],
      title: "New agent",
      icon: <UserRoundPlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        // The form lives on Kin's page, so it opens there.
        await navigate({ href: kinReturnHref() });
        openKinLeadForm(kinNewLead);
      },
    });
  }

  actionItems.push(...kinChatRows);
  if (kinNewLead !== null) {
    for (const agent of kinAgents) {
      actionItems.push({
        kind: "action",
        value: `action:kin-agent:${agent.agentId}`,
        searchTerms: ["kin", "agent", "model", "character", "pause", agent.name, agent.domain],
        title: `${agent.name}: model, character and settings`,
        icon: <BotIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await openKinAgentPage({
            ...kinNewLead,
            agentId: agent.agentId,
            chatId: agent.ownerChatId,
          });
        },
      });
    }
  }

  if (kinNewLead !== null && canOpenKinMemory) {
    actionItems.push({
      kind: "action",
      value: "action:kin-memory",
      searchTerms: ["kin", "memory", "remember", "agents", "leads", "team", "share"],
      title: "What your agents remember",
      icon: <BrainIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openKinSettings(router.history, "memory");
      },
    });
  }

  if (kinNewLead !== null && canManageKinTeam) {
    actionItems.push({
      kind: "action",
      value: "action:kin-team",
      searchTerms: ["kin", "team", "people", "teammate", "invite", "add", "person", "link"],
      title: "Team: add or invite a teammate",
      icon: <UsersIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openKinSettings(router.history, "team");
      },
    });
  }

  const kinItems = (inView: boolean): CommandPaletteActionItem[] =>
    kinNewLead === null || inView
      ? []
      : kinHits.map((raw) => {
          const hit = kinSearchHit(raw);
          const Icon = hit.kind === "docs" ? FileTextIcon : ListChecksIcon;
          return {
            kind: "action" as const,
            value: `kin-hit:${hit.id}`,
            searchTerms: [hit.title],
            title: hit.title,
            description: [hit.kindLabel, hit.section?.title, hit.snippet, hit.closed]
              .filter((part) => part !== null && part !== undefined)
              .join(" · "),
            icon: <Icon className={ITEM_ICON_CLASS} />,
            run: async () => {
              const place = kinSearchHitPlace(hit);
              if (place === null) openKinSettings(router.history, "memory", hit.title);
              else
                await navigate({
                  to: place.to,
                  params: { environmentId: kinNewLead.environmentId, orgId: kinNewLead.orgId },
                  search: place.search,
                });
            },
          };
        });

  return {
    actionItems,
    /** Over Kin, Open settings opens Kin's own Settings; null elsewhere. */
    openSettings: inKin ? async () => openKinSettings(router.history) : null,
    /** The palette's root lists, narrowed over Kin to Kin's commands and the shared ones in `keep`. */
    rootInput: (root: Parameters<typeof buildRootGroups>[0], keep: ReadonlyArray<PaletteItem>) =>
      inKin
        ? {
            ...root,
            actionItems: root.actionItems.filter(
              (item) =>
                (item.value.startsWith("action:kin-") && item.value !== "action:kin-switch-list") ||
                item.value === "action:settings" ||
                item.value.startsWith("action:workspace-focus:") ||
                keep.includes(item),
            ),
            recentThreadItems: [],
          }
        : root,
    /** Kin's search hits, and over Kin no coding threads, projects or app settings in search. */
    searchInput: (inView: boolean) =>
      inKin
        ? {
            projectSearchItems: [],
            settingsSearchItems: [],
            threadSearchItems: [],
            threadMessageItems: [],
            kinItems: kinItems(inView),
          }
        : { kinItems: kinItems(inView) },
  };
}
