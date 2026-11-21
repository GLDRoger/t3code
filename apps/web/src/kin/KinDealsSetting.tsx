import {
  KIN_DEALS,
  KIN_DEAL_QUIET,
  KIN_DEAL_STAGES,
  kinDealQuietProblem,
  kinDealStagesProblem,
} from "@t3tools/client-runtime/kin/kinDeals";
import type { KinDealStagesResult } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrophyIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { KinLoadFailed, KinWorkRowSkeletons } from "./KinWorkParts";
import { useKinDealQuietDaysSet, useKinDealStages, useKinDealStagesSet } from "./useKinDeals";
import { useKinHost } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** Settings → Deals: the company's stages, with Won and Lost as fixed ends. */
export function KinDealsSetting() {
  const target = kinNewLeadTarget(useKinHost());
  const searchableSetting = useSearchableSetting();
  return target === null ? null : (
    <SettingsSection {...searchableSetting("kin-deals")} hideTitle>
      <KinDealStagesSettings {...target} />
    </SettingsSection>
  );
}

export function KinDealStagesSettings(props: KinWorkTarget) {
  const { state, refresh } = useKinDealStages(props);
  if (state._tag === "loading")
    return (
      <div role="status" aria-label="Loading stages">
        <KinWorkRowSkeletons />
      </div>
    );
  if (state._tag !== "ready")
    return (
      <KinLoadFailed
        what={KIN_DEALS.stagesFailed}
        cause={state._tag === "failed" ? state.cause : null}
        onRetry={refresh}
      />
    );
  // A fresh draft for each version of the stages, so a save from elsewhere shows at once.
  return <StagesEditor key={state.value.rev} {...props} held={state.value} />;
}

interface Row {
  readonly id: string | null;
  readonly name: string;
  /** A stable React key for a row not saved yet. */
  readonly key: string;
}

function StagesEditor(props: KinWorkTarget & { readonly held: KinDealStagesResult }) {
  const { held } = props;
  const save = useKinDealStagesSet(props);
  const [rows, setRows] = useState<ReadonlyArray<Row>>(() =>
    held.stages.map((stage) => ({ id: stage.id, name: stage.name, key: stage.id })),
  );
  const [moveTo, setMoveTo] = useState<Readonly<Record<string, string>>>({});
  const [removing, setRemoving] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  const header = (
    <div className="flex flex-col gap-1">
      <h2 className="text-base font-medium text-foreground">{KIN_DEAL_STAGES.title}</h2>
      {held.can ? <p className="text-sm text-muted-foreground">{KIN_DEAL_STAGES.detail}</p> : null}
    </div>
  );

  if (!held.can)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <section aria-label={KIN_DEAL_STAGES.stages} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{KIN_DEAL_STAGES.stages}</h3>
          <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {held.stages.map((stage) => (
              <li key={stage.id} className="px-3 py-2 text-sm">
                {stage.name}
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">{KIN_DEAL_STAGES.readOnly}</p>
        </section>
        <Ends />
        <QuietDays {...props} held={held} />
      </div>
    );

  const invalid = kinDealStagesProblem(rows.map((row) => row.name));
  const dirty =
    Object.keys(moveTo).length > 0 ||
    rows.length !== held.stages.length ||
    rows.some(
      (row, index) =>
        row.id !== held.stages[index]?.id || row.name.trim() !== held.stages[index]?.name,
    );
  const shift = (index: number, step: -1 | 1) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row === undefined) return current;
      next.splice(index + step, 0, row);
      return next;
    });
  const remove = (row: Row, to: string | null) => {
    setRows((current) => current.filter((held) => held.key !== row.key));
    if (row.id !== null && to !== null) {
      const id = row.id;
      setMoveTo((current) => ({ ...current, [id]: to }));
    }
    setRemoving(null);
  };
  const submit = async () => {
    if (invalid !== null || !dirty) return;
    setBusy(true);
    setProblem(null);
    const outcome = await save({
      rev: held.rev,
      stages: rows.map((row) => ({
        ...(row.id === null ? {} : { id: row.id }),
        name: row.name.trim(),
      })),
      ...(Object.keys(moveTo).length === 0 ? {} : { moveTo }),
    });
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {header}
      <section aria-label={KIN_DEAL_STAGES.stages} className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{KIN_DEAL_STAGES.stages}</h3>
        <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((row, index) => {
            const open = row.id === null ? 0 : (held.open[row.id] ?? 0);
            return (
              <li key={row.key} className="flex items-center gap-2 px-2 py-1.5">
                <Input
                  aria-label={`${KIN_DEAL_STAGES.stageName} ${index + 1}`}
                  className="min-w-0 flex-1"
                  maxLength={40}
                  autoFocus={row.id === null}
                  value={row.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setRows((current) =>
                      current.map((held) => (held.key === row.key ? { ...held, name } : held)),
                    );
                  }}
                />
                {row.id === null ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {KIN_DEAL_STAGES.openDeals(open)}
                  </span>
                )}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`${KIN_DEAL_STAGES.up}: ${row.name}`}
                  disabled={index === 0}
                  onClick={() => shift(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`${KIN_DEAL_STAGES.down}: ${row.name}`}
                  disabled={index === rows.length - 1}
                  onClick={() => shift(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-destructive"
                  disabled={rows.length === 1}
                  onClick={() => (open === 0 ? remove(row, null) : setRemoving(row))}
                >
                  {KIN_DEAL_STAGES.remove}
                </Button>
              </li>
            );
          })}
          {rows.length >= 12 ? null : (
            <li className="px-2 py-1.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setAdded((count) => count + 1);
                  setRows((current) => [...current, { id: null, name: "", key: `new-${added}` }]);
                }}
              >
                <PlusIcon />
                {KIN_DEAL_STAGES.add}
              </Button>
            </li>
          )}
        </ol>
        <p className="text-xs text-muted-foreground">{KIN_DEAL_STAGES.hint}</p>
      </section>
      <Ends />
      {invalid === null || !dirty ? null : (
        <p className="text-sm text-destructive-foreground">{invalid}</p>
      )}
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !dirty || invalid !== null}
          aria-busy={busy}
        >
          {KIN_DEAL_STAGES.save}
        </Button>
      </div>
      <QuietDays {...props} held={held} />
      {removing === null ? null : (
        <RemoveStage
          row={removing}
          open={removing.id === null ? 0 : (held.open[removing.id] ?? 0)}
          others={rows.filter((row) => row.key !== removing.key && row.id !== null)}
          onRemove={(to) => remove(removing, to)}
          onClose={() => setRemoving(null)}
        />
      )}
    </form>
  );
}

