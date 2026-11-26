import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";
import {
  KIN_FOLLOW_UP_COPY,
  KIN_WATCH_COPY,
  KIN_WATCH_LOG_INTRO,
  KIN_WATCH_LOG_TITLE,
  kinWatchLimitFrom,
  kinWatchLimitLine,
  kinWatchLogDay,
  kinWatchLogRows,
  kinWatchEmptyLine,
  kinFollowUpView,
} from "@t3tools/client-runtime/kin/kinWatches";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { useKinIsOwnerLevel } from "./state/kinChatOnly";
import { kinClient } from "./state/kinClient";
import { useKinHostAt } from "./state/useKinHost";
import { useKinWorkZone, type KinWorkTarget } from "./state/useKinWork";

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
      {environmentId === null || orgId === null ? null : (
        <KinFollowUps environmentId={environmentId} orgId={orgId} />
      )}
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

/** The one-time follow-ups agents promised, each with Stop for whoever may stop it. None: no part. */
function KinFollowUps(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const atom = kinClient.followUps({ environmentId, input: { orgId } });
  const result = useAtomValue(atom);
  const ownerLevel = useKinIsOwnerLevel(environmentId);
  const host = useKinHostAt(environmentId);
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  );
  const { zone } = useKinWorkZone(props);
  const mayStop = useAtomValue(kinClient.stopFollowUp.permissionAtom(environmentId));
  const stop = useAtomCommand(kinClient.stopFollowUp, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const followUps = Option.getOrNull(AsyncResult.value(result))?.followUps ?? null;

  if (followUps === null)
    return AsyncResult.isFailure(result) ? (
      <ListSection title={KIN_FOLLOW_UP_COPY.title}>
        <KinLoadFailed
          variant="card"
          title={KIN_FOLLOW_UP_COPY.unreadable}
          cause={result}
          onRetry={() => appAtomRegistry.refresh(atom)}
        />
      </ListSection>
    ) : null;
  if (followUps.length === 0) return null;

  const onStop = async (itemId: (typeof followUps)[number]["itemId"]) => {
    if (busy !== null) return;
    setBusy(itemId);
    setProblem(null);
    const done = await stop({ environmentId, input: { orgId, itemId } });
    setBusy(null);
    if (!AsyncResult.isSuccess(done))
      setProblem(kinFailureText(squashAtomCommandFailure(done), KIN_FOLLOW_UP_COPY.failed));
    appAtomRegistry.refresh(atom);
  };
  return (
    <ListSection title={KIN_FOLLOW_UP_COPY.title}>
      {followUps.map((followUp) => {
        const view = kinFollowUpView(
          followUp,
          { ownerLevel, personId },
          zone === null ? {} : { zone },
        );
        return (
          <View key={view.itemId} className="bg-grouped-card">
            <ListRowLayout
              label={view.title}
              description={view.lines.join(" ")}
              accessory={
                view.stop && mayStop ? (
                  <Button
                    tone="outline"
                    size="compact"
                    label={KIN_FOLLOW_UP_COPY.stop}
                    accessibilityLabel={KIN_FOLLOW_UP_COPY.stopFor(view.title)}
                    loading={busy === view.itemId}
                    disabled={busy !== null && busy !== view.itemId}
                    onPress={() => void onStop(followUp.itemId)}
                  />
                ) : undefined
              }
            />
          </View>
        );
      })}
      {problem === null ? null : (
        <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {problem}
        </Text>
      )}
    </ListSection>
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
  const followUps =
    Option.getOrNull(
      AsyncResult.value(useAtomValue(kinClient.followUps({ environmentId, input: { orgId } }))),
    )?.followUps.length ?? 0;
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
  return (
    <ListSection title={title}>
      {value.rows.length === 0 ? (
        <View className="bg-grouped-card">
          <ListRowLayout label={kinWatchEmptyLine(value, { ownerLevel, followUps })} />
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
