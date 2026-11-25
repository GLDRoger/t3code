import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_SECTIONS_PAGE } from "@t3tools/client-runtime/kin/kinShell";

import { KinSectionsSettings } from "./components/KinSectionSwitch";
import { KinGateView, KinWorkFrame } from "./components/KinWorkPieces";
import { NO_LINK, targetOf } from "./KinWorkFormScreens";
import { kinClient } from "./state/kinClient";
import { useKinGate } from "./state/useKinHost";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinSectionsParams = {
  readonly environmentId: string;
  readonly orgId: string;
};

/** Settings › Sections: which parts of Kin the company uses, and Clients' own name. */
export function KinSectionsScreen({ route }: StaticScreenProps<KinSectionsParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  return (
    <KinWorkFrame title={KIN_SECTIONS_PAGE.title} onBack={() => navigation.goBack()} form>
      {target === null ? NO_LINK : <KinSectionsGate {...target} />}
    </KinWorkFrame>
  );
}

/** A teammate who follows the link is told the page is the owner level's, as Kin's computer is. */
function KinSectionsGate(props: KinWorkTarget) {
  const gate = useKinGate(
    kinClient.shellSet.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  return gate === null ? (
    <KinSectionsSettings {...props} />
  ) : (
    <KinGateView
      gate={gate}
      refused={KIN_SECTIONS_PAGE.onlyOwner}
      label={KIN_SECTIONS_PAGE.title}
    />
  );
}
