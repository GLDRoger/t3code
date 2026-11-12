import { kinWorkDueLabel } from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_CONTACT_PHONE_DIGITS,
  KIN_PROJECTS,
  kinContactEmailOk,
  kinContactPhoneOk,
} from "@t3tools/client-runtime/kin/kinWorkClients";
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
  if (match === null) return false;
  const [year, month, date] = match.slice(1).map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, date));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date;
};

export const kinProjectFormCheck = (draft: KinProjectDraft): string | null =>
  kinProjectDraftCheck(draft) ??
  (draft.target !== null && !realDay(draft.target) ? NOT_A_DAY : null);

export const kinProjectTargetHint = (target: string, now: Date): string => {
  if (!DAY.test(target))
    return `A day as year-month-day. Leave it empty for ${KIN_PROJECTS.noTarget.toLowerCase()}.`;
  return realDay(target) ? kinWorkDueLabel(target, now) : NOT_A_DAY;
};

export const kinContactFormCheck = (draft: KinContactDraft): string | null => {
  const problem = kinContactDraftCheck(draft);
  if (problem !== null) return problem;
  const email = draft.email.trim();
  if (email !== "" && !kinContactEmailOk(email)) return "Enter an email like name@example.com.";
  const phone = draft.phone.trim();
  if (phone !== "" && !kinContactPhoneOk(phone))
    return `Enter a phone number with at least ${KIN_CONTACT_PHONE_DIGITS} digits.`;
  return null;
};
