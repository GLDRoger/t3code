import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_DEVICES_COPY,
  kinActiveDevices,
  kinDeviceJustLinked,
  kinDeviceLabel,
  kinDeviceLine,
  kinDeviceLinkLeft,
  kinDeviceLinkProblem,
  kinDeviceRemovable,
  kinRemoveDeviceCopy,
  kinRemoveDeviceProblem,
} from "@t3tools/client-runtime/kin/kinDevices";
import {
  KIN_INVITE_LOCAL_ONLY_NOTE,
  kinInviteLink,
  kinInviteLinkLocalOnly,
} from "@t3tools/client-runtime/kin/kinTeam";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  type KinPeopleLinkDeviceResult,
  type KinPersonDevice,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Share, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { KinLoadFailedRow } from "./components/KinLoadFailed";
import { KinQrCode } from "./components/KinQrCode";
import { kinClient } from "./state/kinClient";

export type KinDevicesParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly personId: string;
};

interface KinDevicesTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodePersonId = Schema.decodeUnknownOption(KinPersonId);

/** The phones and browsers signed in as you, and the way to add one more. */
export function KinDevicesScreen({ route }: StaticScreenProps<KinDevicesParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const personId = Option.getOrNull(decodePersonId(route.params.personId));
  // Held here and nowhere else; leaving the page drops it.
  const [made, setMade] = useState<KinPeopleLinkDeviceResult | null>(null);
  const [linking, setLinking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target =
    environmentId === null || orgId === null || personId === null
      ? null
      : { environmentId, orgId, personId };

  const link = async () => {
    if (target === null || linking) return;
    setLinking(true);
    setProblem(null);
    const outcome = await runAtomCommand(
      appAtomRegistry,
      kinClient.deviceLink,
      { environmentId: target.environmentId, input: { orgId: target.orgId } },
      { reportFailure: false, reportDefect: true },
    );
    setLinking(false);
    if (AsyncResult.isSuccess(outcome)) setMade(outcome.value);
    else setProblem(kinDeviceLinkProblem(squashAtomCommandFailure(outcome)));
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={made === null ? KIN_DEVICES_COPY.title : KIN_DEVICES_COPY.link}
        onBack={() => (made === null ? navigation.goBack() : setMade(null))}
        {...(made === null ? {} : { confirm: { label: "Done", onPress: () => setMade(null) } })}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {target === null ? (
            <EmptyState
              variant="plain"
              title="This link doesn't open anything"
              detail="Open Your devices from Settings."
            />
          ) : made !== null ? (
            <KinDeviceLinkView
              key={made.linkId}
              made={made}
              target={target}
              linking={linking}
              problem={problem}
              onRenew={() => void link()}
            />
          ) : (
            <>
              {problem === null ? null : <ErrorBanner message={problem} />}
              <ListSection footer={KIN_DEVICES_COPY.linkDetail}>
                <ListActionRow
                  icon="plus"
                  label={KIN_DEVICES_COPY.link}
                  loading={linking}
                  onPress={() => void link()}
                />
              </ListSection>
              <KinDeviceList target={target} self />
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/**
 * A person's signed-in devices with a way to remove each: your own here, or a teammate's on
 * their sheet for the owner.
 */
export function KinDeviceList(props: {
  readonly target: KinDevicesTarget;
  readonly self: boolean;
}) {
  const { environmentId, orgId, personId } = props.target;
  const atom = kinClient.devices({ environmentId, input: { orgId, personId } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const held = Option.getOrNull(AsyncResult.value(result));
  const nowMs = useNowMinuteMs();
  const devices = held === null ? null : kinActiveDevices(held.devices, nowMs);

  const remove = (device: KinPersonDevice) => {
    const copy = kinRemoveDeviceCopy(device, props.self, held?.devices ?? [], nowMs);
    Dialog.confirm({
      title: copy.title,
      message: copy.detail,
      confirmText: KIN_DEVICES_COPY.remove,
      destructive: true,
      onConfirm: () => {
        setRemoving(device.sessionId);
        setProblem(null);
        void runAtomCommand(
          appAtomRegistry,
          kinClient.deviceRemove,
          { environmentId, input: { orgId, personId, sessionId: device.sessionId } },
          { reportFailure: false, reportDefect: true },
        ).then((outcome) => {
          setRemoving(null);
          if (AsyncResult.isFailure(outcome))
            setProblem(kinRemoveDeviceProblem(squashAtomCommandFailure(outcome)));
          // This phone is signed out now; the app's access-ended screen takes over.
          else if (device.current === true) return;
          refresh();
        });
      },
    });
  };

  return (
    <>
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection
        title={props.self ? undefined : "Devices"}
        footer={props.self ? KIN_DEVICES_COPY.footer : KIN_DEVICES_COPY.ownerFooter}
      >
        {devices === null ? (
          AsyncResult.isFailure(result) ? (
            <KinLoadFailedRow title="Couldn't load devices" cause={result} onRetry={refresh} />
          ) : (
            <View className="items-center py-6">
              <AppActivityIndicator />
            </View>
          )
        ) : devices.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              {KIN_DEVICES_COPY.empty}
            </Text>
          </View>
        ) : (
          devices.map((device, index) => (
            <View
              key={device.sessionId}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <ListActionRow
                icon={device.deviceType === "mobile" ? "iphone" : "laptopcomputer"}
                label={kinDeviceLabel(device)}
                {...(kinDeviceRemovable(device)
                  ? {
                      accessibilityLabel: `${KIN_DEVICES_COPY.remove} ${kinDeviceLabel(device)}`,
                      detail: KIN_DEVICES_COPY.remove,
                    }
                  : {})}
                description={
                  device.current === true
                    ? `This device · ${kinDeviceLine(device, new Date(nowMs))}`
                    : kinDeviceLine(device, new Date(nowMs))
                }
                loading={removing === device.sessionId}
                disabled={removing !== null || !kinDeviceRemovable(device)}
                onPress={() => remove(device)}
              />
            </View>
          ))
        )}
      </ListSection>
    </>
  );
}

/** The link and QR for one more device; shown once, then gone. */
function KinDeviceLinkView(props: {
  readonly made: KinPeopleLinkDeviceResult;
  readonly target: KinDevicesTarget;
  readonly linking: boolean;
  /** Why the last "Make a new link" failed. */
  readonly problem: string | null;
  readonly onRenew: () => void;
}) {
  const { made } = props;
  const { environmentId, orgId, personId } = props.target;
  const connection = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const listed = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(kinClient.devices({ environmentId, input: { orgId, personId } })),
    ),
  );
  const [copied, setCopied] = useState(false);
  const nowMs = useNowMinuteMs();
  if (connection === null) {
    return <ErrorBanner message={KIN_DEVICES_COPY.dropped} />;
  }
  const link = kinInviteLink(connection.httpBaseUrl, made.secret);
  const left = kinDeviceLinkLeft(made.expiresAt, nowMs);
  const joined =
    listed === null
      ? null
      : kinDeviceJustLinked(kinActiveDevices(listed.devices, nowMs), made.linkId);
  if (joined !== null)
    return (
      <EmptyState
        variant="plain"
        title={`${kinDeviceLabel(joined)} is linked`}
        detail="It's signed in as you."
      />
    );
  if (left.expired)
    return (
      <>
        {props.problem === null ? null : <ErrorBanner message={props.problem} />}
        <EmptyState
          variant="plain"
          title={KIN_DEVICES_COPY.expired}
          detail={KIN_DEVICES_COPY.expiredDetail}
          action={
            <Button
              tone="primary"
              label={KIN_DEVICES_COPY.renew}
              loading={props.linking}
              onPress={props.onRenew}
            />
          }
        />
      </>
    );
  return (
    <>
      <ListSection footer={`${left.text} ${KIN_DEVICES_COPY.replaces}`}>
        <View className="items-center gap-3 px-4 py-5">
          <KinQrCode value={link} size={200} />
          <Text textRole="footnote" className="text-center text-foreground-muted">
            {KIN_DEVICES_COPY.scan}
          </Text>
        </View>
      </ListSection>
      {kinInviteLinkLocalOnly(connection.httpBaseUrl) ? (
        <Text textRole="footnote" className="px-4 text-warning-foreground">
          {KIN_INVITE_LOCAL_ONLY_NOTE}
        </Text>
      ) : null}
      <View className="gap-3">
        <Button
          tone="primary"
          icon="square.and.arrow.up"
          label="Share link"
          // Closing the share sheet without sending is not a failure.
          onPress={() => void Share.share({ message: link }).catch(() => undefined)}
        />
        <Button
          tone="secondary"
          icon={copied ? "checkmark" : "doc.on.doc"}
          label={copied ? "Copied" : "Copy link"}
          onPress={() =>
            void tryCopyTextWithHaptic(link, { target: "link" }).then((ok) => setCopied(ok))
          }
        />
      </View>
    </>
  );
}
