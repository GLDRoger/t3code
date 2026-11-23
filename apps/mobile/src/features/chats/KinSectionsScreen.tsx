import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_SECTIONS_PAGE } from "@t3tools/client-runtime/kin/kinShell";

import { KinSectionsSettings } from "./components/KinSectionSwitch";
import { KinWorkFrame } from "./components/KinWorkPieces";
import { NO_LINK, targetOf } from "./KinWorkFormScreens";

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
      {target === null ? NO_LINK : <KinSectionsSettings {...target} />}
    </KinWorkFrame>
  );
}
