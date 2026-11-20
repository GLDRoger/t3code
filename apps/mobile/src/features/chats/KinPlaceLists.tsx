import { useNavigation } from "@react-navigation/native";
import {
  KIN_LIST_DEFAULT_FILTER,
  kinListHeader,
  kinListRow,
  type KinListFilter,
} from "@t3tools/client-runtime/kin/kinLists";
import { KIN_MONEY, kinInMoney, kinMoneyView } from "@t3tools/client-runtime/kin/kinMoney";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import type { KinListDefinition } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { KinListRowLine } from "./KinListScreen";
import { useKinOpenPlaceList } from "./state/kinHomeTab";
import {
  kinListsOf,
  useKinListContext,
  useKinListEntries,
  useKinLists,
  useKinMoneySummary,
} from "./state/useKinMoney";
import type { KinWorkDirectory, KinWorkTarget } from "./state/useKinWork";

const SHOWN = 5;

type Place = { readonly party: KinWorkRef } | { readonly project: KinWorkRef };

type Shared = KinWorkTarget & {
  readonly place: Place;
  /** The page's change number; null while what it shows may be behind. */
  readonly seq: number | null;
  readonly directory: KinWorkDirectory;
};

/**
 * A client's or project's entries in every list an agent set up: its invoices, its expenses, or
 * whatever else points at it. A list with nothing for it isn't shown.
 */
export function KinPlaceLists(props: Shared) {
  const lists = useKinLists(props, { enabled: true });
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

/** What this client owes us and how late, from the same figures as Money; its invoices follow. */
function PlaceOwed(props: Shared & { readonly party: KinWorkRef }) {
  const lists = useKinLists(props, { enabled: true });
  const { state } = useKinMoneySummary(props, { enabled: true, party: props.party.key });
  if (state._tag !== "ready") return null;
  const client = kinMoneyView(state.value, kinListsOf(lists)).clients.find(
    (held) => held.key === props.party.key,
  );
  if (client === undefined) return null;
  return (
    <ListSection title={KIN_MONEY.owed}>
      <View className="gap-0.5 px-4 py-3">
        {client.owed.map((line) => (
          <Text
            key={line}
            textRole="title"
            selectable
            className="font-t3-bold tabular-nums text-foreground"
          >
            {line}
          </Text>
        ))}
        {client.overdue === null ? null : (
          <Text textRole="footnote" className="text-danger-foreground">
            {client.overdue}
          </Text>
        )}
      </View>
    </ListSection>
  );
}

function PlaceList(props: Shared & { readonly def: KinListDefinition }) {
  const navigation = useNavigation();
  const { def, place, environmentId, orgId } = props;
  const filter: KinListFilter = {
    ...KIN_LIST_DEFAULT_FILTER,
    ...("party" in place ? { party: place.party } : { project: place.project }),
  };
  const context = useKinListContext(props, props.directory);
  const { state, totals } = useKinListEntries(props, def.list, filter, props.seq);
  const openList = useKinOpenPlaceList(props);
  if (state.total === null || state.total === 0) return null;
  const header = kinListHeader(def, filter, totals, state.total, context.yearStartMonth);
  return (
    <ListSection title={def.name} {...(header.summary === null ? {} : { footer: header.summary })}>
      {state.records.slice(0, SHOWN).map((record) => {
        const row = kinListRow(record, def, context, {
          party: "party" in place ? place.party.key : null,
        });
        return (
          <KinListRowLine
            key={row.key}
            row={row}
            inset
            onPress={() =>
              navigation.navigate("KinWorkItem", { environmentId, orgId, task: row.key })
            }
          />
        );
      })}
      {state.total > SHOWN ? (
        <ListActionRow
          label={`See all ${state.total}`}
          onPress={() => openList(kinInMoney(def) ? "money" : "docs", { list: def.list, filter })}
        />
      ) : null}
    </ListSection>
  );
}
