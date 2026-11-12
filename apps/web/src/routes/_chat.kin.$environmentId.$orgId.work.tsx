import { KinDocSectionId, KinOrgId, KinRecordKey, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { KinWorkView, type KinWorkWhere } from "../kin/KinWorkView";

const isKey = Schema.is(KinRecordKey);
const isSection = Schema.is(KinDocSectionId);
const versionOf = (raw: unknown) => {
  const version = Number(raw);
  return Number.isSafeInteger(version) && version > 0 ? version : undefined;
};
// The address says "client"; reading it by name keeps it apart from an RPC client in lint's eyes.
const CLIENT = "client";

interface KinWorkSearch {
  /** The open task. */
  task?: KinRecordKey;
  /** The list on screen, when it isn't tasks. */
  show?: "clients" | "projects" | "docs";
  /** The open client or project. */
  client?: KinRecordKey;
  project?: KinRecordKey;
  /** The open doc: the version read, the section arrived at, or the versions compared. */
  doc?: KinRecordKey;
  v?: number;
  section?: string;
  changes?: number;
  from?: number;
  history?: boolean;
}

const searchOf = (where: KinWorkWhere): KinWorkSearch =>
  "party" in where
    ? { client: where.party }
    : "doc" in where
      ? {
          doc: where.doc,
          ...(where.version === undefined ? {} : { v: where.version }),
          ...(where.section === undefined ? {} : { section: where.section }),
          ...(where.changes === undefined
            ? {}
            : {
                changes: where.changes.to,
                ...(where.changes.from === undefined ? {} : { from: where.changes.from }),
              }),
          ...(where.history === true ? { history: true } : {}),
        }
      : "project" in where
        ? { project: where.project }
        : where.area === "tasks"
          ? {}
          : { show: where.area };

function KinWorkRoute() {
  const { environmentId, orgId } = Route.useParams();
  const search = Route.useSearch();
  const { task, show, project } = search;
  const party = search[CLIENT];
  const navigate = Route.useNavigate();
  const router = useRouter();
  const { doc } = search;
  const where: KinWorkWhere =
    doc !== undefined
      ? {
          doc,
          ...(search.v === undefined ? {} : { version: search.v }),
          ...(search.section === undefined ? {} : { section: search.section }),
          ...(search.changes === undefined
            ? {}
            : {
                changes: {
                  to: search.changes,
                  ...(search.from === undefined ? {} : { from: search.from }),
                },
              }),
          ...(search.history === true ? { history: true } : {}),
        }
      : party !== undefined
        ? { party }
        : project !== undefined
          ? { project }
          : { area: show ?? "tasks" };
  return (
    <KinWorkView
      // One mounted view per organization, so a list being read never lands under another.
      key={`${environmentId}:${orgId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={KinOrgId.make(orgId)}
      where={where}
      onGo={(next) => void navigate({ search: searchOf(next) })}
      docLink={(key, section) =>
        new URL(
          router.history.createHref(
            router.buildLocation({
              to: "/kin/$environmentId/$orgId/work",
              params: { environmentId, orgId },
              search: { doc: key, ...(section === null ? {} : { section }) },
            }).href,
          ),
          window.location.href,
        ).toString()
      }
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
  validateSearch: (raw: Record<string, unknown>): KinWorkSearch => {
    const v = versionOf(raw.v);
    const changes = versionOf(raw.changes);
    const from = versionOf(raw.from);
    return {
      ...(isKey(raw.task) ? { task: raw.task } : {}),
      ...(raw.show === "clients" || raw.show === "projects" || raw.show === "docs"
        ? { show: raw.show }
        : {}),
      ...(isKey(raw[CLIENT]) ? { client: raw[CLIENT] } : {}),
      ...(isKey(raw.project) ? { project: raw.project } : {}),
      ...(isKey(raw.doc) ? { doc: raw.doc } : {}),
      ...(v === undefined ? {} : { v }),
      ...(isSection(raw.section) ? { section: raw.section } : {}),
      ...(changes === undefined ? {} : { changes }),
      ...(from === undefined ? {} : { from }),
      ...(raw.history === true ? { history: true } : {}),
    };
  },
  component: KinWorkRoute,
});
