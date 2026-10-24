import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { useEnvironmentQuery } from "../../state/query";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";

export function HousesPage() {
  const projects = useProjects();
  return (
    <main className="h-full overflow-y-auto px-6 py-5">
      <h1 className="text-lg font-medium">Houses</h1>
      {projects.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {projects.map((project) => (
            <ProjectHouses key={`${project.environmentId}:${project.id}`} project={project} />
          ))}
        </div>
      )}
    </main>
  );
}

function ProjectHouses(props: { readonly project: EnvironmentProject }) {
  const query = useEnvironmentQuery(
    serverEnvironment.kinHouseLineSnapshot({
      environmentId: props.project.environmentId,
      input: { projectId: props.project.id },
    }),
  );
  const title = props.project.title || props.project.workspaceRoot;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {query.isPending ? <p className="text-sm text-muted-foreground">Loading houses.</p> : null}
      {query.error !== null ? <p className="text-sm text-destructive">{query.error}</p> : null}
      {query.data !== null && query.data.houses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No houses yet.</p>
      ) : null}
      {query.data?.houses.map((house) => (
        <article key={house.id} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{house.name}</h3>
          {house.reigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reigns yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {house.reigns.map((reign) => (
                <li key={reign.crowningId} className="text-sm">
                  <p className="font-medium">{reign.regnalLabel}</p>
                  {reign.willBody === null ? (
                    <p className="text-muted-foreground">No will.</p>
                  ) : (
                    <p className="whitespace-pre-wrap">{reign.willBody}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {query.data !== null && query.data.lanes.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {query.data.lanes.map((lane) => (
            <li key={lane.id} className="text-xs text-muted-foreground">
              {lane.label}: {lane.state}
              {lane.reportMismatch ? " · reads mismatch" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
