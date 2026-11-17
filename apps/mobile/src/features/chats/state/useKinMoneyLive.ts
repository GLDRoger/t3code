import { useAtomValue } from "@effect/atom-react";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { KIN_MONEY_PAGE, KIN_MONEY_SUMMARY } from "@t3tools/client-runtime/kin/kinMoneyStream";
import type { KinMoneyLive, KinMoneyPart } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

type Part<P extends KinMoneyPart> = NonNullable<KinMoneyLive[P]>;

/** One part of Money's stream: the summary rides with every Money line, the rest with the screen. */
const partAtom = Atom.family((key: string) => {
  const [environmentId, orgId, part] = JSON.parse(key) as [
    KinWorkTarget["environmentId"],
    KinWorkTarget["orgId"],
    KinMoneyPart,
  ];
  const parts = part === "summary" ? KIN_MONEY_SUMMARY : KIN_MONEY_PAGE;
  return Atom.make((get) =>
    AsyncResult.map(
      get(kinClient.moneyLive({ environmentId, input: { orgId, parts } })),
      (live) => live[part],
    ),
  ).pipe(Atom.withLabel(`kin:money:part:${part}:${environmentId}`));
});

/**
 * `part` as Money's stream keeps it, for the owner level on a host that streams Money: its atom and
 * how to start the stream over. Null where screens read it as before (a teammate, an older host);
 * undefined while the host hasn't said.
 */
export function useKinMoneyLive<P extends KinMoneyPart>(
  target: KinWorkTarget,
  part: P,
):
  | {
      readonly atom: Atom.Atom<AsyncResult.AsyncResult<Part<P>, unknown>>;
      readonly refresh: () => void;
    }
  | null
  | undefined {
  const { environmentId, orgId } = target;
  const streamed = useAtomValue(kinClient.moneyStreamed({ environmentId, input: { orgId } }));
  const ownerLevel = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, environmentId));
  if (!ownerLevel || streamed === false) return null;
  if (streamed === null) return undefined;
  const parts = part === "summary" ? KIN_MONEY_SUMMARY : KIN_MONEY_PAGE;
  return {
    atom: partAtom(JSON.stringify([environmentId, orgId, part])) as Atom.Atom<
      AsyncResult.AsyncResult<Part<P>, unknown>
    >,
    refresh: () =>
      appAtomRegistry.refresh(kinClient.moneyLive({ environmentId, input: { orgId, parts } })),
  };
}
