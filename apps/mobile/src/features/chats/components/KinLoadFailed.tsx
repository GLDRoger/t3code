import { KIN_RETRY, kinFailure, kinRetryText } from "@t3tools/client-runtime/kin/kinAnswers";

import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ListActionRow } from "../../../components/ui/ListActionRow";

/**
 * A read that failed, said as `kinFailure` says it: a Retry only when the request got no answer
 * or Kin is busy, else the host's reason with nothing to retry.
 */
export function KinLoadFailed(props: {
  /** What failed, as a heading: "Couldn't load this list". */
  readonly title: string;
  /** The failure: an error, a Cause or a failed AsyncResult; unknown reads as the connection. */
  readonly cause: unknown;
  readonly onRetry: () => void;
  readonly variant?: "card" | "plain";
}) {
  const failure = kinFailure(props.cause, "");
  return (
    <EmptyState
      variant={props.variant ?? "plain"}
      title={props.title}
      detail={failure.text.trim()}
      {...(failure.retry
        ? { action: <Button tone="secondary" label={KIN_RETRY} onPress={props.onRetry} /> }
        : {})}
    />
  );
}

/** The same answer as one row of a list section: tap to retry only when retrying can help. */
export function KinLoadFailedRow(props: {
  readonly title: string;
  readonly cause: unknown;
  readonly onRetry: () => void;
}) {
  const failure = kinFailure(props.cause, `${props.title}.`);
  return (
    <ListActionRow
      label={failure.retry ? kinRetryText(`${props.title}.`) : failure.text}
      tone="danger"
      disabled={!failure.retry}
      onPress={props.onRetry}
    />
  );
}
