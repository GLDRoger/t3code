import type { KinNextStepAct, KinNextStepView } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { KinAvatar } from "./KinAvatar";

const ICON: Partial<Record<KinNextStepAct, AppSymbolName>> = {
  keep: "checkmark",
  done: "checkmark",
  reopen: "arrow.uturn.backward",
  openWaiting: "bubble.left",
};
const WAITING = { send: "A draft is waiting for your OK", question: "A question is waiting" };

/** The one thing that moves a task for whoever is looking, under its title. */
export function KinNextStep(props: {
  readonly step: KinNextStepView;
  readonly busy: boolean;
  readonly onAct: (act: KinNextStepAct) => void;
  /** A line under the buttons on what pressing them does, such as stopping the agent. */
  readonly footnote?: string | null;
}) {
  const { step } = props;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        {step.who === null ? null : <KinAvatar avatar={step.who.avatar} size="mini" />}
        <Text textRole="footnote" className="min-w-0 flex-1 text-foreground">
          {step.who === null ? null : <Text className="font-t3-medium">{step.who.name} </Text>}
          {step.line}
          {step.when === null ? null : (
            <Text className="text-foreground-muted"> · {step.when}</Text>
          )}
        </Text>
      </View>
      {step.words === null ? null : (
        <Text textRole="body" selectable className="text-foreground">
          “{step.words}”
        </Text>
      )}
      {step.waiting === null ? null : (
        <View className="gap-1 rounded-xl bg-grouped-card px-3 py-2.5">
          <Text textRole="footnote" className="text-foreground-muted">
            {WAITING[step.waiting.kind]}
          </Text>
          <Text textRole="body" numberOfLines={3} className="text-foreground">
            {step.waiting.preview}
          </Text>
          {step.waiting.files.map((file) => (
            <View key={file.name} className="flex-row items-center gap-1.5">
              <SymbolView name="doc.text" size={12} tintColorClassName="accent-icon-muted" />
              <Text textRole="footnote" numberOfLines={1} className="text-foreground-muted">
                {file.name}
              </Text>
            </View>
          ))}
        </View>
      )}
      {step.acts.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2">
          {step.acts.map((act, index) => (
            <Button
              key={act.id}
              tone={index === 0 ? "primary" : "secondary"}
              size="compact"
              label={act.label}
              {...(ICON[act.id] === undefined ? {} : { icon: ICON[act.id] })}
              loading={props.busy && index === 0}
              disabled={props.busy}
              onPress={() => props.onAct(act.id)}
            />
          ))}
        </View>
      )}
      {[step.note, props.footnote ?? null].map((line) =>
        line === null ? null : (
          <Text key={line} textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        ),
      )}
    </View>
  );
}
