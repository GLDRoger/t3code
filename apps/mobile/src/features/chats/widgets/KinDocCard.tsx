import { useNavigation } from "@react-navigation/native";
import { KIN_DOCS, kinDocCardLine, type KinDocCardView } from "@t3tools/client-runtime/kin/kinDocs";
import type { EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { useNowMinuteMs } from "../../../lib/clock";

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** A doc an agent wrote or changed: what it is, what changed, and the way to read either. */
export const KinDocCard = memo(function KinDocCard(props: {
  readonly doc: KinDocCardView;
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  readonly agentNames?: ReadonlyMap<string, string>;
}) {
  const { doc } = props;
  const navigation = useNavigation();
  const line = kinDocCardLine(doc, props.agentNames ?? NO_NAMES, new Date(useNowMinuteMs()));
  const where = { environmentId: props.environmentId, orgId: props.orgId, doc: doc.key };
  const open = () => navigation.navigate("KinDoc", where);
  const { previousVersion } = doc;
  const changes =
    previousVersion === null
      ? null
      : () =>
          navigation.navigate("KinDocChanges", {
            ...where,
            to: String(doc.version),
            from: String(previousVersion),
          });
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Doc: ${doc.title}. ${line.text}`}
      accessibilityHint="Opens the doc."
      accessibilityActions={[
        { name: "activate", label: "Open" },
        ...(changes === null ? [] : [{ name: "changes", label: KIN_DOCS.changes }]),
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "changes") changes?.();
        else open();
      }}
      className="gap-2 rounded-[20px] border border-border bg-card-alt p-4"
    >
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        Doc
      </Text>
      <Text textRole="body" className="font-t3-bold text-foreground">
        {doc.title}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {line.text}
      </Text>
      <View className="flex-row flex-wrap gap-2 pt-1">
        <Chip size="small" label="Open" onPress={open} />
        {changes === null ? null : <Chip size="small" label={KIN_DOCS.changes} onPress={changes} />}
      </View>
    </View>
  );
});
