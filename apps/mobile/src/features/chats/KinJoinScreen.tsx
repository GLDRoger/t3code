import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  KIN_JOIN_NO_LINK,
  kinJoinTarget,
  type KinJoinStanding,
  type KinJoinTarget,
} from "@t3tools/client-runtime/kin/kinJoin";
import { useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { PairingScanCard } from "../connection/ConnectionsNewRouteScreen";
import { readKinIsHome } from "./state/kinHome";
import { joinKin, readKinJoinStanding } from "./state/kinJoin";

export type KinJoinParams = { readonly link?: string };

/** Where a teammate turns the link they were sent into their chats: pasted, scanned or opened. */
export function KinJoinScreen({ route }: StaticScreenProps<KinJoinParams | undefined>) {
  const link = route.params?.link?.trim() ?? "";
  // A second link opened over the form replaces what it held.
  return <KinJoinForm key={link} openedLink={link} />;
}

type Standing = Exclude<KinJoinStanding, { readonly _tag: "new" }>;

function KinJoinForm(props: { readonly openedLink: string }) {
  const navigation = useNavigation();
  const [text, setText] = useState(props.openedLink);
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // An opened link is checked at once, so a second tap on it says "already in" without a press.
  const [standing, setStanding] = useState<Standing | null>(() => {
    const opened = kinJoinTarget(props.openedLink);
    const found = opened === null ? null : readKinJoinStanding(opened);
    return found === null || found._tag === "new" ? null : found;
  });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const focused = useIsFocused();
  const [scanning, setScanning] = useState(false);
  const target = kinJoinTarget(text);

  const openChats = () => {
    if (!readKinIsHome()) {
      navigation.dispatch(StackActions.replace("KinChats"));
      // A first join already restarted Home as the Kin list, and this sheet went with it.
    } else if (rootNavigationRef.canGoBack()) {
      rootNavigationRef.dispatch(StackActions.popToTop());
    }
  };

  const redeem = async (joinTarget: KinJoinTarget) => {
    setStanding(null);
    setProblem(null);
    setJoining(true);
    const result = await joinKin(joinTarget);
    setJoining(false);
    void Haptics.notificationAsync(
      result.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    );
    if (result.ok) openChats();
    else setProblem(result.problem);
  };

  const join = (joinTarget: KinJoinTarget | null) => {
    if (joining) return;
    if (joinTarget === null) return setProblem(KIN_JOIN_NO_LINK);
    const found = readKinJoinStanding(joinTarget);
    if (found._tag === "new") void redeem(joinTarget);
    else setStanding(found);
  };

  const startScanning = async () => {
    const permission = await requestCameraPermission();
    if (permission.granted) return setScanning(true);
    if (permission.canAskAgain) return;
    Dialog.alert(
      "Camera access needed",
      "Camera access was denied for this app. Open Settings to enable it.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const onScan = ({ data }: { readonly data: string }) => {
    if (!scanning) return;
    // One read per scan; a code that isn't a join link leaves the camera off and says so.
    setScanning(false);
    setText(data);
    join(kinJoinTarget(data));
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="Join your team"
        onClose={() => navigation.goBack()}
        confirm={
          standing === null
            ? {
                label: "Join",
                onPress: () => join(target),
                loading: joining,
                disabled: joining || text.trim() === "",
              }
            : undefined
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {standing !== null ? (
            <EmptyState
              variant="plain"
              title={
                standing._tag === "member"
                  ? "You're already in"
                  : "This phone already has full access"
              }
              detail={
                standing._tag === "member"
                  ? "This phone is signed in to your team's Kin. If this link is for someone else, you can sign in with it instead."
                  : "It's already connected to this Kin, so it doesn't need a join link."
              }
              action={
                <View className="items-center gap-3">
                  <Button tone="primary" label="Open chats" onPress={openChats} />
                  {standing._tag === "member" && target !== null ? (
                    <Button
                      tone="text"
                      label="Sign in with this link instead"
                      onPress={() => void redeem(target)}
                    />
                  ) : null}
                </View>
              }
            />
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                Paste the join link your team sent you, or scan it. It works once.
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              <View className="gap-2">
                <ListSection>
                  <View className="gap-2 px-4 py-3">
                    <Text className="text-sm text-foreground-muted">Join link</Text>
                    <TextInput
                      accessibilityLabel="Join link"
                      value={text}
                      editable={!joining}
                      autoFocus={props.openedLink === ""}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      returnKeyType="join"
                      onChangeText={(value) => {
                        setText(value);
                        setProblem(null);
                      }}
                      onSubmitEditing={() => join(target)}
                      textAlignVertical="center"
                      placeholder="Paste your join link"
                      placeholderTextColorClassName="accent-placeholder"
                      className="min-h-8 font-sans text-base text-foreground"
                    />
                  </View>
                </ListSection>
                {target === null ? null : (
                  <Text textRole="footnote" className="px-4 text-foreground-muted">
                    {`This joins the Kin at ${target.address}.`}
                  </Text>
                )}
              </View>
              <PairingScanCard
                caption="Scan the join code your team is showing you"
                cameraActive={scanning && cameraPermission?.granted === true && focused}
                onScan={onScan}
                onScanPress={() => void startScanning()}
              />
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
