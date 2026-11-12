import {
  KIN_LIST_DEFAULT_FILTER,
  kinListHeader,
  kinListRow,
  type KinListFilter,
} from "@t3tools/client-runtime/kin/kinLists";
import { KIN_MONEY, kinMoneyView, type KinListOpen } from "@t3tools/client-runtime/kin/kinMoney";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import type { KinListDefinition, KinRecordKey } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import { KinListRow } from "./KinWorkLists";
import { KinWorkSection } from "./KinWorkParts";
import {
  kinListsOf,
  useKinListContext,
  useKinListEntries,
  useKinLists,
  useKinMoneySummary,
} from "./useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const SHOWN = 5;

type Place = { readonly party: KinWorkRef } | { readonly project: KinWorkRef };

type Shared = KinWorkTarget & {
  readonly place: Place;
  /** The page's change number; null while what it shows may be behind. */
  readonly seq: number | null;
  readonly directory: KinWorkDirectory;
  readonly onOpenList: (open: KinListOpen) => void;
  readonly onOpenKey: (key: KinRecordKey) => void;
};

/**
 * A client's or project's entries in every list an agent set up: its invoices, its expenses, or
 * whatever else points at it. A list with nothing for it isn't shown.
 */
export function KinWorkPlaceLists(props: Shared) {
  const lists = useKinLists(props, { enabled: true, seq: props.seq });
  const defs = kinListsOf(lists).filter((def) => !def.builtIn);
  return (
    <>
      {"party" in props.place ? <PlaceOwed {...props} party={props.place.party} /> : null}
      {defs.map((def) => (
        <PlaceList key={def.list} {...props} def={def} />
      ))}
    </>
  );
}

/** What this client owes us and how late, from the same figures as Money. */
function PlaceOwed(props: Shared & { readonly party: KinWorkRef }) {
  const lists = useKinLists(props, { enabled: true, seq: props.seq });
  const { state } = useKinMoneySummary(props, { enabled: true, seq: props.seq });
  if (state._tag !== "ready") return null;
  const client = kinMoneyView(state.value, kinListsOf(lists)).clients.find(
    (held) => held.key === props.party.key,
  );
  if (client === undefined) return null;
  const { open } = client;
  return (
    <KinWorkSection
      title={KIN_MONEY.owed}
      action={
        open === null ? undefined : (
          <Button size="xs" variant="ghost" onClick={() => props.onOpenList(open)}>
            Show {client.invoices}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-0.5">
        {client.owed.map((line) => (
          <span
            key={line}
            className="text-lg font-semibold tracking-tight text-foreground tabular-nums"
          >
            {line}
          </span>
        ))}
        {client.overdue === null ? null : (
          <span className="text-xs text-destructive-foreground">{client.overdue}</span>
        )}
      </div>
    </KinWorkSection>
  );
}

function PlaceList(props: Shared & { readonly def: KinListDefinition }) {
  const { def, place } = props;
  const filter: KinListFilter = {
    ...KIN_LIST_DEFAULT_FILTER,
    ...("party" in place ? { party: place.party } : { project: place.project }),
  };
  const context = useKinListContext(props, props.directory);
  const { state, totals } = useKinListEntries(props, def.list, filter, props.seq);
  if (state.total === null || state.total === 0) return null;
  const header = kinListHeader(def, filter, totals, state.total);
  return (
    <KinWorkSection
      title={def.name}
      action={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => props.onOpenList({ list: def.list, filter })}
        >
          {state.total > SHOWN ? `See all ${state.total}` : "Open list"}
        </Button>
      }
    >
      {header.totals.length === 0 ? null : (
        <p className="text-xs text-muted-foreground tabular-nums">
          {header.totals.join(" and ")} in all
        </p>
      )}
      <ul className="-mx-2 flex flex-col">
        {state.records.slice(0, SHOWN).map((record) => {
          const row = kinListRow(record, def, context, {
            party: "party" in place ? place.party.key : null,
          });
          return (
            <li key={row.key}>
              <KinListRow row={row} onOpen={() => props.onOpenKey(row.key)} />
            </li>
          );
        })}
      </ul>
    </KinWorkSection>
  );
}
