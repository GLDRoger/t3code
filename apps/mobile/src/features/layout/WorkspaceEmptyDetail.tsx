import { T, useGT } from "gt-react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { NewThreadButton } from "../../components/NewThreadButton";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import type { WorkspaceTab } from "./workspace/workspace-tabs-state";

export function WorkspaceEmptyDetail(props: {
  readonly tab?: WorkspaceTab | "settings";
  readonly onStartNewTask?: () => void;
  readonly onAddConnection?: () => void;
  /** Shown with `onAddConnection`: the other way to start, for someone joining a team. */
  readonly onJoinKin?: () => void;
}) {
  const gt = useGT();
  const pullRequests = props.tab === "pullRequests";
  const issues = props.tab === "issues";
  const settings = props.tab === "settings";
  if (props.tab === "usage") return <View className="flex-1 bg-screen" />;
  return (
    <ScreenContent surface="screen">
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 items-center justify-center px-10"
            : "flex-1 items-center justify-center bg-screen px-10"
        }
      >
        {props.onAddConnection ? (
          <View className="w-full max-w-[430px]">
            <EmptyState
              // oxlint-disable-next-line t3code/no-untranslated-copy -- Kin's copy stays English until Kin is translated
              title="Get started"
              // oxlint-disable-next-line t3code/no-untranslated-copy -- Kin's copy stays English until Kin is translated
              detail="Joining a team? Use the link they sent you. Running your own Kin? Connect the computer it runs on."
              variant="plain"
              action={
                <View className="items-center gap-3">
                  {props.onJoinKin ? (
                    // oxlint-disable-next-line t3code/no-untranslated-copy -- Kin's copy stays English until Kin is translated
                    <Button tone="primary" label="I have a join link" onPress={props.onJoinKin} />
                  ) : null}
                  <FloatingActionButton
                    // oxlint-disable-next-line t3code/no-untranslated-copy -- Kin's copy stays English until Kin is translated
                    label={props.onJoinKin ? "Set up my own Kin" : gt("Add environment")}
                    icon="plus"
                    variant="extended"
                    tone={props.onJoinKin ? "secondary" : "primary"}
                    onPress={props.onAddConnection}
                  />
                </View>
              }
            />
          </View>
        ) : (
          <View className="max-w-[360px] items-center gap-3">
            <SymbolView
              name="sidebar.left"
              size={34}
              tintColorClassName="accent-icon-subtle"
              type="hierarchical"
            />
            <Text className="text-center text-xl font-t3-bold">
              {settings
                ? gt("Select a setting")
                : pullRequests
                  ? gt("Select a pull request")
                  : issues
                    ? gt("Select an issue")
                    : gt("Select a thread")}
            </Text>
            <Text className="text-center text-base text-foreground-muted">
              {settings
                ? gt("Choose a page from the sidebar.")
                : pullRequests
                  ? gt("Choose a pull request from the sidebar to review it.")
                  : issues
                    ? gt("Choose an issue from the sidebar to read it.")
                    : Platform.OS === "android"
                      ? gt("Choose a thread from the sidebar or start a new thread.")
                      : gt("Choose a thread from the sidebar or start a new task.")}
            </Text>
            {props.onStartNewTask && !pullRequests && !issues && !settings ? (
              Platform.OS === "android" ? (
                <NewThreadButton extended className="mt-2" onPress={props.onStartNewTask} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  className="mt-2 flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
                  onPress={props.onStartNewTask}
                >
                  <Text className="text-base font-t3-bold text-primary-foreground">
                    <T>New thread</T>
                  </Text>
                </Pressable>
              )
            ) : null}
          </View>
        )}
      </View>
    </ScreenContent>
  );
}
