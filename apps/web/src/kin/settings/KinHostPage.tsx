import { useAtomValue } from "@effect/atom-react";
import {
  KIN_HOST_COPY,
  kinBackUpLine,
  kinFreeSpaceLine,
  kinHostFailed,
  kinHostPageView,
  kinRetryLine,
  type KinHostSpaceView,
} from "@t3tools/client-runtime/kin/kinHostCare";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient, refreshKinHost } from "../kinClient";
import { useNowMinuteMs } from "../useKinClock";
import {
  KinSettingsFacts,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./KinSettingsLayout";
import type { KinSettingsTarget } from "./kinSettingsTarget";

type Tap = { readonly busy: boolean; readonly done: string | null; readonly failed: string | null };
const IDLE: Tap = { busy: false, done: null, failed: null };

/**
 * One fixed operation's tap: busy while it runs, then its result line or the failure. A second tap
 * while one runs does nothing; the host makes a repeat harmless anyway.
 */
function useHostTap<A>(
  run: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
  line: (value: A) => string,
  after: () => void,
) {
  const [tap, setTap] = useState<Tap>(IDLE);
  const go = async () => {
    if (tap.busy) return;
    setTap({ busy: true, done: null, failed: null });
    const result = await run();
    after();
    setTap(
      AsyncResult.isSuccess(result)
        ? { busy: false, done: line(result.value), failed: null }
        : {
            busy: false,
            done: null,
            failed: kinHostFailed(
              AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
            ),
          },
    );
  };
  return { tap, go };
}

/** Settings › Kin's computer, for the owner and co-owners. A teammate's read is refused: nothing. */
export function KinHostPage(props: KinSettingsTarget) {
  const canRead = useAtomValue(kinClient.hostFreeSpace.permissionAtom(props.environmentId));
  return canRead ? <HostPage {...props} /> : null;
}

function HostPage(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const result = useAtomValue(kinClient.hostStatus(query));
  const refresh = () => refreshKinHost(props.environmentId, props.orgId);
  const freeSpace = useAtomCommand(kinClient.hostFreeSpace, { reportFailure: false });
  const backUp = useAtomCommand(kinClient.hostBackUpNow, { reportFailure: false });
  const retry = useAtomCommand(kinClient.hostRetry, { reportFailure: false });
  const free = useHostTap(() => freeSpace(query), kinFreeSpaceLine, refresh);
  const backup = useHostTap(() => backUp(query), kinBackUpLine, refresh);
  const again = useHostTap(() => retry(query), kinRetryLine, refresh);
  const status = Option.getOrNull(AsyncResult.value(result));
  const now = useNowMinuteMs();

  if (status === null)
    return (
      <KinSettingsPage purpose={KIN_HOST_COPY.purpose}>
        <KinSettingsSection title={KIN_HOST_COPY.space}>
          {AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={refresh}>
              {KIN_HOST_COPY.unreadable}
            </KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={3} />
          )}
        </KinSettingsSection>
      </KinSettingsPage>
    );

  const view = kinHostPageView(status, now);
  return (
    <KinSettingsPage purpose={KIN_HOST_COPY.purpose}>
      <KinSettingsSection
        title={KIN_HOST_COPY.space}
        action={
          view.canFreeSpace ? (
            <TapButton tap={free.tap} busyLabel={KIN_HOST_COPY.freeing} onTap={free.go}>
              {KIN_HOST_COPY.freeSpace}
            </TapButton>
          ) : undefined
        }
        problem={free.tap.failed}
      >
        {view.space === null ? (
          <KinSettingsRow title={KIN_HOST_COPY.noSpaceReading} wrap />
        ) : (
          <SpaceBlock space={view.space} done={free.tap.done} />
        )}
      </KinSettingsSection>

      {view.backup === null ? null : (
        <KinSettingsSection
          title={KIN_HOST_COPY.backups}
          action={
            view.backup.canBackUp ? (
              <TapButton tap={backup.tap} busyLabel={KIN_HOST_COPY.backingUp} onTap={backup.go}>
                {KIN_HOST_COPY.backUp}
              </TapButton>
            ) : undefined
          }
          problem={backup.tap.failed}
        >
          <KinSettingsRow
            title={view.backup.title}
            detail={backup.tap.done ?? view.backup.detail}
            wrap={!view.backup.canBackUp}
            status={
              view.backup.problem === null ? (
                view.backup.canBackUp && view.backup.title === KIN_HOST_COPY.noBackupYet ? (
                  <KinSettingsStatus tone="attention">
                    {KIN_HOST_COPY.noBackupYet}
                  </KinSettingsStatus>
                ) : null
              ) : (
                <KinSettingsStatus tone="attention">{view.backup.problem}</KinSettingsStatus>
              )
            }
          />
        </KinSettingsSection>
      )}

      <KinSettingsSection
        title={KIN_HOST_COPY.agents}
        action={
          view.canRetry ? (
            <TapButton tap={again.tap} busyLabel={KIN_HOST_COPY.retrying} onTap={again.go}>
              {KIN_HOST_COPY.retry}
            </TapButton>
          ) : undefined
        }
        problem={again.tap.failed}
      >
        <KinSettingsRow
          title={view.running}
          detail={
            again.tap.done ?? (view.failing.length === 0 ? KIN_HOST_COPY.nothingFailing : null)
          }
        />
        {view.failing.map((failing) => (
          <KinSettingsRow
            key={failing.key}
            title={failing.title}
            detail={failing.detail}
            status={<KinSettingsStatus tone="error">{KIN_HOST_COPY.failing}</KinSettingsStatus>}
          />
        ))}
      </KinSettingsSection>

      <KinSettingsSection title={KIN_HOST_COPY.about}>
        <KinSettingsFacts
          facts={[
            { label: KIN_HOST_COPY.version, value: view.version },
            { label: KIN_HOST_COPY.restarted, value: view.restarted },
          ]}
        />
      </KinSettingsSection>
    </KinSettingsPage>
  );
}

function TapButton(props: {
  readonly tap: Tap;
  readonly busyLabel: string;
  readonly onTap: () => void;
  readonly children: string;
}) {
  return (
    <Button size="xs" variant="outline" disabled={props.tap.busy} onClick={props.onTap}>
      {props.tap.busy ? props.busyLabel : props.children}
    </Button>
  );
}

const BAR: Record<KinHostSpaceView["level"], string> = {
  ok: "bg-primary",
  low: "bg-warning",
  out: "bg-destructive",
};

function SpaceBlock(props: { readonly space: KinHostSpaceView; readonly done: string | null }) {
  const { space } = props;
  const percent = Math.round(space.used * 100);
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground tabular-nums">{space.line}</span>
        {space.level === "ok" ? null : (
          <Badge variant={space.level === "out" ? "error" : "warning"}>
            {space.level === "out" ? KIN_HOST_COPY.out : KIN_HOST_COPY.low}
          </Badge>
        )}
      </div>
      <div
        role="meter"
        aria-label={space.line}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", BAR[space.level])}
          style={{ width: `${percent}%` }}
        />
      </div>
      {space.parts.length === 0 ? (
        space.partsNote === null ? null : (
          <p className="text-xs text-muted-foreground">{space.partsNote}</p>
        )
      ) : (
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          {space.parts.map((part) => (
            <div key={part.name} className="contents">
              <dt className="text-muted-foreground">{part.name}</dt>
              <dd className="text-end text-foreground tabular-nums">{part.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {props.done === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {props.done}
        </p>
      )}
    </div>
  );
}
