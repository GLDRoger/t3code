import {
  KIN_ATTENTION,
  kinAsideOf,
  kinAttention,
  kinNotNowUntil,
  kinSetAsideDays,
  kinSnoozeDays,
  type KinAsideRow,
  type KinAttentionOpen,
  type KinAttentionRow,
  type KinAttentionScope,
} from "@t3tools/client-runtime/kin/kinAttention";
import { kinDatesMonth, kinShiftMonth } from "@t3tools/client-runtime/kin/kinDates";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinPulseRead, KinRecordKey } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Chip } from "../../components/ui/Chip";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { useNowMinuteMs } from "../../lib/clock";
import { KinMonthGrid } from "./components/KinMonthGrid";
import { useKinAskAbout, useKinAttention, useKinAttentionHandle } from "./state/useKinAttention";
import type { KinWorkTarget } from "./state/useKinWork";

const kinAttentionNames = (names: KinWorkNames) => new Map([...names.agents, ...names.people]);

type Handler = ReturnType<typeof useKinAttentionHandle>;

const GOT_IT = "got-it";
const NOT_A_PROBLEM = "not-a-problem";
const ASK = "ask";
const SNOOZE = "snooze:";
const SET_ASIDE = "set-aside";
const WHATS_NEXT = "whats-next";
const NOT_NOW = "not-now";

/** "Set aside until…" unfolded under its row: a day it comes back on, or until it is lifted. */
function KinSetAsidePicker(props: {
  readonly names: KinWorkNames;
  readonly onPick: (until: string | undefined) => void;
  readonly onCancel: () => void;
}) {
  const now = new Date(useNowMinuteMs());
  const days = kinSetAsideDays(now);
  const [month, setMonth] = useState(days.initial.slice(0, 7));
  const grid = kinDatesMonth(month, [], props.names, now);
  return (
    <View className="gap-3 bg-grouped-card px-2 py-3">
      <Text className="px-2 text-sm text-foreground-muted">{KIN_ATTENTION.setAsideTitle}</Text>
      <View className="flex-row flex-wrap gap-2 px-2">
        <Chip label={KIN_ATTENTION.untilLifted} onPress={() => props.onPick(undefined)} />
        <Chip label={KIN_ATTENTION.cancel} onPress={props.onCancel} />
      </View>
      <KinMonthGrid
        label={grid.label}
        weeks={grid.weeks}
        selected={null}
        onPick={(day) => {
          if (day >= days.min) props.onPick(day);
        }}
        onShift={(by) => setMonth(kinShiftMonth(month, by))}
      />
    </View>
  );
}

/** One row: tapping it opens the thing itself; its menu holds the answers to it. */
export function KinAttentionItem(
  props: KinWorkTarget & {
    readonly row: KinAttentionRow;
    readonly names: KinWorkNames;
    readonly handler: Handler;
    readonly onOpen: (open: KinAttentionOpen) => void;
  },
) {
  const { row, handler } = props;
  const navigation = useNavigation();
  const [asiding, setAsiding] = useState(false);
  const record = row.record;
  const now = new Date(useNowMinuteMs());
  const asker = useKinAskAbout(props)(row.agentId);
  const ripple = useResolveClassNames("bg-subtle-strong");
  const busy = handler.busy === row.factKey;
  const description =
    row.about === null ? row.detail : `${row.detail.replace(/\.$/, "")} · ${row.about}`;
  const layout = (
    <ListRowLayout
      icon={"exclamationmark.circle"}
      label={row.title}
      description={description}
      disabled={busy}
    />
  );
  return (
    <>
      <View className="flex-row items-center bg-grouped-card">
        <View className="flex-1">
          {row.open.type === "none" ? (
            layout
          ) : (
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`${row.title}, ${description}`}
              onPress={() =>
                // A connection opens on its own screen, whichever screen the row is on.
                row.open.type === "connection"
                  ? navigation.navigate("KinConnection", {
                      environmentId: props.environmentId,
                      orgId: props.orgId,
                      connectionId: row.open.connectionId,
                    })
                  : props.onOpen(row.open)
              }
              android_ripple={{ color: ripple.backgroundColor }}
              unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
            >
              {layout}
            </RowPressable>
          )}
        </View>
        <Menu
          title={row.title}
          accessibilityRole="button"
          accessibilityLabel={`Answer ${row.title}`}
          actions={[
            ...(row.whatsNext === null
              ? []
              : [
                  { id: WHATS_NEXT, title: KIN_ATTENTION.whatsNext, image: "arrow.up.right" },
                  { id: NOT_NOW, title: KIN_ATTENTION.notNow, image: "clock" },
                ]),
            { id: GOT_IT, title: KIN_ATTENTION.gotIt, image: "hand.raised" },
            ...kinSnoozeDays(now).map((choice) => ({
              id: `${SNOOZE}${choice.until}`,
              title: choice.label,
              image: "clock",
            })),
            ...(record === null
              ? []
              : [{ id: SET_ASIDE, title: KIN_ATTENTION.setAside, image: "calendar" }]),
            { id: NOT_A_PROBLEM, title: KIN_ATTENTION.notAProblem, image: "checkmark" },
            ...(asker === null
              ? []
              : [{ id: ASK, title: KIN_ATTENTION.ask(asker.name), image: "bubble.left" }]),
          ]}
          onPressAction={({ nativeEvent: { event } }) => {
            if (busy) return;
            const deal = row.whatsNext;
            if (event === WHATS_NEXT && deal !== null) props.onOpen({ type: "record", key: deal });
            else if (event === NOT_NOW && deal !== null)
              void handler.aside(deal, "set", kinNotNowUntil(now), row.factKey);
            else if (event === GOT_IT) void handler.send(row.factKey, "got_it");
            else if (event === NOT_A_PROBLEM) void handler.send(row.factKey, "not_a_problem");
            else if (event === ASK) asker?.ask(row.askDraft);
            else if (event === SET_ASIDE) setAsiding(true);
            else if (event.startsWith(SNOOZE))
              void handler.send(row.factKey, "got_it", event.slice(SNOOZE.length));
          }}
        >
          <Pressable className="size-11 items-center justify-center me-1" hitSlop={4}>
            <SymbolView
              name="ellipsis.circle"
              size={22}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="regular"
            />
          </Pressable>
        </Menu>
      </View>
      {!asiding || record === null ? null : (
        <KinSetAsidePicker
          names={props.names}
          onCancel={() => setAsiding(false)}
          onPick={(until) => {
            setAsiding(false);
            void handler.aside(record, "set", until, row.factKey);
          }}
        />
      )}
    </>
  );
}

