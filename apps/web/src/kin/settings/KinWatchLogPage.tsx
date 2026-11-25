import { useAtomValue } from "@effect/atom-react";
import {
  KIN_WATCH_COPY,
  KIN_WATCH_LOG_INTRO,
  kinWatchLimitFrom,
  kinWatchLimitLine,
  kinWatchLogDay,
  kinWatchLogRows,
  kinWatchNoneText,
  kinWatchNothingToday,
} from "@t3tools/client-runtime/kin/kinWatches";
import { KinRecordKey, type KinWatchLogLook, type KinWatchLogRow } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { kinClient } from "../kinClient";
import { kinRecordPlace } from "../kinPlaces";
import { useNowMinuteMs } from "../useKinClock";
import { useKinOwnerLevel } from "../useKinOwnerLevel";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsShowAll,
} from "./KinSettingsLayout";
import type { KinSettingsTarget } from "./kinSettingsTarget";

const isRecordKey = Schema.is(KinRecordKey);
const zone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Settings → What Kin checked: one day at a time, newest first; Earlier adds the day before. The
 * host decides whose looks a reader sees, so a teammate's page holds only their own things.
 */
export function KinWatchLogPage(props: KinSettingsTarget) {
  // Days added by Earlier, oldest last; today is always first and is the only one that grows.
  const [earlier, setEarlier] = useState<ReadonlyArray<string>>([]);
  const days: ReadonlyArray<string | undefined> = [undefined, ...earlier];
  return (
    <KinSettingsPage purpose={KIN_WATCH_LOG_INTRO}>
      {days.map((day, index) => (
        <KinWatchLogDay
          key={day ?? "today"}
          {...props}
          day={day}
          last={index === days.length - 1}
          onEarlier={(next) => setEarlier([...earlier, next])}
        />
      ))}
    </KinSettingsPage>
  );
}

// Each day reads its own page, so a look landing today redraws today's card alone.
function KinWatchLogDay(
  props: KinSettingsTarget & {
    readonly day: string | undefined;
    readonly last: boolean;
    readonly onEarlier: (day: string) => void;
  },
) {
  const { environmentId, orgId } = props;
  const [timeZone] = useState(zone);
  const atom = kinClient.watchLog({
    environmentId,
    input: { orgId, timeZone, ...(props.day === undefined ? {} : { day: props.day }) },
  });
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  const now = useNowMinuteMs();
  const ownerLevel = useKinOwnerLevel(environmentId);
  const navigate = useNavigate();
  const open = (look: KinWatchLogLook) => {
    const key = look.recordKey;
    if (key === null || !isRecordKey(key)) return {};
    const kind = look.kind === "invoice_paid" ? ("entry" as const) : ("task" as const);
    return {
      onOpen: () =>
        void navigate({ ...kinRecordPlace({ key, kind }), params: { environmentId, orgId } }),
    };
  };
  const title =
    value !== null
      ? kinWatchLogDay(value.day, now)
      : props.day === undefined
        ? "Today"
        : kinWatchLogDay(props.day, now);

  if (value === null)
    return (
      <KinSettingsSection title={title}>
        {AsyncResult.isFailure(result) ? (
          <KinSettingsLoadFailed onRetry={() => appAtomRegistry.refresh(atom)}>
            {KIN_WATCH_COPY.unreadable}
          </KinSettingsLoadFailed>
        ) : (
          <KinSettingsLoading rows={4} />
        )}
      </KinSettingsSection>
    );

  const lines = kinWatchLogRows(value.rows);
  const limitFrom = kinWatchLimitFrom(value.rows);
  const none = value.rows.length === 0 && value.watching === 0 && value.earlier === null;
  return (
    <KinSettingsSection title={title}>
      {value.rows.length === 0 ? (
        <KinSettingsEmpty>
          {none ? kinWatchNoneText(ownerLevel) : kinWatchNothingToday(value.nextLookAt)}
        </KinSettingsEmpty>
      ) : null}
      {limitFrom === null ? null : (
        <KinSettingsEmpty>{kinWatchLimitLine(limitFrom)}</KinSettingsEmpty>
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
        <KinSettingsShowAll
          label={KIN_WATCH_COPY.earlier}
          onShow={() => props.onEarlier(value.earlier!)}
        />
      ) : null}
    </KinSettingsSection>
  );
}

/** A look, linked to its thing; or a fold of nothing-new looks that opens to its list. */
function KinWatchLogRowView(props: {
  readonly row: KinWatchLogRow;
  readonly line: string;
  readonly open: (look: KinWatchLogLook) => { readonly onOpen?: () => void };
}) {
  const [unfolded, setUnfolded] = useState(false);
  const { row } = props;
  if (row._tag === "look")
    return <KinSettingsRow wrap title={props.line} {...props.open(row.look)} />;
  const looks = kinWatchLogRows(row.folded.looks.map((look) => ({ _tag: "look", look }) as const));
  return (
    <>
      <KinSettingsRow wrap title={props.line} onOpen={() => setUnfolded(!unfolded)} />
      {unfolded ? (
        <div className="divide-y divide-border/50 ps-6">
          {row.folded.looks.map((look, index) => (
            <KinSettingsRow
              key={look.lookId}
              wrap
              title={<span className="font-normal">{looks[index]}</span>}
              {...props.open(look)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
