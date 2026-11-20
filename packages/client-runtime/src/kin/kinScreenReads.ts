import type {
  EnvironmentId,
  KinMoneyLive,
  KinMoneyPart,
  KinOrgId,
  KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { AtomCommandResult } from "../state/runtime.ts";
import { kinPulseScopeOf, KIN_NEEDS_YOU_PAGE, type KinAttentionScope } from "./kinAttention.ts";
import type { KinClient } from "./kinClient.ts";
import { kinListSend } from "./kinLists.ts";
import { KIN_MONEY_PAGE, KIN_MONEY_SUMMARY } from "./kinMoneyStream.ts";
import { kinWorkAgent } from "./kinWorkHome.ts";

export interface KinScreenTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

/**
 * Where a screen reads a part the host can stream to the owner level. A teammate, or a host that
 * doesn't stream it, reads as before; until the host says which, nothing is read. The host refuses
 * a teammate's stream either way: this only spares the asking.
 */
export function kinLiveOrPlain(
  ownerLevel: boolean,
  streamed: boolean | null,
): "live" | "plain" | "waiting" {
  if (!ownerLevel || streamed === false) return "plain";
  return streamed === null ? "waiting" : "live";
}

/**
 * `line`: a line of what is owed, which no task moves. `screen`: Money itself, whose coming-up count
 * counts tasks too. `rows`: Money for a viewer who can't open Dates, so it draws the coming-up rows.
 */
export type KinMoneyUse = "line" | "screen" | "rows";

type Part<P extends KinMoneyPart> = NonNullable<KinMoneyLive[P]>;

/** A part as Money's stream keeps it, and how to start that stream over. */
export interface KinMoneyLiveRead<P extends KinMoneyPart> {
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<Part<P>, unknown>>;
  readonly refresh: () => void;
}

/**
 * The reads Kin's data hooks share on web and phone: which atom a screen reads, which reads move
 * together after a change, and the send-then-read-again of the owner's taps. React state stays in
 * each app's hook.
 */
export function makeKinScreenReads(kinClient: KinClient, registry: AtomRegistry.AtomRegistry) {
  const lists = ({ environmentId, orgId }: KinScreenTarget, archived: boolean) =>
    kinClient.workLists({ environmentId, input: archived ? { orgId, archived: true } : { orgId } });
  /** With `party`, for that client's page: its line alone, as the host lets this viewer see it. */
  const money = (
    { environmentId, orgId }: KinScreenTarget,
    use: KinMoneyUse,
    party?: KinRecordKey,
  ) =>
    use === "line"
      ? kinClient.workOwed({
          environmentId,
          input: { orgId, upcomingRows: false, ...(party === undefined ? {} : { party }) },
        })
      : kinClient.workMoney({
          environmentId,
          input: use === "rows" ? { orgId } : { orgId, upcomingRows: false },
        });
  const refreshMoney = (target: KinScreenTarget) => {
    for (const use of ["line", "screen", "rows"] as const) registry.refresh(money(target, use));
  };
  const refreshLists = (target: KinScreenTarget) => {
    registry.refresh(lists(target, false));
    registry.refresh(lists(target, true));
  };

  /** One part of Money's stream: the summary rides with every Money line, the rest with the page. */
  const moneyStreamInput = ({ environmentId, orgId }: KinScreenTarget, part: KinMoneyPart) => ({
    environmentId,
    input: { orgId, parts: part === "summary" ? KIN_MONEY_SUMMARY : KIN_MONEY_PAGE },
  });
  const moneyPartAtom = Atom.family((key: string) => {
    const [environmentId, orgId, part] = JSON.parse(key) as [EnvironmentId, KinOrgId, KinMoneyPart];
    return Atom.make((get) =>
      AsyncResult.map(
        get(kinClient.moneyLive(moneyStreamInput({ environmentId, orgId }, part))),
        (live) => live[part],
      ),
    ).pipe(Atom.withLabel(`kin:money:part:${part}:${environmentId}`));
  });
  /**
   * `part` from Money's stream for the owner level on a host that streams Money. Null where screens
   * read it as before (a teammate, an older host); undefined while the host hasn't said.
   */
  const moneyLive = <P extends KinMoneyPart>(
    target: KinScreenTarget,
    part: P,
    ownerLevel: boolean,
    streamed: boolean | null,
  ): KinMoneyLiveRead<P> | null | undefined => {
    const where = kinLiveOrPlain(ownerLevel, streamed);
    if (where === "plain") return null;
    if (where === "waiting") return undefined;
    return {
      atom: moneyPartAtom(JSON.stringify([target.environmentId, target.orgId, part])) as Atom.Atom<
        AsyncResult.AsyncResult<Part<P>, unknown>
      >,
      refresh: () => registry.refresh(kinClient.moneyLive(moneyStreamInput(target, part))),
    };
  };
  /**
   * What a screen reads: the live part when there is one, else `plain`; nothing while the host
   * hasn't said, or while the screen is off (`enabled`).
   */
  const chosen = <A>(
    live: { readonly atom: Atom.Atom<A>; readonly refresh: () => void } | null | undefined,
    plain: Atom.Atom<A>,
    enabled: boolean,
  ) => ({
    atom: enabled && live !== undefined ? (live?.atom ?? plain) : null,
    refresh: live?.refresh ?? (() => registry.refresh(plain)),
  });

  /**
   * `paged`: the first open facts Needs you shows, and counts of the rest (`outline`). `scope`: only
   * what a client's, project's or Money's own section is about; the section still filters exactly.
   */
  const attentionInput = (
    { environmentId, orgId }: KinScreenTarget,
    paged: boolean,
    scope: KinAttentionScope | undefined,
  ) => ({
    environmentId,
    input: {
      orgId,
      includeHandled: true,
      ...(paged ? { limit: KIN_NEEDS_YOU_PAGE } : {}),
      ...(scope === undefined ? {} : { scope: kinPulseScopeOf(scope) }),
    },
  });
  const attention = (
    target: KinScreenTarget,
    streamed: boolean,
    paged = false,
    scope?: KinAttentionScope,
  ) =>
    streamed
      ? kinClient.attentionLive(attentionInput(target, paged, scope))
      : kinClient.attention(attentionInput(target, paged, scope));
  const attentionStreamed = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.attentionStreamed({ environmentId, input: { orgId } });
  /** Facts answered on this device, hidden until the live read says where they stand now. */
  const answeredAtom = Atom.family((_target: string) =>
    Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive),
  );
  const answered = ({ environmentId, orgId }: KinScreenTarget) =>
    answeredAtom(`${environmentId}:${orgId}`);
  const markAnswered = (target: KinScreenTarget, factKey: string, on: boolean) => {
    const atom = answered(target);
    const rest = registry.get(atom).filter((key) => key !== factKey);
    registry.set(atom, on ? [...rest, factKey] : rest);
  };
  /** A host that streams Needs attention sends an answer's effect; an older one is asked again. */
  const afterAttentionHandle = (target: KinScreenTarget, scope?: KinAttentionScope) => {
    if (registry.get(attentionStreamed(target)) !== false) return;
    registry.refresh(attention(target, false));
    registry.refresh(attention(target, false, true));
    if (scope !== undefined) registry.refresh(attention(target, false, false, scope));
  };

  /** The agents an Ask can reach: with the retired ones where the viewer may restore them. */
  const askLeads = ({ environmentId, orgId }: KinScreenTarget, canRestore: boolean) =>
    canRestore
      ? kinClient.agents({ environmentId, orgId })
      : kinClient.leads({ environmentId, input: { orgId } });

  /**
   * One of the owner's changes to an entry: sent when the host is reachable, then the entry and
   * Money are read again either way, for the answer or what it became meanwhile.
   */
  const sendEntryChange = async <A>(
    target: KinScreenTarget,
    key: KinRecordKey | undefined,
    online: () => boolean,
    send: () => Promise<AtomCommandResult<A, unknown>>,
  ) => {
    const outcome = await kinListSend({ online, send });
    if (key !== undefined)
      registry.refresh(
        kinClient.workItem({
          environmentId: target.environmentId,
          input: { orgId: target.orgId, key },
        }),
      );
    refreshMoney(target);
    return outcome;
  };

  return {
    lists,
    money,
    refreshMoney,
    refreshLists,
    moneyLive,
    chosen,
    attention,
    attentionStreamed,
    answered,
    markAnswered,
    afterAttentionHandle,
    askLeads,
    sendEntryChange,
  };
}

/** The agent a Needs-you row names, while it works; else the one Tasks hands over to. */
export function kinAskAboutAgent<
  Lead extends {
    readonly agentId: string;
    readonly name: string;
    readonly domain: string;
    readonly retired?: unknown;
  },
>(leads: ReadonlyArray<Lead>, agentId: string | null): Lead | null {
  return (
    leads.find((lead) => lead.agentId === agentId && lead.retired === undefined) ??
    kinWorkAgent(leads, "tasks")
  );
}

export type KinScreenReads = ReturnType<typeof makeKinScreenReads>;
