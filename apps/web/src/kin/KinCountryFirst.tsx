import type { EnvironmentId } from "@t3tools/contracts";
import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { useRouter } from "@tanstack/react-router";

import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { openKinSettings } from "./kinSettingsAddress";
import { useKinCountryNeeded } from "./useKinMoney";
import { useKinOwnerLevel, useKinPlaceReach } from "./useKinOwnerLevel";
import { KinWorkNotice } from "./KinWorkParts";

/** Opens Company details over this page, so saving it comes back here. */
function ChooseCountry(props: { readonly inForm?: boolean }) {
  const router = useRouter();
  return (
    <Button
      size={props.inForm === true ? "compact" : "default"}
      variant={props.inForm === true ? "outline" : "default"}
      onClick={() => openKinSettings(router.history, "company")}
    >
      {KIN_MONEY.chooseCountry}
    </Button>
  );
}

/**
 * Where money is started: while a company made new has no country, one step to Company details
 * instead. A teammate kept out of Money sees Money's own refusal, as before.
 */
export function KinCountryFirst(props: {
  readonly environmentId: EnvironmentId;
  readonly children: React.ReactNode;
  /** What stays reachable below the step while the country waits: nothing that records money. */
  readonly waiting?: React.ReactNode;
}) {
  const needed = useKinCountryNeeded(props);
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  const reach = useKinPlaceReach(props.environmentId);
  if (!needed || (!ownerLevel && reach?.money !== true)) return props.children;
  const notice = ownerLevel ? (
    <KinWorkNotice {...KIN_MONEY.countryFirst} action={<ChooseCountry />} />
  ) : (
    <KinWorkNotice {...KIN_MONEY.countryFirstMember} />
  );
  if (props.waiting === undefined) return notice;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      {notice}
      {props.waiting}
    </div>
  );
}

/** An amount's field in a form, or the same step in its place while the country isn't chosen. */
export function KinCountryFirstField(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** False while the field takes no amount, such as a count goal's target. */
  readonly money?: boolean;
  readonly children: React.ReactNode;
}) {
  const needed = useKinCountryNeeded(props);
  const ownerLevel = useKinOwnerLevel(props.environmentId);
  if (!needed || props.money === false) return props.children;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Label>{props.label}</Label>
      <p className="text-xs text-muted-foreground">
        {ownerLevel ? KIN_MONEY.countryFirst.detail : KIN_MONEY.countryFirstMember.detail}
      </p>
      {ownerLevel ? <ChooseCountry inForm /> : null}
    </div>
  );
}
