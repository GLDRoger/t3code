import type {
  EnvironmentId,
  KinHouseLineLaneView,
  KinHouseLineSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";

import { useEnvironmentQuerySelector } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const laneSelectors = new Map<
  string,
  (result: AsyncResult.AsyncResult<KinHouseLineSnapshot, unknown>) => KinHouseLineLaneView | null
>();

function selectLane(threadId: string) {
  let select = laneSelectors.get(threadId);
  if (select === undefined) {
    select = (result) => {
      const snapshot = Option.getOrNull(AsyncResult.value(result));
      if (snapshot === null) return null;
      return snapshot.lanes.find((lane) => lane.threadId === threadId) ?? null;
    };
    laneSelectors.set(threadId, select);
  }
  return select;
}

export function KinLaneStateMark(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const lane = useEnvironmentQuerySelector(
    serverEnvironment.kinHouseLineSnapshot({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
    selectLane(props.threadId),
  );
  if (lane === null) return null;
  return (
    <span className="shrink-0 text-3xs uppercase tracking-wide text-muted-foreground">
      {lane.reportMismatch ? `${lane.state} · reads mismatch` : lane.state}
    </span>
  );
}
