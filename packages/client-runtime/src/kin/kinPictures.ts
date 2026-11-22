// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  formatKinPicturesDay,
  formatKinWhen,
  KinConnectionKey,
  type KinOrgId,
  type KinPicturesSetInput,
  type KinPicturesView,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { kinFailureText } from "./kinAnswers.ts";
import { KIN_DAILY_LIMIT } from "./kinBudget.ts";

/** Settings → Connections → Pictures: the picture service's key, the monthly limit, the count. */
export const KIN_PICTURES_COPY = {
  title: "Pictures",
  intro:
    "Agents make photo-like pictures with a picture service you pay for, whenever someone asks in a chat, a teammate included. Each one counts toward this month's limit. Without a key, agents still design pictures such as posters, quote cards and infographics.",
  connectTitle: "Connect a picture service",
  connectDetail: (service: string) =>
    `Paste ${/^[aeiou]/i.test(service) ? "an" : "a"} ${service} API key. It goes to your Kin's computer and is never shown again.`,
  keyLabel: "API key",
  newKeyLabel: "New API key",
  saveKey: "Save key",
  keyPlaceholder: "Paste the key",
  openService: (service: string) => `Open ${service}`,
  connect: "Connect",
  connecting: "Connecting…",
  keySaved: (day: string) => `Key saved ${day}`,
  limitLabel: "Monthly limit",
  perMonth: (count: number) => `${count} a month`,
  // The same words as the daily limit's No limit.
  noLimit: KIN_DAILY_LIMIT.none,
  used: (used: number, limit: number, resetsOn: string) =>
    `${used} of ${limit} this month, resets on ${resetsOn}`,
  usedNoLimit: (used: number) => `${used} this month · No limit`,
  noLimitTitle: "Set no monthly limit?",
  noLimitDetail:
    "With no limit, Kin never stops pictures for cost. You can see this month's count here and set a limit again any time.",
  noLimitConfirm: KIN_DAILY_LIMIT.noneAsk.confirm,
  disconnect: "Disconnect",
  disconnectTitle: "Disconnect the picture service?",
  disconnectDetail:
    "Kin forgets the key, and agents can't make generated pictures until one is saved again. This month's count stays.",
  cancel: "Cancel",
  loadFailed: "Couldn't load the picture service",
  loading: "Loading…",
  noKey: "Paste the key to connect.",
} as const;

/** The limits Settings offers, besides No limit and whatever is set now. */
const KIN_PICTURES_LIMITS = [10, 25, 50, 100, 250, 500] as const;

export type KinPicturesLimitChoice = {
  readonly value: number | null;
  readonly label: string;
  readonly selected: boolean;
};

export interface KinPicturesRows {
  readonly connected: boolean;
  readonly service: string;
  readonly keyUrl: string;
  /** "Key saved 20 Nov"; null with no key. */
  readonly keyLine: string | null;
  /** "12 of 50 this month, resets on 1 Dec", or "12 this month · No limit". */
  readonly usage: string;
  readonly limit: number | null;
  readonly limitLabel: string;
  readonly choices: ReadonlyArray<KinPicturesLimitChoice>;
}

const limitLabel = (limit: number | null) =>
  limit === null ? KIN_PICTURES_COPY.noLimit : KIN_PICTURES_COPY.perMonth(limit);

/**
 * The limit choices, No limit first as the daily limit offers it, the one set now among them;
 * `selected` may be a not-yet-saved pick.
 */
export function kinPicturesChoices(selected: number | null): ReadonlyArray<KinPicturesLimitChoice> {
  const values: Array<number> = [...KIN_PICTURES_LIMITS];
  if (selected !== null && !values.includes(selected)) values.push(selected);
  values.sort((a, b) => a - b);
  return [null, ...values].map((value) => ({
    value,
    label: limitLabel(value),
    selected: value === selected,
  }));
}

/** What the section shows, in the reader's zone; `resetsOn` is a calendar day, not an instant. */
export function kinPicturesRows(
  view: KinPicturesView,
  options: { readonly locale?: string; readonly zone?: string } = {},
): KinPicturesRows {
  const resetsOn = formatKinPicturesDay(view.resetsOn, options.locale);
  return {
    connected: view.connected,
    service: view.vendor.label,
    keyUrl: view.vendor.keyUrl,
    keyLine:
      view.savedAt === null
        ? null
        : KIN_PICTURES_COPY.keySaved(
            formatKinWhen(Date.parse(view.savedAt), "date", {
              zone: options.zone,
              locale: options.locale,
            }),
          ),
    usage:
      view.monthlyLimit === null
        ? KIN_PICTURES_COPY.usedNoLimit(view.usedThisMonth)
        : KIN_PICTURES_COPY.used(view.usedThisMonth, view.monthlyLimit, resetsOn),
    limit: view.monthlyLimit,
    limitLabel: limitLabel(view.monthlyLimit),
    choices: kinPicturesChoices(view.monthlyLimit),
  };
}

type Sent = Promise<AtomCommandResult<KinPicturesView, unknown>>;
export type KinPicturesOutcome =
  | { readonly ok: true; readonly value: KinPicturesView }
  | { readonly ok: false; readonly problem: string };

const makeKey = Schema.decodeSync(KinConnectionKey);

/** The owner level's picture changes, each answered in plain words. The key travels once, redacted. */
export function createKinPicturesActions(options: {
  readonly orgId: KinOrgId;
  readonly set: (input: KinPicturesSetInput) => Sent;
  readonly reload: () => void;
}) {
  const { orgId } = options;
  const send = async (input: KinPicturesSetInput, doing: string): Promise<KinPicturesOutcome> => {
    const result = await options.set(input);
    options.reload();
    return AsyncResult.isSuccess(result)
      ? { ok: true, value: result.value }
      : {
          ok: false,
          problem: kinFailureText(squashAtomCommandFailure(result), `Couldn't ${doing}.`, {
            device: `This device isn't allowed to ${doing}.`,
          }),
        };
  };
  return {
    connect: (key: string, monthlyLimit: number | null) => {
      const trimmed = key.trim();
      if (trimmed === "")
        return Promise.resolve({ ok: false, problem: KIN_PICTURES_COPY.noKey } as const);
      return send({ orgId, key: makeKey(trimmed), monthlyLimit }, "save the key");
    },
    setLimit: (monthlyLimit: number | null) => send({ orgId, monthlyLimit }, "change the limit"),
    disconnect: () => send({ orgId, disconnect: true }, "disconnect the picture service"),
  };
}
