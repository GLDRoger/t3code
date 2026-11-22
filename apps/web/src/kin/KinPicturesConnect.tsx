import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
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
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import {
  KinSettingsChoice,
  KinSettingsField,
  KinSettingsFormDialog,
} from "./settings/KinSettingsControls";
import {
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";
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

/** The limit as one choice; No limit asks first, as the daily limit does. */
function LimitChoice(props: {
  readonly value: number | null;
  readonly disabled: boolean;
  readonly onChange: (limit: number | null) => void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <KinSettingsChoice
        label={COPY.limitLabel}
        value={toValue(props.value)}
        disabled={props.disabled}
        options={kinPicturesChoices(props.value).map((choice) => ({
          value: toValue(choice.value),
          label: choice.label,
        }))}
        onChange={(value) => {
          const limit = fromValue(value);
          if (limit === null) setAsking(true);
          else props.onChange(limit);
        }}
      />
      <KinConfirm
        ask={
          asking
            ? { title: COPY.noLimitTitle, detail: COPY.noLimitDetail, action: COPY.noLimitConfirm }
            : null
        }
        onConfirm={() => {
          setAsking(false);
          props.onChange(null);
        }}
        onClose={() => setAsking(false)}
      />
    </>
  );
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
  const [open, setOpen] = useState<"connect" | "key" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = view === null ? null : kinPicturesRows(view);

  const run = async (sent: Promise<KinPicturesOutcome>) => {
    setBusy(true);
    setProblem(null);
    const outcome = await sent;
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
    return outcome.ok;
  };

  return (
    <>
      <KinSettingsSection
        title={COPY.title}
        description={COPY.intro}
        problem={open === null ? problem : null}
      >
        {rows === null ? (
          AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={reload}>{COPY.loadFailed}</KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={2} />
          )
        ) : rows.connected ? (
          <>
            <KinSettingsRow
              title={rows.service}
              detail={rows.keyLine}
              openLabel={`${COPY.keyLabel}: ${rows.service}`}
              onOpen={() => {
                setProblem(null);
                setOpen("key");
              }}
            />
            <KinSettingsRow
              title={COPY.limitLabel}
              detail={rows.usage}
              control={
                <LimitChoice
                  value={rows.limit}
                  disabled={busy}
                  onChange={(limit) => void run(actions.setLimit(limit))}
                />
              }
            />
          </>
        ) : (
          <KinSettingsRow
            title={COPY.connectTitle}
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setProblem(null);
                  setOpen("connect");
                }}
              >
                {COPY.connect}
              </Button>
            }
          />
        )}
      </KinSettingsSection>
      {rows !== null && open !== null ? (
        <KeyDialog
          rows={rows}
          replacing={open === "key"}
          busy={busy}
          problem={problem}
          onDisconnect={() => setDisconnecting(true)}
          onSubmit={(key, limit) =>
            void run(actions.connect(key, limit)).then((ok) => {
              if (ok) setOpen(null);
            })
          }
          onClose={() => {
            setProblem(null);
            setOpen(null);
          }}
        />
      ) : null}
      <KinConfirm
        ask={
          disconnecting
            ? {
                title: COPY.disconnectTitle,
                detail: COPY.disconnectDetail,
                action: COPY.disconnect,
                destructive: true,
              }
            : null
        }
        onConfirm={() => {
          setDisconnecting(false);
          void run(actions.disconnect()).then((ok) => {
            if (ok) setOpen(null);
          });
        }}
        onClose={() => setDisconnecting(false)}
      />
    </>
  );
}

/** Paste a key: the first one with its limit, or a new one in place of the saved key. */
function KeyDialog(props: {
  readonly rows: ReturnType<typeof kinPicturesRows>;
  readonly replacing: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onDisconnect: () => void;
  readonly onSubmit: (key: string, limit: number | null) => void;
  readonly onClose: () => void;
}) {
  const { rows } = props;
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState(rows.limit);
  return (
    <KinSettingsFormDialog
      title={props.replacing ? rows.service : COPY.connectTitle}
      description={props.replacing ? (rows.keyLine ?? undefined) : COPY.connectDetail(rows.service)}
      submitLabel={props.replacing ? COPY.saveKey : COPY.connect}
      busy={props.busy}
      notReady={key.trim() === "" ? COPY.noKey : null}
      problem={props.problem}
      typed={key !== ""}
      remove={
        props.replacing ? (
          <Button
            type="button"
            variant="ghost-destructive"
            disabled={props.busy}
            onClick={props.onDisconnect}
          >
            {COPY.disconnect}
          </Button>
        ) : undefined
      }
      secondary={
        <Button
          type="button"
          variant="ghost"
          render={<a href={rows.keyUrl} target="_blank" rel="noopener noreferrer" />}
        >
          {COPY.openService(rows.service)}
        </Button>
      }
      onSubmit={() => props.onSubmit(key, props.replacing ? rows.limit : limit)}
      onClose={props.onClose}
    >
      <KinSettingsField
        label={props.replacing ? COPY.newKeyLabel : COPY.keyLabel}
        help={props.replacing ? COPY.connectDetail(rows.service) : undefined}
      >
        {({ control }) => (
          <Input
            id={control}
            type="password"
            value={key}
            placeholder={COPY.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />
        )}
      </KinSettingsField>
      {props.replacing ? null : (
        <KinSettingsField label={COPY.limitLabel}>
          {() => <LimitChoice value={limit} disabled={props.busy} onChange={setLimit} />}
        </KinSettingsField>
      )}
    </KinSettingsFormDialog>
  );
}
