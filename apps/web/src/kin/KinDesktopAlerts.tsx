import {
  kinDesktopNoticeDestination,
  kinDesktopNoticeShows,
} from "@t3tools/client-runtime/kin/kinMessageAlerts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type KinOrgId, type KinDesktopNotice } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { playNotificationSound } from "../threadNotifications";
import { kinClient } from "./kinClient";
import { revealKinDesktopWindow } from "./kinDesktopWindow";
import { lookingAtKin, openDestination } from "./KinNotifications";
import { keepKinAlert, kinAlertTag } from "./kinSystemAlerts";
import { useKinHost, useKinHostAt } from "./useKinHost";

export function KinDesktopAlerts() {
  const routeEnvironment = useParams({ strict: false }).environmentId;
  const host = useKinHost();
  const environmentId =
    routeEnvironment !== undefined
      ? EnvironmentId.make(routeEnvironment)
      : host._tag === "host"
        ? host.environmentId
        : undefined;
  const mode = useClientSettings((settings) => settings.notificationMode);
  if (environmentId === undefined || mode === "off") return null;
  return <HostDesktopNotices key={environmentId} environmentId={environmentId} mode={mode} />;
}

type NoticeMode = Parameters<typeof kinDesktopNoticeShows>[1]["mode"];

function HostDesktopNotices({
  environmentId,
  mode,
}: {
  readonly environmentId: EnvironmentId;
  readonly mode: NoticeMode;
}) {
  const host = useKinHostAt(environmentId);
  if (host._tag !== "host" || host.probe._tag !== "ready") return null;
  return host.probe.orgs.me.map(({ orgId }) => (
    <OrgDesktopNotices key={orgId} environmentId={environmentId} orgId={orgId} mode={mode} />
  ));
}

function OrgDesktopNotices({
  environmentId,
  orgId,
  mode,
}: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly mode: NoticeMode;
}) {
  const navigate = useNavigate();
  const onNotice = useEffectEvent((notice: KinDesktopNotice) =>
    show(notice, environmentId, mode, navigate),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the host socket and raises OS notifications
  useEffect(
    () => kinClient.subscribeDesktopNotices(environmentId, { orgId }, (notice) => onNotice(notice)),
    [environmentId, orgId],
  );
  return null;
}

function show(
  notice: KinDesktopNotice,
  environmentId: EnvironmentId,
  mode: NoticeMode,
  navigate: ReturnType<typeof useNavigate>,
): void {
  const options = kinDesktopNoticeShows(notice, { looking: lookingAtKin(), mode });
  if (options === null) return;
  if (options.sound) void playNotificationSound("input", () => !lookingAtKin());
  if (
    !options.banner ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  const { chatId } = notice.data;
  const alert = new Notification(notice.title, {
    body: notice.body,
    silent: true,
    ...(chatId === undefined ? {} : { tag: kinAlertTag(environmentId, chatId) }),
  });
  if (chatId !== undefined) keepKinAlert(environmentId, chatId, alert);
  alert.onclick = () => {
    alert.close();
    void settlePromise(async () => {
      await revealKinDesktopWindow();
      const destination = kinDesktopNoticeDestination(notice);
      if (destination !== null)
        await openDestination(navigate, { environmentId, orgId: notice.data.orgId }, destination);
    });
  };
}