/** "A deal goes quiet after N days": the owner level sets it; everyone else reads it. */
function QuietDays(props: KinWorkTarget & { readonly held: KinDealStagesResult }) {
  const days = props.held.quietDays;
  const save = useKinDealQuietDaysSet(props);
  const [text, setText] = useState(days === undefined ? "" : String(days));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (days === undefined) return null;
  const invalid = kinDealQuietProblem(text);
  const submit = async () => {
    if (invalid !== null || Number(text) === days) return;
    setBusy(true);
    setProblem(null);
    const outcome = await save(Number(text));
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
  };
  return (
    <section aria-label={KIN_DEAL_QUIET.title} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_DEAL_QUIET.title}</h3>
      {props.held.can ? (
        // A form of its own inside the stages' form would nest; this saves on its own button.
        <div className="flex items-center gap-2">
          <Input
            type="number"
            nativeInput
            min={1}
            max={365}
            className="w-24"
            aria-label={KIN_DEAL_QUIET.label}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          <span className="text-sm text-muted-foreground">{KIN_DEAL_QUIET.unit(text)}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || invalid !== null || Number(text) === days}
            aria-busy={busy}
            onClick={() => void submit()}
          >
            {KIN_DEAL_QUIET.save}
          </Button>
        </div>
      ) : (
        <p className="text-sm">{KIN_DEAL_QUIET.days(days)}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {props.held.can
          ? KIN_DEAL_QUIET.detail
          : `${KIN_DEAL_QUIET.detail} ${KIN_DEAL_QUIET.readOnly}`}
      </p>
      {invalid !== null && props.held.can && text !== "" ? (
        <p className="text-sm text-destructive-foreground">{invalid}</p>
      ) : null}
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function Ends() {
  return (
    <section aria-label={KIN_DEAL_STAGES.ends} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_DEAL_STAGES.ends}</h3>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-sm">
        <li className="flex items-center gap-2 px-3 py-2">
          <TrophyIcon aria-hidden className="size-4 text-success-foreground" />
          Won
          <span className="ms-auto text-xs text-muted-foreground">{KIN_DEAL_STAGES.wonHint}</span>
        </li>
        <li className="flex items-center gap-2 px-3 py-2">
          <XIcon aria-hidden className="size-4 text-destructive-foreground" />
          Lost
          <span className="ms-auto text-xs text-muted-foreground">{KIN_DEAL_STAGES.lostHint}</span>
        </li>
      </ul>
    </section>
  );
}

/** Removing a stage with open deals asks where they go; nothing is stranded. */
function RemoveStage(props: {
  readonly row: Row;
  readonly open: number;
  readonly others: ReadonlyArray<Row>;
  readonly onRemove: (to: string) => void;
  readonly onClose: () => void;
}) {
  const [to, setTo] = useState<string | null>(props.others[0]?.id ?? null);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{KIN_DEAL_STAGES.removeTitle(props.row.name)}</DialogTitle>
          <DialogDescription>{KIN_DEAL_STAGES.removeDetail(props.open)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Select value={to ?? ""} onValueChange={(value) => setTo(String(value))}>
              <SelectTrigger aria-label="Move them to" className="w-full min-w-0">
                <SelectValue>{props.others.find((row) => row.id === to)?.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {props.others.map((row) =>
                  row.id === null ? null : (
                    <SelectItem key={row.key} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ),
                )}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">{KIN_DEAL_STAGES.removeNote}</p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={to === null}
            onClick={() => to !== null && props.onRemove(to)}
          >
            {KIN_DEAL_STAGES.removeConfirm(props.open)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
