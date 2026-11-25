import {
  kinDesktopNoticeDestination,
  kinDesktopNoticeShows,
} from "@t3tools/client-runtime/kin/kinMessageAlerts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, KinOrgId, type KinDesktopNotice } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { kinClient } from "./kinClient";
import { revealKinDesktopWindow } from "./kinDesktopWindow";
import { lookingAtKin, openDestination } from "./KinNotifications";
import { keepKinAlert, kinAlertTag } from "./kinSystemAlerts";
import { kinHostKeptTarget, useKinHost } from "./useKinHost";

export function KinDesktopAlerts() {
  const params = useParams({ strict: false });
  const host = kinHostKeptTarget(useKinHost());
  const environmentId =
    params.environmentId === undefined
      ? host?.environmentId
      : EnvironmentId.make(params.environmentId);
  const orgId = params.orgId === undefined ? host?.orgId : KinOrgId.make(params.orgId);
  const navigate = useNavigate();
  const mode = useClientSettings((settings) => settings.notificationMode);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the host socket and raises OS notifications
  useEffect(() => {
    if (environmentId === undefined || orgId === undefined || mode === "off") return;
    return kinClient.subscribeDesktopNotices(environmentId, { orgId }, (notice) =>
      show(notice, { environmentId, orgId }, mode, navigate),
    );
  }, [environmentId, mode, navigate, orgId]);
  return null;
}

function show(
  notice: KinDesktopNotice,
  where: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId },
  mode: Parameters<typeof kinDesktopNoticeShows>[1]["mode"],
  navigate: ReturnType<typeof useNavigate>,
): void {
  const options = kinDesktopNoticeShows(notice, { looking: lookingAtKin(), mode });
  if (
    options === null ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  const { chatId } = notice.data;
  const alert = new Notification(notice.title, {
    body: notice.body,
    ...options,
    ...(chatId === undefined ? {} : { tag: kinAlertTag(where.environmentId, chatId) }),
  });
  if (chatId !== undefined) keepKinAlert(where.environmentId, chatId, alert);
  alert.onclick = () => {
    alert.close();
    void settlePromise(async () => {
      await revealKinDesktopWindow();
      const destination = kinDesktopNoticeDestination(notice);
      if (destination !== null) await openDestination(navigate, where, destination);
    });
  };
}
