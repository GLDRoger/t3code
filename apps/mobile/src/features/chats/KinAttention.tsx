import {
  KIN_ATTENTION,
  kinAttention,
  kinSnoozeDays,
  type KinAttentionOpen,
  type KinAttentionRow,
  type KinAttentionScope,
} from "@t3tools/client-runtime/kin/kinAttention";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinPulseRead } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { useNowMinuteMs } from "../../lib/clock";
import { useKinAskAbout, useKinAttention, useKinAttentionHandle } from "./state/useKinAttention";
import type { KinWorkTarget } from "./state/useKinWork";

const kinAttentionNames = (names: KinWorkNames) => new Map([...names.agents, ...names.people]);

type Handler = ReturnType<typeof useKinAttentionHandle>;

const GOT_IT = "got-it";
const NOT_A_PROBLEM = "not-a-problem";
const ASK = "ask";
const SNOOZE = "snooze:";

/** One row: tapping it opens the thing itself; its menu holds the answers to it. */
function KinAttentionItem(
  props: KinWorkTarget & {
    readonly row: KinAttentionRow;
    readonly handler: Handler;
    readonly onOpen: (open: KinAttentionOpen) => void;
  },
) {
  const { row, handler } = props;
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
    <View className="flex-row items-center bg-grouped-card">
      <View className="flex-1">
        {row.open.type === "none" ? (
          layout
        ) : (
          <RowPressable
            accessibilityRole="button"
            accessibilityLabel={`${row.title}, ${description}`}
            onPress={() => props.onOpen(row.open)}
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
          { id: GOT_IT, title: KIN_ATTENTION.gotIt, image: "hand.raised" },
          ...kinSnoozeDays(now).map((choice) => ({
            id: `${SNOOZE}${choice.until}`,
            title: choice.label,
            image: "clock",
          })),
          { id: NOT_A_PROBLEM, title: KIN_ATTENTION.notAProblem, image: "checkmark" },
          ...(asker === null
            ? []
            : [{ id: ASK, title: KIN_ATTENTION.ask(asker.name), image: "bubble.left" }]),
        ]}
        onPressAction={({ nativeEvent: { event } }) => {
          if (busy) return;
          if (event === GOT_IT) void handler.send(row.factKey, "got_it");
          else if (event === NOT_A_PROBLEM) void handler.send(row.factKey, "not_a_problem");
          else if (event === ASK) asker?.ask(row.askDraft);
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
  );
}

/** What someone already has in hand, folded away, each with its Undo. */
function KinAttentionHandled(props: {
  readonly rows: ReadonlyArray<KinAttentionRow>;
  readonly handler: Handler;
}) {
  const [open, setOpen] = useState(false);
  if (props.rows.length === 0) return null;
  return (
    <>
      <ListActionRow
        icon="clock"
        label={`${KIN_ATTENTION.handled} (${props.rows.length})`}
        onPress={() => setOpen((held) => !held)}
      />
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

/** "Needs attention" on a project, a client or Money: only what is about it, absent when nothing. */
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
  const { open, handled } = kinAttention(read, {
    scope: props.scope,
    names: kinAttentionNames(props.names),
    now,
  });
  if (open.length === 0) return null;
  return (
    <ListSection title={KIN_ATTENTION.title}>
      {open.map((row) => (
        <KinAttentionItem
          key={row.id}
          environmentId={props.environmentId}
          orgId={props.orgId}
          row={row}
          handler={handler}
          onOpen={props.onOpen}
        />
      ))}
      <KinAttentionHandled rows={handled} handler={handler} />
      {handler.problem === null ? null : (
        <Text className="px-4 py-2 text-sm text-danger-foreground">{handler.problem}</Text>
      )}
    </ListSection>
  );
}
