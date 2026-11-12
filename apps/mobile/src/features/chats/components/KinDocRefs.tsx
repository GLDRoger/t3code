import { useNavigation } from "@react-navigation/native";
import { kinDocRefLabel } from "@t3tools/client-runtime/kin/kinDocs";
import type { EnvironmentId, KinMessageRef } from "@t3tools/contracts";
import { View } from "react-native";

import { Chip } from "../../../components/ui/Chip";
import { cn } from "../../../lib/cn";

/** The doc sections a message points at; each opens the doc there. */
export function KinDocRefs(props: {
  readonly refs: ReadonlyArray<KinMessageRef>;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly own: boolean;
}) {
  const navigation = useNavigation();
  return (
    <View className={cn("max-w-[85%] flex-row flex-wrap gap-1", props.own && "justify-end")}>
      {props.refs.map((ref) => {
        const label = kinDocRefLabel(ref);
        return (
          <Chip
            key={`${ref.key}:${ref.section ?? ""}`}
            size="small"
            icon="doc.text"
            label={label}
            accessibilityLabel={`Open ${label}`}
            onPress={() =>
              navigation.navigate("KinDoc", {
                environmentId: props.environmentId,
                orgId: props.orgId,
                doc: ref.key,
                ...(ref.section === null ? {} : { section: ref.section }),
              })
            }
          />
        );
      })}
    </View>
  );
}
