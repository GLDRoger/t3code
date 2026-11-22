import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_HOST_COPY,
  kinBackUpLine,
  kinFreeSpaceLine,
  kinHostFailed,
  kinHostPageView,
  kinRetryLine,
  type KinHostPageView,
} from "@t3tools/client-runtime/kin/kinHostCare";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinGateView, KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { kinClient, refreshKinHost } from "./state/kinClient";
import { KinHostTroubleCard } from "./widgets/KinHostTroubleCard";
import { useKinGate } from "./state/useKinHost";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinHostParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** Settings › Kin's computer on the phone: the same glance and the same four taps as on web. */
export function KinHostScreen({ route }: StaticScreenProps<KinHostParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null)
    return (
      <KinWorkFrame title={KIN_HOST_COPY.title} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" title={KIN_HOST_COPY.title} detail={KIN_HOST_COPY.unreadable} />
      </KinWorkFrame>
    );
  return <Permitted environmentId={environmentId} orgId={orgId} />;
}

function Permitted(props: KinWorkTarget) {
  const navigation = useNavigation();
  const gate = useKinGate(
    kinClient.hostFreeSpace.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const result = useAtomValue(kinClient.hostStatus(query));
  const now = useNowMinuteMs();
  const refresh = () => refreshKinHost(props.environmentId, props.orgId);
  const back = () => navigation.goBack();
  if (gate !== null)
    return (
      <KinWorkFrame title={KIN_HOST_COPY.title} onBack={back}>
        <KinGateView gate={gate} refused={KIN_HOST_COPY.onlyOwner} label={KIN_HOST_COPY.title} />
      </KinWorkFrame>
    );
  const status = Option.getOrNull(AsyncResult.value(result));
  if (status === null)
    return (
      <KinWorkFrame title={KIN_HOST_COPY.title} onBack={back}>
        {AsyncResult.isFailure(result) ? (
          <KinLoadFailed title={KIN_HOST_COPY.unreadable} cause={null} onRetry={refresh} />
        ) : (
          <KinWorkLoading label={KIN_HOST_COPY.title} />
        )}
      </KinWorkFrame>
    );
  return (
    <KinWorkFrame
      title={KIN_HOST_COPY.title}
      onBack={back}
      refresh={{ accessibilityLabel: "Refresh", onPress: refresh }}
    >
      <Host target={props} view={kinHostPageView(status, now)} onChanged={refresh} />
    </KinWorkFrame>
  );
}

type Tap = { readonly busy: boolean; readonly line: string | null; readonly failed: boolean };
const IDLE: Tap = { busy: false, line: null, failed: false };

function useTap<A>(
  run: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
  line: (value: A) => string,
  after: () => void,
) {
  const [tap, setTap] = useState<Tap>(IDLE);
  const go = async () => {
    if (tap.busy) return;
    setTap({ busy: true, line: null, failed: false });
    const result = await run();
    after();
    setTap(
      AsyncResult.isSuccess(result)
        ? { busy: false, line: line(result.value), failed: false }
        : {
            busy: false,
            line: kinHostFailed(
              AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
            ),
            failed: true,
          },
    );
  };
  return { tap, go };
}

function TapLine(props: { readonly tap: Tap }) {
  return props.tap.line === null ? null : (
    <Text
      textRole="caption"
      accessibilityRole={props.tap.failed ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      className={
        props.tap.failed ? "font-t3-medium text-danger-foreground" : "text-foreground-muted"
      }
    >
      {props.tap.line}
    </Text>
  );
}

function Line(props: {
  readonly title: string;
  readonly detail?: string | null;
  readonly tone?: "warn" | "error";
}) {
  return (
    <View className="min-h-14 justify-center gap-1 px-4 py-3">
      <Text
        textRole="body"
        className={cn(
          props.tone === "error"
            ? "text-danger-foreground"
            : props.tone === "warn"
              ? "text-warning-foreground"
              : "text-foreground",
        )}
      >
        {props.title}
      </Text>
      {props.detail == null ? null : (
        <Text className="text-sm text-foreground-muted">{props.detail}</Text>
      )}
    </View>
  );
}

const BAR: Record<"ok" | "low" | "out", string> = {
  ok: "bg-primary",
  low: "bg-warning-foreground",
  out: "bg-danger-foreground",
};

function Host(props: {
  readonly target: KinWorkTarget;
  readonly view: KinHostPageView;
  readonly onChanged: () => void;
}) {
  const { view, target, onChanged } = props;
  const query = { environmentId: target.environmentId, input: { orgId: target.orgId } };
  const freeSpace = useAtomCommand(kinClient.hostFreeSpace, { reportFailure: false });
  const backUp = useAtomCommand(kinClient.hostBackUpNow, { reportFailure: false });
  const retry = useAtomCommand(kinClient.hostRetry, { reportFailure: false });
  const free = useTap(() => freeSpace(query), kinFreeSpaceLine, onChanged);
  const backup = useTap(() => backUp(query), kinBackUpLine, onChanged);
  const again = useTap(() => retry(query), kinRetryLine, onChanged);
  const { space } = view;
  return (
    <>
      {/* Every open trouble with its own taps, whether or not a notice reached a chat. */}
      {view.failing.length === 0 ? null : (
        <View className="gap-2">
          {view.failing.map((failing) => (
            <KinHostTroubleCard
              key={failing.key}
              widget={{ ...failing.widget, orgId: target.orgId }}
              environmentId={target.environmentId}
            />
          ))}
        </View>
      )}
      <ListSection title={KIN_HOST_COPY.space}>
        {space === null ? (
          <Line title={KIN_HOST_COPY.noSpaceReading} />
        ) : (
          <View className="gap-3 px-4 py-3">
            <Text
              textRole="body"
              className={cn(
                space.level === "out"
                  ? "text-danger-foreground"
                  : space.level === "low"
                    ? "text-warning-foreground"
                    : "text-foreground",
              )}
            >
              {space.level === "ok"
                ? space.line
                : `${space.level === "out" ? KIN_HOST_COPY.out : KIN_HOST_COPY.low}: ${space.line}`}
            </Text>
            <View
              accessibilityRole="progressbar"
              accessibilityLabel={space.line}
              accessibilityValue={{ min: 0, max: 100, now: Math.round(space.used * 100) }}
              className="h-1.5 w-full overflow-hidden rounded-full bg-subtle-strong"
            >
              <View
                className={cn("h-full rounded-full", BAR[space.level])}
                style={{ width: `${Math.round(space.used * 100)}%` }}
              />
            </View>
            {space.parts.map((part) => (
              <View key={part.name} className="flex-row justify-between gap-4">
                <Text className="text-sm text-foreground-muted">{part.name}</Text>
                <Text className="text-sm text-foreground">{part.value}</Text>
              </View>
            ))}
            {space.partsNote === null ? null : (
              <Text className="text-sm text-foreground-muted">{space.partsNote}</Text>
            )}
            <TapLine tap={free.tap} />
            {view.canFreeSpace ? (
              <Button
                size="compact"
                tone="outline"
                label={KIN_HOST_COPY.freeSpace}
                loading={free.tap.busy}
                onPress={() => void free.go()}
              />
            ) : null}
          </View>
        )}
      </ListSection>

      {view.backup === null ? null : (
        <ListSection title={KIN_HOST_COPY.backups}>
          <View className="gap-3 px-4 py-3">
            <Text
              textRole="body"
              className={
                view.backup.problem !== null || view.backup.title === KIN_HOST_COPY.noBackupYet
                  ? "text-warning-foreground"
                  : "text-foreground"
              }
            >
              {view.backup.title}
            </Text>
            {view.backup.problem === null ? null : (
              <Text className="text-sm text-foreground-muted">
                {[view.backup.problem, view.backup.detail].filter(Boolean).join(": ")}
              </Text>
            )}
            <TapLine tap={backup.tap} />
            {view.backup.canBackUp ? (
              <Button
                size="compact"
                tone="outline"
                label={KIN_HOST_COPY.backUp}
                loading={backup.tap.busy}
                onPress={() => void backup.go()}
              />
            ) : null}
          </View>
        </ListSection>
      )}

      <ListSection title={KIN_HOST_COPY.agents}>
        <Line
          title={view.running}
          detail={view.failing.length === 0 ? KIN_HOST_COPY.nothingFailing : null}
        />
        {view.canRetry || again.tap.line !== null ? (
          <View className="gap-3 px-4 py-3">
            <TapLine tap={again.tap} />
            {view.canRetry ? (
              <Button
                size="compact"
                tone="outline"
                label={KIN_HOST_COPY.retry}
                loading={again.tap.busy}
                onPress={() => void again.go()}
              />
            ) : null}
          </View>
        ) : null}
      </ListSection>

      <ListSection title={KIN_HOST_COPY.about}>
        <Line title={KIN_HOST_COPY.version} detail={view.version} />
        <Line title={KIN_HOST_COPY.restarted} detail={view.restarted} />
      </ListSection>
    </>
  );
}
