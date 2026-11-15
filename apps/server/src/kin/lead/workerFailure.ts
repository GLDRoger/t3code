import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

const MAX_DIAGNOSTIC_CHARS = 160;
const EXIT = /\bexited with code (\d{1,3})\b/;

/** Token-shaped strings and private paths out of a diagnostic headed for the lead's prompt. */
const redactDiagnostic = (text: string) =>
  text
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(
      /\b(?:gh[pousr]|github_pat|sk|xox[abpr]|AKIA|glpat)[-_]?[A-Za-z0-9_-]{12,}/g,
      "[redacted]",
    )
    .replace(/\b(?:token|key|secret|password|authorization)\b\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]")
    .replace(/(?:\/Users|\/home|\/root|[A-Z]:\\Users)[^\s'"`]*/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What ended a worker run that left no report: the provider's failure class, the exit code when
 * it gave one, which step failed, and a short diagnostic with credentials and paths taken out.
 */
export const failureSentence = (
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
  runId: string,
  lastError: string | null,
) => {
  const item = projection.turnItems.findLast(
    (candidate) =>
      candidate.type === "error" && candidate.status === "failed" && candidate.runId === runId,
  );
  const failure = item?.type === "error" ? item.failure : undefined;
  const message = (failure?.message ?? lastError ?? "").trim();
  if (message === "") return "";
  const exit = EXIT.exec(message)?.[1];
  const diagnostic = Array.from(redactDiagnostic(message)).slice(0, MAX_DIAGNOSTIC_CHARS).join("");
  return ` Failure: ${failure?.class ?? "unknown"}${exit === undefined ? "" : `, exit code ${exit}`}, ${failure === undefined ? "before its first turn" : "during its run"}. What Kin saw: ${diagnostic}`;
};
