import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";
import {
  KIN_WATCH_COPY,
  KIN_WATCH_LOG_INTRO,
  KIN_WATCH_LOG_TITLE,
  kinWatchLimitFrom,
  kinWatchLimitLine,
  kinWatchLogDay,
  kinWatchLogRows,
  kinWatchNoneText,
  kinWatchNothingToday,
} from "@t3tools/client-runtime/kin/kinWatches";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinWatchLogLook,
  type KinWatchLogRow,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinWatchLogParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const isRecordKey = Schema.is(KinRecordKey);
const zone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * What Kin checked, from Settings or a watch line: one day at a time, newest first; Earlier adds
 * the day before. The host decides whose looks a reader sees.
 */
export function KinWatchLogScreen({ route }: StaticScreenProps<KinWatchLogParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  // Days added by Earlier, oldest last; today is always first and is the only one that grows.
  const [earlier, setEarlier] = useState<ReadonlyArray<string>>([]);
  const days: ReadonlyArray<string | undefined> = [undefined, ...earlier];
  return (
    <KinWorkFrame title={KIN_WATCH_LOG_TITLE} onBack={() => navigation.goBack()}>
      <Text textRole="footnote" className="px-4 text-foreground-muted">
        {KIN_WATCH_LOG_INTRO}
      </Text>
      {environmentId === null || orgId === null
        ? null
        : days.map((day, index) => (
            <KinWatchLogDay
              key={day ?? "today"}
              environmentId={environmentId}
              orgId={orgId}
              day={day}
              last={index === days.length - 1}
              onEarlier={(next) => setEarlier([...earlier, next])}
            />
          ))}
    </KinWorkFrame>
  );
}

// Each day reads its own page, so a look landing today redraws today's section alone.
function KinWatchLogDay(
  props: KinWorkTarget & {
    readonly day: string | undefined;
    readonly last: boolean;
    readonly onEarlier: (day: string) => void;
  },
) {
  const { environmentId, orgId } = props;
  const navigation = useNavigation();
  const [timeZone] = useState(zone);
  const atom = kinClient.watchLog({
    environmentId,
    input: { orgId, timeZone, ...(props.day === undefined ? {} : { day: props.day }) },
  });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  const now = useNowMinuteMs();
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const open = (look: KinWatchLogLook) => {
    const key = look.recordKey;
    if (key === null || !isRecordKey(key)) return undefined;
    return () =>
      kinIsDealKey(key)
        ? navigation.navigate("KinDeal", { environmentId, orgId, deal: key })
        : navigation.navigate("KinWorkItem", { environmentId, orgId, task: key });
  };
  const title =
    value !== null
      ? kinWatchLogDay(value.day, now)
      : props.day === undefined
        ? "Today"
        : kinWatchLogDay(props.day, now);

  if (value === null)
    return (
      <ListSection title={title}>
        {AsyncResult.isFailure(result) ? (
          <KinLoadFailed
            variant="card"
            title={KIN_WATCH_COPY.unreadable}
            cause={result}
            onRetry={() => appAtomRegistry.refresh(atom)}
          />
        ) : (
          <KinWorkLoading label={KIN_WATCH_LOG_TITLE} />
        )}
      </ListSection>
    );

  const lines = kinWatchLogRows(value.rows);
  const limitFrom = kinWatchLimitFrom(value.rows);
  const none = value.rows.length === 0 && value.watching === 0 && value.earlier === null;
  return (
    <ListSection title={title}>
      {value.rows.length === 0 ? (
        <View className="bg-grouped-card">
          <ListRowLayout
            label={none ? kinWatchNoneText(ownerLevel) : kinWatchNothingToday(value.nextLookAt)}
          />
        </View>
      ) : null}
      {limitFrom === null ? null : (
        <View className="bg-grouped-card">
          <ListRowLayout label={kinWatchLimitLine(limitFrom)} />
        </View>
      )}
      {value.rows.map((row, index) => (
        <KinWatchLogRowView
          key={row._tag === "look" ? row.look.lookId : `fold:${row.folded.at}`}
          row={row}
          line={lines[index] ?? ""}
          open={open}
        />
      ))}
      {props.last && value.earlier !== null ? (
        <ListActionRow
          label={KIN_WATCH_COPY.earlier}
          onPress={() => props.onEarlier(value.earlier!)}
        />
      ) : null}
    </ListSection>
  );
}

/** A look, opening its thing; or a fold of nothing-new looks that opens to its list. */
function KinWatchLogRowView(props: {
  readonly row: KinWatchLogRow;
  readonly line: string;
  readonly open: (look: KinWatchLogLook) => (() => void) | undefined;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const { row } = props;
  if (row._tag === "look")
    return <KinWatchLookRow line={props.line} onPress={props.open(row.look)} />;
  const looks = kinWatchLogRows(row.folded.looks.map((look) => ({ _tag: "look", look }) as const));
  return (
    <>
      <ListActionRow
        label={props.line}
        accessibilityLabel={props.line}
        onPress={() => setUnfolded(!unfolded)}
      />
      {unfolded
        ? row.folded.looks.map((look, index) => (
            <View key={look.lookId} className="ps-6 bg-grouped-card">
              <KinWatchLookRow line={looks[index] ?? ""} onPress={props.open(look)} />
            </View>
          ))
        : null}
    </>
  );
}

function KinWatchLookRow(props: {
  readonly line: string;
  readonly onPress: (() => void) | undefined;
}) {
  return props.onPress === undefined ? (
    <View className="bg-grouped-card">
      <ListRowLayout label={props.line} />
    </View>
  ) : (
    <ListActionRow label={props.line} onPress={props.onPress} />
  );
}
