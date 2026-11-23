import { useAtomValue } from "@effect/atom-react";
import { KIN_PERSON_TASKS, kinTaskLine } from "@t3tools/client-runtime/kin/kinTasksList";
import type { KinOrgId, KinPersonId, KinRecordKey } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinWorkDirectory } from "./useKinWork";

/**
 * A person's page lists what they hold: how many open tasks the reader sees, the five most urgent
 * in Tasks' own order, and the way to all of them in Tasks.
 */
export function KinPersonTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly onOpenTask: (key: KinRecordKey) => void;
  readonly onSeeAll: () => void;
}) {
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const result = useAtomValue(
    kinClient.personTasks({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, person: props.personId },
    }),
  );
  const { names } = useKinWorkDirectory(target, true);
  const now = new Date(useNowMinuteMs());
  if (AsyncResult.isFailure(result))
    return <p className="text-sm text-muted-foreground">{KIN_PERSON_TASKS.failed}</p>;
  if (!AsyncResult.isSuccess(result)) return <Skeleton className="h-16 w-full" />;
  const { total, records, count } = result.value;
  if (total === 0) return <p className="text-sm text-muted-foreground">{KIN_PERSON_TASKS.none}</p>;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-foreground">{count}</p>
      <ul className="flex flex-col">
        {records.map((record) => {
          const line = kinTaskLine(record, names, now);
          return (
            <li key={record.key}>
              <button
                type="button"
                onClick={() => props.onOpenTask(record.key)}
                className="flex min-h-9 w-full items-center gap-3 rounded-md px-1 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="line-clamp-2 text-sm text-foreground">{record.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {line.lead === null ? null : (
                      <span
                        className={
                          line.lead.tone === "late" ? "text-destructive-foreground" : undefined
                        }
                      >
                        {line.lead.text}
                        {line.rest === "" ? "" : " · "}
                      </span>
                    )}
                    {line.rest}
                  </span>
                </span>
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="ghost" className="self-start" onClick={props.onSeeAll}>
        {KIN_PERSON_TASKS.seeAll}
      </Button>
    </div>
  );
}
