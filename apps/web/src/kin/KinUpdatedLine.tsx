import { useAtomValue } from "@effect/atom-react";
import {
  KIN_UPDATED_CONTINUE,
  KIN_UPDATED_LINE,
  KIN_UPDATED_RELOAD,
  kinUpdatedAction,
} from "@t3tools/client-runtime/kin/kinUpdated";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { useAttachmentUploadStore } from "../lib/attachmentUploadQueue";
import { carryKinDraftsAcrossReload, hasUnsentKinDraft, reloadKeepingKinDrafts } from "./kinDraft";
import { devBundle, pageBuild, reloadPage, serverBuildAtom } from "./kinPageBuild";

/** Marks a form whose contents a reload would lose. */
export const KIN_UNSENT_ATTRIBUTE = "data-kin-unsent";

const RELOADED_FOR_KEY = "t3code:kin:reloaded-for";
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "number", "password"]);

function readReloadedFor(): string | null {
  try {
    return window.sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

function reloadFor(serverBuild: string) {
  try {
    window.sessionStorage.setItem(RELOADED_FOR_KEY, serverBuild);
  } catch {
    // Without storage the loop guard is off; the page still reloads once for this server.
  }
  reloadPage();
}

/** True while a reload would lose something: unsent text, an open dialog or sheet, an upload. */
function kinPageIsBusy(): boolean {
  if (hasUnsentKinDraft()) return true;
  const uploads = Object.values(useAttachmentUploadStore.getState().uploadsByImageId);
  if (uploads.some((upload) => upload.status === "uploading")) return true;
  if (document.querySelector(`[role="dialog"], [role="alertdialog"], [${KIN_UNSENT_ATTRIBUTE}]`)) {
    return true;
  }
  const focused = document.activeElement;
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input",
  )) {
    if (field.readOnly || field.disabled || field.value.trim().length === 0) continue;
    if (field instanceof HTMLInputElement && !TEXT_INPUTS.has(field.type)) continue;
    // A prefilled settings field isn't someone's work until they are in it.
    if (field instanceof HTMLTextAreaElement || field === focused) return true;
  }
  return focused instanceof HTMLElement && focused.isContentEditable
    ? (focused.textContent ?? "").trim().length > 0
    : false;
}

/**
 * After a host update, a tab still running the old web build reloads onto the new one when
 * nothing would be lost; otherwise it says so here and reloads once it is hidden and idle.
 */
export function KinUpdatedLine() {
  const serverBuild = useAtomValue(serverBuildAtom);
  const [noticeFor, setNoticeFor] = useState<string | null>(null);
  const noticeShown = serverBuild !== undefined && noticeFor === serverBuild;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads the page and follows document visibility, both outside React.
  useEffect(() => {
    if (serverBuild === undefined) return;
    const decide = () => {
      const action = kinUpdatedAction({
        dev: devBundle,
        pageBuild: pageBuild(),
        serverBuild,
        busy: kinPageIsBusy(),
        hidden: document.visibilityState === "hidden",
        noticeShown,
        reloadedFor: readReloadedFor(),
      });
      if (action === "reload") reloadFor(serverBuild);
      else if (action === "notice") setNoticeFor(serverBuild);
    };
    decide();
    if (!noticeShown) return;
    document.addEventListener("visibilitychange", decide);
    return () => document.removeEventListener("visibilitychange", decide);
  }, [serverBuild, noticeShown]);

  if (!noticeShown) return null;
  return (
    <p
      role="status"
      className="shrink-0 border-b border-border px-4 py-1.5 text-center text-xs text-muted-foreground"
    >
      {KIN_UPDATED_LINE}{" "}
      <Button
        size="xs"
        variant="link"
        onClick={() => {
          carryKinDraftsAcrossReload();
          reloadFor(serverBuild);
        }}
      >
        {KIN_UPDATED_RELOAD}
      </Button>
    </p>
  );
}

/** A page whose code an update replaced, after the one automatic reload didn't bring it back. */
export function KinUpdatedPage() {
  return (
    <StandalonePage>
      <StandalonePageHeader
        title={KIN_UPDATED_CONTINUE.title}
        description={KIN_UPDATED_CONTINUE.detail}
      />
      <div className="mt-5">
        <Button size="sm" onClick={reloadKeepingKinDrafts}>
          {KIN_UPDATED_RELOAD}
        </Button>
      </div>
    </StandalonePage>
  );
}
