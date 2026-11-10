import { useNavigation } from "@react-navigation/native";

import { CompactBrandTitle } from "../../../components/CompactBrandTitle";
import { KinListSwitch } from "../../chats/components/KinListSwitch";
import { WorkspaceConnectionTitle } from "../../home/WorkspaceConnectionTitle";

/** The title of a workspace list tab: the brand and the connection status. */
export function WorkspaceBrandTitle(props: {
  readonly accessibilityLabel: string;
  readonly onOpenEnvironments: () => void;
}) {
  const navigation = useNavigation();
  return (
    <WorkspaceConnectionTitle
      grow
      onPress={props.onOpenEnvironments}
      brand={
        <KinListSwitch onOpenKin={() => navigation.navigate("KinChats")}>
          {(trailing) => (
            <CompactBrandTitle
              allowFontScaling={false}
              accessibilityLabel={props.accessibilityLabel}
              fit
              trailing={trailing}
            />
          )}
        </KinListSwitch>
      }
    />
  );
}
