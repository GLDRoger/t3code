import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CURRENCY,
  kinInvoiceCurrency,
  kinRateInput,
  kinRateLine,
  kinSettled,
  type KinRateDraft,
  type KinRates,
} from "@t3tools/client-runtime/kin/kinCurrency";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import type { KinCompanyProfile, KinRecordDetail } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useId, useState } from "react";

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
import { Label } from "../components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import { useKinCompanyProfile } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";
import { KinLoadFailed } from "./KinWorkParts";

/** "about ₹x" in a quieter style; a click says what rate and day it is from. */
export function KinEstimateText(props: {
  readonly text: string;
  readonly basis: string | ReadonlyArray<string>;
  readonly className?: string;
}) {
  const basis = typeof props.basis === "string" ? [props.basis] : props.basis;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${props.text}${props.text.includes(KIN_CURRENCY.estimate.toLowerCase()) ? "" : `, ${KIN_CURRENCY.estimate.toLowerCase()}`}. Show the rate`}
            className={cn(
              "rounded-sm text-xs text-muted-foreground tabular-nums underline decoration-dotted underline-offset-2 outline-none ring-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset",
              props.className,
            )}
          />
        }
      >
        {props.text}
      </PopoverTrigger>
      <PopoverPopup width="sm" padding="compact">
        <div className="flex flex-col gap-1.5 text-xs">
          <p className="font-medium text-foreground">{KIN_CURRENCY.estimate}</p>
          {basis.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
          <p className="text-muted-foreground">{KIN_CURRENCY.exactStays}</p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** "Set a rate for USD": no estimate shows without one, so this is the way to get it. */
export function KinSetRateButton(
  props: KinWorkTarget & {
    readonly currencies: ReadonlyArray<string>;
    readonly label?: string;
    /** A rate to start from, such as the one a bank row implied. */
    readonly start?: KinRateDraft;
  },
) {
  const allowed = useAtomValue(kinClient.companyProfileSet.permissionAtom(props.environmentId));
  const [open, setOpen] = useState(false);
  const first = props.currencies[0];
  if (!allowed || first === undefined) return null;
  return (
    <>
      <Button size="xs" variant="link" onClick={() => setOpen(true)}>
        {props.label ?? `${KIN_CURRENCY.setRate} for ${props.currencies.join(" and ")}`}
      </Button>
      {open ? (
        <KinRatesDialog
          {...props}
          start={props.start ?? { currency: first, rate: "", asOf: todayDay() }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");
const todayDay = () => {
  const now = kinNow();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** The owner's exchange rates: each currency's rate and the day it is from, one set or removed at a time. */
export function KinRatesDialog(
  props: KinWorkTarget & { readonly start?: KinRateDraft; readonly onClose: () => void },
) {
  const profile = useKinCompanyProfile(props, true);
  const { state } = profile;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{KIN_CURRENCY.rates}</DialogTitle>
          <DialogDescription>{KIN_CURRENCY.ratesDetail}</DialogDescription>
        </DialogHeader>
        {state._tag === "ready" ? (
          <KinRatesForm
            {...props}
            profile={state.value}
            start={props.start ?? { currency: "USD", rate: "", asOf: todayDay() }}
          />
        ) : (
          <DialogPanel>
            {state._tag === "loading" ? (
              <div role="status" aria-label="Loading rates" className="flex flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <KinLoadFailed
                what={KIN_CURRENCY.ratesFailed}
                cause={state._tag === "failed" ? state.cause : null}
                onRetry={profile.refresh}
              />
            )}
          </DialogPanel>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function KinRatesForm(
  props: KinWorkTarget & {
    readonly profile: KinCompanyProfile;
    readonly start: KinRateDraft;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, profile } = props;
  const ids = { currency: useId(), rate: useId(), asOf: useId() };
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const [draft, setDraft] = useState<KinRateDraft>(() => {
    const held = profile.rates.find((one) => one.currency === props.start.currency);
    return props.start.rate === "" && held !== undefined ? { ...held } : props.start;
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const send = async (next: KinRateDraft, remove: boolean) => {
    const made = kinRateInput(orgId, profile, next, remove);
    if ("problem" in made) return setProblem(made.problem);
    setBusy(true);
    setProblem(null);
    setSaved(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input: made.input }),
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    setSaved(
      remove
        ? `Removed the ${next.currency} rate.`
        : `Saved the ${next.currency.toUpperCase()} rate.`,
    );
  };
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void send(draft, false);
      }}
    >
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          {saved === null ? null : (
            <p role="status" className="text-xs text-muted-foreground">
              {saved}
            </p>
          )}
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {KIN_CURRENCY.homeCurrency}: {profile.homeCurrency}
            </h3>
            {profile.rates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{KIN_CURRENCY.noRates}</p>
            ) : (
              <ul className="flex flex-col">
                {profile.rates.map((rate) => (
                  <li
                    key={rate.currency}
                    className="flex items-center gap-2 border-b border-border/60 py-1 last:border-b-0"
                  >
                    <button
                      type="button"
                      aria-label={`Change the ${rate.currency} rate`}
                      onClick={() => setDraft({ ...rate })}
                      className="flex min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                    >
                      <span className="text-sm text-foreground">{rate.currency}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {kinRateLine(rate, profile.homeCurrency)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void send(rate, true)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">{KIN_CURRENCY.setRate}</h3>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.currency}>Currency</Label>
                <Input
                  id={ids.currency}
                  value={draft.currency}
                  maxLength={3}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft({ ...draft, currency: event.target.value.toUpperCase() })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.rate}>
                  {profile.homeCurrency} for 1 {draft.currency || "unit"}
                </Label>
                <Input
                  id={ids.rate}
                  value={draft.rate}
                  inputMode="decimal"
                  placeholder="84.25"
                  autoComplete="off"
                  onChange={(event) => setDraft({ ...draft, rate: event.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.asOf}>{KIN_CURRENCY.asOf}</Label>
              <Input
                id={ids.asOf}
                type="date"
                value={draft.asOf}
                onChange={(event) => setDraft({ ...draft, asOf: event.target.value })}
              />
            </div>
          </section>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
          Done
        </Button>
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {KIN_CURRENCY.save}
        </Button>
      </DialogFooter>
    </form>
  );
}

const noBankAtom: ReturnType<typeof kinClient.workItem> = Atom.make(AsyncResult.initial());

/**
 * A foreign-currency invoice's currency, said at the top, with what it is about worth at home and,
 * once a bank row settled it, the rupees that actually came in and how far they were from the estimate.
 */
export function KinInvoiceCurrency(
  props: KinWorkTarget & {
    readonly item: Pick<KinRecordDetail, "amount" | "links">;
    readonly rates: KinRates | null;
    readonly settled: boolean;
  },
) {
  const { environmentId, orgId, rates } = props;
  const view = kinInvoiceCurrency(props.item, rates);
  const bankAtom =
    view?.bank == null
      ? noBankAtom
      : kinClient.workItem({ environmentId, input: { orgId, key: view.bank } });
  const bank = Option.getOrNull(AsyncResult.value(useAtomValue(bankAtom)));
  if (view === null || props.item.amount === undefined) return null;
  const bankDay = bank?.dateAt?.slice(0, 10) ?? null;
  const settled =
    bank?.amount === undefined || bankDay === null
      ? null
      : kinSettled(props.item.amount, bank.amount, bankDay, rates);
  return (
    <div className="flex flex-col items-start gap-1 rounded-lg border border-border/70 px-3 py-2">
      <p className="text-sm font-medium text-foreground">{view.label}</p>
      {view.estimate === null ? (
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="text-xs text-muted-foreground">
            {KIN_CURRENCY.noRate(view.currency)}
          </span>
          <KinSetRateButton {...props} currencies={[view.currency]} />
        </div>
      ) : (
        <KinEstimateText text={`Total ${view.estimate.text}`} basis={view.estimate.basis} />
      )}
      {settled === null ? (
        props.settled ? (
          <p className="text-xs text-muted-foreground">
            {KIN_CURRENCY.paidUnlinked(view.currency, view.home)}
          </p>
        ) : null
      ) : (
        <div className="flex flex-col items-start gap-0.5 pt-1">
          <p className="text-xs text-foreground">
            Received {settled.received}, {settled.implied}.
          </p>
          {settled.difference === null ? null : (
            <p className="text-xs text-muted-foreground">{settled.difference}</p>
          )}
          <KinSetRateButton
            {...props}
            currencies={[view.currency]}
            label={KIN_CURRENCY.rateForEstimates}
            start={settled.impliedRate}
          />
        </div>
      )}
    </div>
  );
}
