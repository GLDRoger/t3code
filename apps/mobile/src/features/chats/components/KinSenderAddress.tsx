import type { kinBankSenderAddressSegments } from "@t3tools/client-runtime/kin/kinBankSenders";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";

/** A sender's address whole, its domain stronger, read out as one address. */
export function KinSenderAddress(props: {
  readonly address: string;
  readonly segments: ReturnType<typeof kinBankSenderAddressSegments>;
}) {
  return (
    // One text per piece in a wrapping row: the line breaks only after an @ or a dot, where a
    // single text would also break at a hyphen inside the domain.
    <View accessible accessibilityLabel={props.address} className="flex-row flex-wrap">
      {props.segments.map((segment) => (
        <Text
          key={segment.start}
          textRole="body"
          className={
            segment.domain
              ? "max-w-full font-t3-semibold text-foreground"
              : "max-w-full text-foreground-muted"
          }
        >
          {segment.text}
        </Text>
      ))}
    </View>
  );
}
