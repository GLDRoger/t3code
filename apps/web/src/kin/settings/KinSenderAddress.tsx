import type { kinBankSenderAddressSegments } from "@t3tools/client-runtime/kin/kinBankSenders";

/** A sender's address whole, its domain stronger, breaking only after an @ or a dot. */
export function KinSenderAddress(props: {
  readonly segments: ReturnType<typeof kinBankSenderAddressSegments>;
}) {
  return (
    <span>
      {props.segments.map((segment) => (
        // Each piece wraps as one unit, so the line breaks after an @ or a dot, never mid-label.
        <span
          key={segment.start}
          className={`inline-block max-w-full ${segment.domain ? "font-semibold text-foreground" : "font-normal text-muted-foreground"}`}
        >
          {segment.text}
        </span>
      ))}
    </span>
  );
}
