import { kinWorkDueLabel } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_PROJECTS } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  kinContactDraftCheck,
  kinProjectDraftCheck,
  type KinContactDraft,
  type KinProjectDraft,
} from "@t3tools/client-runtime/kin/kinWorkForms";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NOT_A_DAY = "Enter a real date.";

/** `YYYY-MM-DD` naming a day the calendar has; `2026-02-30` would otherwise roll into March. */
const realDay = (day: string) => {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = match.slice(1).map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, date));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date
    ? { year }
    : null;
};

export const kinProjectFormCheck = (draft: KinProjectDraft): string | null =>
  kinProjectDraftCheck(draft) ??
  (draft.target !== null && realDay(draft.target) === null ? NOT_A_DAY : null);

export const kinProjectTargetHint = (target: string, now: Date): string => {
  if (!DAY.test(target))
    return `A day as year-month-day. Leave it empty for ${KIN_PROJECTS.noTarget.toLowerCase()}.`;
  const day = realDay(target);
  if (day === null) return NOT_A_DAY;
  const label = kinWorkDueLabel(target, now);
  return day.year === now.getFullYear() ? label : `${label} ${day.year}`;
};

// At least the bar the contact rows set before they offer to mail or call.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_DIGITS = 5;

export const kinContactFormCheck = (draft: KinContactDraft): string | null => {
  const problem = kinContactDraftCheck(draft);
  if (problem !== null) return problem;
  const email = draft.email.trim();
  if (email !== "" && !EMAIL.test(email)) return "Enter an email like name@example.com.";
  const phone = draft.phone.trim();
  if (phone !== "" && phone.replace(/\D/g, "").length < PHONE_DIGITS)
    return `Enter a phone number with at least ${PHONE_DIGITS} digits.`;
  return null;
};
