import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { visibleOnKinEndpoint } from "../../apps/server/src/kin/lead/AgentSession.ts";
import { TRIAGE_THREAD_PREFIX } from "../../apps/server/src/kin/lead/outsideTriage.ts";

export const KinSeat = Schema.Literals(["outside-triage"]);
export type KinSeat = typeof KinSeat.Type;

export const kinSeatOf = ({
  setup,
}: {
  readonly setup: { readonly world?: { readonly kinSeat?: KinSeat | undefined } | undefined };
}) => setup.world?.kinSeat;

const triageThread = ThreadId.make(`${TRIAGE_THREAD_PREFIX}eval`);
export const triageToolVisible = (name: string) =>
  Effect.runSync(visibleOnKinEndpoint(name, triageThread));
