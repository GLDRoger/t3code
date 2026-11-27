import { KIN_SECTIONS_PAGE } from "@t3tools/client-runtime/kin/kinShell";

import { kinNewLeadTarget } from "../KinNewLeadButton";
import { useKinHost } from "../useKinHost";
import { KinSectionsSettings } from "./KinSectionSwitch";
import { KinSettingsPage } from "./KinSettingsLayout";

/** Settings › Sections: which parts of Kin the company uses, and Clients' own name. */
export function KinSectionsPage() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : (
    <KinSettingsPage purpose={KIN_SECTIONS_PAGE.intro}>
      <KinSectionsSettings {...target} />
    </KinSettingsPage>
  );
}