/** What someone already has in hand or set aside, folded away, each with its Undo. */
function KinAttentionHandled(props: {
  readonly rows: ReadonlyArray<KinAttentionRow>;
  readonly asides: ReadonlyArray<KinAsideRow>;
  readonly handler: Handler;
}) {
  const [open, setOpen] = useState(false);
  const count = props.rows.length + props.asides.length;
  if (count === 0) return null;
  return (
    <>
      <ListActionRow
        icon="clock"
        label={`${KIN_ATTENTION.handled} (${count})`}
        onPress={() => setOpen((held) => !held)}
      />
      {open
        ? props.asides.map((row) =>
            row.liftable ? (
              <ListActionRow
                key={row.id}
                label={row.title}
                description={row.detail}
                detail={KIN_ATTENTION.undo}
                loading={props.handler.busy === row.record}
                onPress={() => void props.handler.aside(row.record, "lift")}
              />
            ) : (
              <View key={row.id} className="bg-grouped-card">
                <ListRowLayout label={row.title} description={row.detail} />
              </View>
            ),
          )
        : null}
      {open
        ? props.rows.map((row) => (
            <ListActionRow
              key={row.id}
              label={row.title}
              description={row.handled ?? undefined}
              detail={KIN_ATTENTION.undo}
              loading={props.handler.busy === row.factKey}
              onPress={() => void props.handler.send(row.factKey, "undo")}
            />
          ))
        : null}
    </>
  );
}

/** "Needs attention" on a project, a client or Money: only what is about it; absent when nothing is open or set aside. */
export function KinAttentionSection(
  props: KinWorkTarget & {
    readonly scope: KinAttentionScope;
    readonly names: KinWorkNames;
    readonly onOpen: (open: KinAttentionOpen) => void;
    readonly read?: KinPulseRead | null;
  },
) {
  const own = useKinAttention(props, props.read === undefined, false, props.scope);
  const read = props.read === undefined ? own : props.read;
  const handler = useKinAttentionHandle(props, props.scope);
  const now = new Date(useNowMinuteMs());
  const { open, handled, asides } = kinAttention(read, {
    scope: props.scope,
    names: kinAttentionNames(props.names),
    now,
  });
  if (open.length === 0 && asides.length === 0) return null;
  return (
    <ListSection title={KIN_ATTENTION.title}>
      {open.map((row) => (
        <KinAttentionItem
          key={row.id}
          environmentId={props.environmentId}
          orgId={props.orgId}
          row={row}
          names={props.names}
          handler={handler}
          onOpen={props.onOpen}
        />
      ))}
      <KinAttentionHandled rows={handled} asides={asides} handler={handler} />
      {handler.problem === null ? null : (
        <Text className="px-4 py-2 text-sm text-danger-foreground">{handler.problem}</Text>
      )}
    </ListSection>
  );
}

/**
 * One quiet row on a client's, project's, entry's or deal's own screen while it is set aside, with
 * Undo for whoever may lift it. Nothing when it isn't, or the host can't say.
 */
export function KinAsideNote(
  props: KinWorkTarget & { readonly record: KinRecordKey; readonly names: KinWorkNames },
) {
  const read = useKinAttention(props);
  const handler = useKinAttentionHandle(props);
  const now = new Date(useNowMinuteMs());
  const row = kinAsideOf(read, props.record, { names: kinAttentionNames(props.names), now });
  if (row === null) return null;
  return (
    <ListSection>
      {row.liftable ? (
        <ListActionRow
          icon="clock"
          label={row.detail}
          detail={KIN_ATTENTION.undo}
          loading={handler.busy === row.record}
          onPress={() => void handler.aside(row.record, "lift")}
        />
      ) : (
        <View className="bg-grouped-card">
          <ListRowLayout icon="clock" label={row.detail} />
        </View>
      )}
      {handler.problem === null ? null : (
        <Text className="px-4 py-2 text-sm text-danger-foreground">{handler.problem}</Text>
      )}
    </ListSection>
  );
}
