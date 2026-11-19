import { kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";
import { formatKinWhen } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  KIN_AGENT_CHANGES,
  kinAgentChangeLine,
  kinAgentChangeOffer,
} from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAgentChange, KinAgentId, KinOrgId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import { useKinWorkDirectory } from "./state/useKinWork";

/** The agent's last changes to records, read from `kin_record_changes`, each with its way back. */
export function KinAgentChanged(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly changed: ReadonlyArray<KinAgentChange>;
  readonly onChanged: () => void;
}) {
  const { environmentId, orgId } = props;
  const navigation = useNavigation();
  const undo = useAtomCommand(kinClient.agentUndoChange, { reportFailure: false });
  const canUndo = useAtomValue(kinClient.agentUndoChange.permissionAtom(environmentId));
  const directory = useKinWorkDirectory({ environmentId, orgId }, true).names;
  const names = new Map([...directory.people, ...directory.agents]);
  const [busy, setBusy] = useState<number | null>(null);
  const [said, setSaid] = useState<{
    readonly seq: number;
    readonly text: string;
    readonly ok: boolean;
  } | null>(null);
  const open = (change: KinAgentChange) => {
    const base = { environmentId, orgId };
    if (change.registerId === "docs") navigation.navigate("KinDoc", { ...base, doc: change.key });
    else if (change.registerId === "clients")
      navigation.navigate("KinClient", { ...base, party: change.key });
    else if (change.registerId === "projects")
      navigation.navigate("KinProject", { ...base, project: change.key });
    else if (kinIsDealKey(change.key))
      navigation.navigate("KinDeal", { ...base, deal: change.key });
    else navigation.navigate("KinWorkItem", { ...base, task: change.key });
  };
  const run = async (seq: number, done: string) => {
    setBusy(seq);
    const outcome = await undo({ environmentId, input: { orgId, agentId: props.agentId, seq } });
    setBusy(null);
    const ok = !AsyncResult.isFailure(outcome);
    setSaid({
      seq,
      ok,
      text: ok ? done : kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENT_CHANGES.failed),
    });
    props.onChanged();
  };
  return (
    <ListSection title={KIN_AGENT_CHANGES.title} footer={KIN_AGENT_CHANGES.detail}>
      {props.changed.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="body" className="text-foreground-muted">
            {KIN_AGENT_CHANGES.none}
          </Text>
        </View>
      ) : (
        props.changed.map((change, index) => {
          const offer = kinAgentChangeOffer(change, said?.seq === change.seq && said.ok);
          return (
            <View
              key={change.seq}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <ListRow
                label={kinAgentChangeLine(change, names)}
                description={formatKinWhen(new Date(change.at), "dateTime")}
                onPress={() => open(change)}
              />
              {offer.kind === "undo" && canUndo ? (
                <View className="flex-row items-center gap-3 px-4 pb-3">
                  <Button
                    tone="outline"
                    size="compact"
                    label={busy === change.seq ? KIN_AGENT_CHANGES.undoing : KIN_AGENT_CHANGES.undo}
                    loading={busy === change.seq}
                    disabled={busy !== null}
                    onPress={() => void run(change.seq, offer.done)}
                  />
                  {said?.seq === change.seq ? (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {said.text}
                    </Text>
                  ) : null}
                </View>
              ) : offer.kind !== "undo" && offer.kind !== "none" ? (
                <View className="px-4 pb-3">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {offer.text}
                  </Text>
                </View>
              ) : said?.seq === change.seq ? (
                <View className="px-4 pb-3">
                  <Text textRole="footnote" className="text-foreground-muted">
                    {said.text}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ListSection>
  );
}
