import { KinListId, KinOrgId, KinRecordKey, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { KinWorkView, type KinWorkWhere } from "../kin/KinWorkView";

const isKey = Schema.is(KinRecordKey);
const isList = Schema.is(KinListId);
const SHOWN = ["clients", "projects", "money", "lists", "dates"] as const;
type Shown = (typeof SHOWN)[number];
const isShown = (value: unknown): value is Shown => SHOWN.some((held) => held === value);
// The address says "client"; reading it by name keeps it apart from an RPC client in lint's eyes.
const CLIENT = "client";

interface KinWorkSearch {
  /** The open task. */
  task?: KinRecordKey;
  /** The part on screen, when it isn't tasks. */
  show?: Shown;
  /** The open list an agent set up. */
  list?: KinListId;
  /** The open client or project. */
  client?: KinRecordKey;
  project?: KinRecordKey;
}

const searchOf = (where: KinWorkWhere): KinWorkSearch =>
  "party" in where
    ? { client: where.party }
    : "project" in where
      ? { project: where.project }
      : "list" in where
        ? { list: where.list }
        : "dates" in where
          ? { show: "dates" }
          : where.area === "tasks"
            ? {}
            : { show: where.area };

function KinWorkRoute() {
  const { environmentId, orgId } = Route.useParams();
  const search = Route.useSearch();
  const { task, show, project, list } = search;
  const party = search[CLIENT];
  const navigate = Route.useNavigate();
  const where: KinWorkWhere =
    party !== undefined
      ? { party }
      : project !== undefined
        ? { project }
        : list !== undefined
          ? { list }
          : show === "dates"
            ? { dates: true }
            : { area: show ?? "tasks" };
  return (
    <KinWorkView
      // One mounted view per organization, so a list being read never lands under another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      where={where}
      onGo={(next) => void navigate({ search: searchOf(next) })}
      openKey={task ?? null}
      onOpenKey={(key) =>
        void navigate({
          search: key === null ? searchOf(where) : { ...searchOf(where), task: key },
          replace: key === null,
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/work")({
  // What is open rides in the address, so a task, client or project can be linked to and Back
  // closes it.
  validateSearch: (raw: Record<string, unknown>): KinWorkSearch => ({
    ...(isKey(raw.task) ? { task: raw.task } : {}),
    ...(isShown(raw.show) ? { show: raw.show } : {}),
    ...(isList(raw.list) ? { list: raw.list } : {}),
    ...(isKey(raw[CLIENT]) ? { client: raw[CLIENT] } : {}),
    ...(isKey(raw.project) ? { project: raw.project } : {}),
  }),
  component: KinWorkRoute,
});
