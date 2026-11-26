import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_COUNTRY_ASK,
  kinCountryCardRegion,
  kinCountryCodeOf,
  kinCountryOffer,
  kinDeviceRegion,
  type KinCountryCardView,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAnswerCountryCardInput } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { useAtomCommand } from "../state/use-atom-command";
import { KinCountryCombobox } from "./KinCountryCombobox";
import { CardFrame } from "./KinCards";
import { kinClient } from "./kinClient";

/** Asks an owner which country the company is in; the first answer closes every copy. */
export function KinCountryCard(props: {
  readonly country: KinCountryCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { country, environmentId } = props;
  const canAct = useAtomValue(kinClient.answerCountryCard.permissionAtom(environmentId));
  const answer = useAtomCommand(kinClient.answerCountryCard, { reportFailure: false });
  const id = useId();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState<KinAnswerCountryCardInput["answer"]["_tag"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const code = kinCountryCodeOf(typed);
  const offer = kinCountryOffer(typed, kinCountryCardRegion(country.fits, kinDeviceRegion()));

  const send = async (reply: KinAnswerCountryCardInput["answer"]) => {
    if (pending !== null) return;
    setPending(reply._tag);
    setProblem(null);
    const result = await answer({
      environmentId,
      input: { orgId: country.orgId, widgetId: country.widgetId, answer: reply },
    });
    setPending(null);
    if (AsyncResult.isFailure(result))
      setProblem(kinFailureText(squashAtomCommandFailure(result), KIN_COUNTRY_ASK.failed));
  };

  return (
    <CardFrame label={country.accessibilityLabel}>
      <p className="font-medium text-foreground">{country.question}</p>
      {country.closed === null ? null : (
        <p className="text-xs font-medium text-muted-foreground">{country.closed}</p>
      )}
      {!country.open ? null : !canAct ? (
        <p className="text-xs text-muted-foreground">
          {KIN_DEVICE_COPY.cantAct("browser", "answer")}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{KIN_COUNTRY_ASK.country}</Label>
            <KinCountryCombobox
              id={id}
              value={typed}
              placeholder={KIN_COUNTRY_ASK.choose}
              disabled={pending !== null}
              invalid={false}
              onChange={setTyped}
            />
            {offer === null ? null : (
              <div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => setTyped(offer.country)}
                >
                  {offer.label}
                </Button>
              </div>
            )}
          </div>
          {problem === null ? null : (
            <p role="alert" className="text-xs font-medium text-destructive-foreground">
              {problem}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button
              size="sm"
              aria-busy={pending === "country"}
              disabled={code === null || pending !== null}
              onClick={() => code !== null && void send({ _tag: "country", country: code })}
            >
              {KIN_COUNTRY_ASK.save}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-busy={pending === "not_now"}
              disabled={pending !== null}
              onClick={() => void send({ _tag: "not_now" })}
            >
              {KIN_COUNTRY_ASK.notNow}
            </Button>
          </div>
        </>
      )}
    </CardFrame>
  );
}
