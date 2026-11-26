import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_COUNTRY_ASK,
  kinCountryCardRegion,
  kinCountryCodeOf,
  kinCountryName,
  kinCountryOffer,
  kinDeviceRegion,
  type KinCountryCardView,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAnswerCountryCardInput } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import { useAtomCommand } from "../../../state/use-atom-command";
import { KinCountryPicker } from "../components/KinCountryPicker";
import { kinClient } from "../state/kinClient";

/** Asks an owner which country the company is in; the first answer closes every copy. */
export const KinCountryCard = memo(function KinCountryCard(props: {
  readonly country: KinCountryCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { country, environmentId } = props;
  const canAct = useAtomValue(kinClient.answerCountryCard.permissionAtom(environmentId));
  const answer = useAtomCommand(kinClient.answerCountryCard, { reportFailure: false });
  const [code, setCode] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<KinAnswerCountryCardInput["answer"]["_tag"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const offer = kinCountryOffer(code ?? "", kinCountryCardRegion(country.fits, kinDeviceRegion()));

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
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <View accessible accessibilityLabel={country.accessibilityLabel} className="gap-1.5">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {country.question}
        </Text>
        {country.closed === null ? null : (
          <Text textRole="footnote" className="text-foreground-secondary">
            {country.closed}
          </Text>
        )}
      </View>
      {!country.open ? null : !canAct ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_DEVICE_COPY.cantAct("phone", "answer")}
        </Text>
      ) : (
        <>
          <View className="overflow-hidden rounded-xl">
            <ListRow
              icon="globe"
              label={code === null ? KIN_COUNTRY_ASK.choose : KIN_COUNTRY_ASK.country}
              {...(code === null ? {} : { detail: kinCountryName(code) })}
              disabled={pending !== null}
              onPress={() => setPicking(true)}
            />
          </View>
          {offer === null ? null : (
            <View className="flex-row">
              <Button
                label={offer.label}
                tone="outline"
                size="compact"
                disabled={pending !== null}
                onPress={() => setCode(kinCountryCodeOf(offer.country))}
              />
            </View>
          )}
          {problem === null ? null : (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              textRole="footnote"
              className="font-t3-medium text-danger-foreground"
            >
              {problem}
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2 pt-1">
            <Button
              label={KIN_COUNTRY_ASK.save}
              size="compact"
              loading={pending === "country"}
              disabled={code === null || pending === "not_now"}
              onPress={() => code !== null && void send({ _tag: "country", country: code })}
            />
            <Button
              label={KIN_COUNTRY_ASK.notNow}
              tone="outline"
              size="compact"
              loading={pending === "not_now"}
              disabled={pending === "country"}
              onPress={() => void send({ _tag: "not_now" })}
            />
          </View>
        </>
      )}
      {picking ? (
        <Sheet title={KIN_COUNTRY_ASK.country} onClose={() => setPicking(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="px-4 pt-2 pb-10"
          >
            <ListSection>
              <KinCountryPicker
                label={KIN_COUNTRY_ASK.country}
                value={code}
                disabled={false}
                startOpen
                onPick={(picked) => {
                  setCode(picked);
                  setPicking(false);
                }}
              />
            </ListSection>
          </ScrollView>
        </Sheet>
      ) : null}
    </View>
  );
});
