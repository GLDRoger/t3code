import type { EnvironmentId } from "@t3tools/contracts";
import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { useRouter } from "@tanstack/react-router";

import { Button } from "../components/ui/button";
import { openKinSettings } from "./kinSettingsAddress";
import { useKinCountryNeeded } from "./useKinMoney";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { KinWorkNotice } from "./KinWorkParts";

/**
 * Where money is started: while a company made new has no country, one step to Company details
 * instead, which opens over this page, so saving it comes back here.
 */
export function KinCountryFirst(props: {
  readonly environmentId: EnvironmentId;
  readonly children: React.ReactNode;
}) {
  const needed = useKinCountryNeeded(props);
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  const router = useRouter();
  if (!needed) return props.children;
  if (!ownerLevel) return <KinWorkNotice {...KIN_MONEY.countryFirstMember} />;
  return (
    <KinWorkNotice
      {...KIN_MONEY.countryFirst}
      action={
        <Button onClick={() => openKinSettings(router.history, "company")}>
          {KIN_MONEY.chooseCountry}
        </Button>
      }
    />
  );
}
