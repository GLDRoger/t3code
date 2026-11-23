import { kinFailureText } from "./kinAnswers.ts";

/** Settings → Company → Recommendations, the same words on web and phone. */
export const KIN_RECOMMENDATIONS_COPY = {
  title: "Recommendations",
  footer: "Kin suggests a change in Needs you when a setting would end a hold-up it keeps seeing.",
  empty:
    "Nothing suggested yet. When Kin sees the same hold-up again and again and a setting would fix it, it suggests the change here and in Needs you. Nothing changes until you tap.",
  loadFailed: "Couldn't load what Kin suggested.",
  /** Web Settings' page line and empty card. */
  purpose: "What Kin suggested when the same hold-up kept happening, and what came of each.",
  settingsEmpty: "Nothing suggested yet. A new suggestion shows in Needs you first, then here.",
} as const;

/** What went wrong with a row's Ask again, in the host's words where it gave them. */
export function kinRecommendationProblem(cause: unknown): string {
  return kinFailureText(cause, "Couldn't ask again.", {
    gone: "That suggestion isn't there any more.",
  });
}
