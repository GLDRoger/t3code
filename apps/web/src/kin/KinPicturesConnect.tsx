import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  createKinPicturesActions,
  KIN_PICTURES_COPY as COPY,
  kinPicturesChoices,
  kinPicturesRows,
  type KinPicturesOutcome,
} from "@t3tools/client-runtime/kin/kinPictures";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import { useKinOwnerLevel } from "./useKinOwnerLevel";

const NONE = "none";
const toValue = (limit: number | null) => (limit === null ? NONE : String(limit));
const fromValue = (value: string) => (value === NONE ? null : Number.parseInt(value, 10));

/** Settings → Connections → Pictures, for the owner and co-owners only. */
export function KinPicturesConnect(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  return useKinOwnerLevel(props.environmentId) ? <PicturesSection {...props} /> : null;
}

function PicturesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const viewAtom = kinClient.pictures({ environmentId, input: { orgId } });
  const result = useAtomValue(viewAtom);
  const reload = useAtomRefresh(viewAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const set = useAtomCommand(kinClient.picturesSet, { reportFailure: false });
  const actions = createKinPicturesActions({
    orgId,
    set: (input) => set({ environmentId, input }),
    reload,
  });
  const ids = { key: useId(), limit: useId() };
  const [key, setKey] = useState("");
  // The connect form's pick; null until the person changes it from the view's.
  const [pick, setPick] = useState<{ readonly limit: number | null } | null>(null);
  const [asking, setAsking] = useState<"no_limit" | "disconnect" | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = view === null ? null : kinPicturesRows(view);
  const formLimit = pick === null ? (view?.monthlyLimit ?? null) : pick.limit;

  const run = async (sent: Promise<KinPicturesOutcome>) => {
    setBusy(true);
    setProblem(null);
    const outcome = await sent;
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
    return outcome.ok;
  };
  const chooseLimit = (value: string) => {
    const limit = fromValue(value);
    if (limit === null) return setAsking("no_limit");
    if (rows?.connected === true) void run(actions.setLimit(limit));
    else setPick({ limit });
  };
  const limitSelect = (selected: number | null) => (
    <Select
      items={kinPicturesChoices(selected).map((choice) => ({
        value: toValue(choice.value),
        label: choice.label,
      }))}
      value={toValue(selected)}
      onValueChange={(value) => {
        if (typeof value === "string") chooseLimit(value);
      }}
    >
      <SelectTrigger id={ids.limit} aria-label={COPY.limitLabel} disabled={busy}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {kinPicturesChoices(selected).map((choice) => (
          <SelectItem key={toValue(choice.value)} value={toValue(choice.value)}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );

  return (
    <>
      <SettingsSection title={COPY.title}>
        {rows === null ? (
          AsyncResult.isFailure(result) ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-sm text-destructive-foreground">{COPY.loadFailed}</p>
              <Button size="xs" variant="outline" onClick={reload}>
                {KIN_RETRY}
              </Button>
            </div>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">{COPY.loading}</p>
          )
        ) : rows.connected ? (
          <>
            <SettingsRow
              title={rows.keyLine}
              description={rows.usage}
              control={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setAsking("disconnect")}
                >
                  {COPY.disconnect}
                </Button>
              }
            />
            <SettingsRow title={COPY.limitLabel} control={limitSelect(rows.limit)} />
          </>
        ) : (
          <>
            <SettingsRow
              title={COPY.connectTitle}
              description={COPY.intro}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  render={<a href={rows.keyUrl} target="_blank" rel="noopener noreferrer" />}
                >
                  {COPY.openService(rows.service)}
                </Button>
              }
            />
            <form
              className="flex flex-col gap-3 px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(actions.connect(key, formLimit)).then((ok) => {
                  if (!ok) return;
                  setKey("");
                  setPick(null);
                });
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.key}>{COPY.keyLabel}</Label>
                <Input
                  id={ids.key}
                  type="password"
                  value={key}
                  placeholder={COPY.keyPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setKey(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">{COPY.connectDetail(rows.service)}</p>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.limit}>{COPY.limitLabel}</Label>
                  {limitSelect(formLimit)}
                </div>
                <Button type="submit" disabled={busy || key.trim() === ""} aria-busy={busy}>
                  {busy ? COPY.connecting : COPY.connect}
                </Button>
              </div>
            </form>
          </>
        )}
        {problem === null ? null : (
          <div className="px-4 pb-3">
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          </div>
        )}
      </SettingsSection>
      <KinConfirm
        ask={
          asking === "no_limit"
            ? { title: COPY.noLimitTitle, detail: COPY.noLimitDetail, action: COPY.noLimit }
            : asking === "disconnect"
              ? {
                  title: COPY.disconnectTitle,
                  detail: COPY.disconnectDetail,
                  action: COPY.disconnect,
                  destructive: true,
                }
              : null
        }
        onConfirm={() => {
          const confirmed = asking;
          setAsking(null);
          if (confirmed === "disconnect") void run(actions.disconnect());
          else if (rows?.connected === true) void run(actions.setLimit(null));
          else setPick({ limit: null });
        }}
        onClose={() => setAsking(null)}
      />
    </>
  );
}
