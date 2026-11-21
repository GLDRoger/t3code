import { KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { squashAtomCommandFailure, type AtomCommandResult } from "../../state/runtime.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { KIN_TASK_STEPS_START, createKinTaskSteps } from "../kinTaskSteps.ts";
import type { KinHookApp } from "./kinHookApp.ts";

const sent = <A, E>(result: AtomCommandResult<A, E>) =>
  AsyncResult.isSuccess(result)
    ? ({ ok: true } as const)
    : ({ ok: false, cause: squashAtomCommandFailure(result) } as const);

export function makeKinTaskStepsHooks<R, ER>(app: KinHookApp<R, ER>) {
  /** A Tasks row's step, taken from the row (`createKinTaskSteps`). */
  function useKinTaskSteps(target: KinScreenTarget) {
    const post = app.useAtomCommand(app.kinClient.widgetAction, { reportFailure: false });
    const nudgeHolder = app.useAtomCommand(app.kinClient.workNudge, { reportFailure: false });
    const [state, setState] = useState(KIN_TASK_STEPS_START);
    const [steps] = useState(() =>
      createKinTaskSteps({
        newId: app.newId,
        post: async (input) => sent(await post({ environmentId: target.environmentId, input })),
        onChange: setState,
      }),
    );
    return {
      status: state.status,
      nudged: state.nudged,
      choose: steps.choose,
      nudge: (key: string) =>
        steps.nudge(key, async () =>
          sent(
            await nudgeHolder({
              environmentId: target.environmentId,
              input: { orgId: target.orgId, key: KinRecordKey.make(key) },
            }),
          ),
        ),
    };
  }

  return { useKinTaskSteps };
}
