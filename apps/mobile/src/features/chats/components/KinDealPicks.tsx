import type { MenuAction } from "@react-native-menu/menu";
import { KIN_DEALS, type kinDealQuoteChoices } from "@t3tools/client-runtime/kin/kinDeals";
import {
  KIN_WORK_ASSIGN,
  type KinWorkAssignee,
  type kinWorkAssignees,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey, KinWorkPrincipal } from "@t3tools/contracts";
import { View } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";

const OPEN = "open";
const NO_QUOTE = "none";

/** Who looks after a deal, as a row whose menu hands it to someone else: people, then agents. */
export function KinDealOwnerRow(props: {
  readonly name: string;
  readonly assignees: ReturnType<typeof kinWorkAssignees>;
  readonly disabled: boolean;
  readonly onGive: (to: KinWorkPrincipal) => void;
}) {
  const choice = (to: KinWorkAssignee): MenuAction => ({
    id: to.key,
    title: to.name,
    ...(to.invited ? { subtitle: KIN_WORK_ASSIGN.invited } : {}),
    state: to.current ? "on" : "off",
    ...(to.invited ? { attributes: { disabled: true } } : {}),
  });
  const everyone = [...props.assignees.people, ...props.assignees.leads];
  return (
    <Menu
      title={KIN_WORK_ASSIGN.title}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_DEALS.lookedAfterBy}: ${props.name}. ${KIN_DEALS.changeOwner}`}
      actions={[
        ...props.assignees.people.map(choice),
        ...(props.assignees.leads.length === 0
          ? []
          : [
              {
                id: "agents",
                title: KIN_WORK_ASSIGN.leads,
                displayInline: true,
                subactions: props.assignees.leads.map(choice),
              },
            ]),
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        const to = everyone.find((one) => one.key === event);
        if (props.disabled || to === undefined || to.current || to.invited) return;
        props.onGive(to.principal);
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout label={KIN_DEALS.lookedAfterBy} detail={props.name} />
      </View>
    </Menu>
  );
}

/**
 * The deal's quote, as a row whose menu links one of its client's quotes or None. With none to
 * offer it says so and opens nothing; a linked quote can also be opened from it.
 */
export function KinDealQuoteRow(props: {
  readonly quotes: NonNullable<ReturnType<typeof kinDealQuoteChoices>>;
  readonly disabled: boolean;
  readonly onPick: (key: KinRecordKey | null) => void;
  /** Opens the linked quote; absent in the Edit form. */
  readonly onOpen?: { readonly title: string; readonly open: () => void } | undefined;
}) {
  const { choices, empty } = props.quotes;
  const current = choices.find((one) => one.current)?.label ?? KIN_DEALS.none;
  if (empty !== null) return <ListRowLayout label={KIN_DEALS.quote} detail={empty} />;
  return (
    <Menu
      title={KIN_DEALS.quote}
      accessibilityRole="button"
      accessibilityLabel={`${KIN_DEALS.quote}: ${current}. ${KIN_DEALS.changeQuote}`}
      actions={[
        ...(props.onOpen === undefined
          ? []
          : [{ id: OPEN, title: KIN_DEALS.openQuote(props.onOpen.title) }]),
        ...choices.map((one): MenuAction => ({
          id: one.key ?? NO_QUOTE,
          title: one.label,
          state: one.current ? "on" : "off",
        })),
      ]}
      onPressAction={({ nativeEvent: { event } }) => {
        if (event === OPEN) return props.onOpen?.open();
        const picked = choices.find((one) => (one.key ?? NO_QUOTE) === event);
        if (props.disabled || picked === undefined || picked.current) return;
        props.onPick(picked.key);
      }}
    >
      <View pointerEvents="none">
        <ListRowLayout label={KIN_DEALS.quote} detail={current} />
      </View>
    </Menu>
  );
}
