import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";

const failureText = (result: AsyncResult.AsyncResult<unknown, unknown>, fallback: string) => {
  const cause = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
};

/** The owner's list of outside hosts visuals may load from: see it, add to it, take from it. */
export function KinVisualHosts(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const hostsAtom = kinClient.visualHosts({ environmentId, input: { orgId } });
  const hosts = Option.getOrNull(AsyncResult.value(useAtomValue(hostsAtom)))?.hosts ?? null;
  const reload = useAtomRefresh(hostsAtom);
  const allow = useAtomCommand(kinClient.visualHostAllow, { reportFailure: false });
  const remove = useAtomCommand(kinClient.visualHostRemove, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const change = async (host: string, on: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await (on ? allow : remove)({ environmentId, input: { orgId, host } });
    setBusy(false);
    reload();
    if (AsyncResult.isSuccess(result)) {
      if (on) setDraft("");
      return;
    }
    setProblem(failureText(result, on ? "Couldn't add that host." : "Couldn't remove that host."));
  };
  const add = () => {
    if (draft.trim() !== "") void change(draft, true);
  };

  return (
    <View className="gap-2">
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection
        title="Visuals"
        footer="A visual an agent sends can't reach the internet. A host you add here is the exception: any visual can load images, fonts and data from it, and send it what the visual shows."
      >
        {hosts?.length === 0 ? (
          <View className="border-b border-border-subtle px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              No hosts added.
            </Text>
          </View>
        ) : null}
        {hosts === null
          ? null
          : hosts.map((host) => (
              <View
                key={host}
                className="flex-row items-center gap-3 border-b border-border-subtle px-4 py-3"
              >
                <Text
                  textRole="body"
                  numberOfLines={1}
                  className="min-w-0 flex-1 font-mono text-foreground"
                >
                  {host}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${host}`}
                  hitSlop={12}
                  disabled={busy}
                  onPress={() => void change(host, false)}
                >
                  <Text textRole="body" className="font-t3-medium text-danger-foreground">
                    Remove
                  </Text>
                </Pressable>
              </View>
            ))}
        <View className="flex-row items-center gap-3 px-4 py-3">
          <TextInput
            accessibilityLabel="Host to add"
            value={draft}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onChangeText={setDraft}
            onSubmitEditing={add}
            placeholder="tiles.example.com"
            placeholderTextColorClassName="accent-placeholder"
            className="min-h-8 min-w-0 flex-1 font-sans text-base text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            disabled={busy || draft.trim() === ""}
            onPress={add}
          >
            <Text
              textRole="body"
              className={
                busy || draft.trim() === ""
                  ? "font-t3-medium text-foreground-muted"
                  : "font-t3-medium text-primary"
              }
            >
              Add host
            </Text>
          </Pressable>
        </View>
      </ListSection>
    </View>
  );
}
