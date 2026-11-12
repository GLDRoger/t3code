import { useAtomValue } from "@effect/atom-react";

import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_TEMPLATES,
  kinTemplateGroups,
  type KinTemplateView,
} from "@t3tools/client-runtime/kin/kinTemplates";

import { AsyncResult } from "effect/reactivity";

import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal } from "../../components/ui/FilePreviewModal";
import { ListActionRow } from "../../components/ui/ListActionRow";

import { ListSection } from "../../components/ui/ListSection";

import { Notice } from "../../components/ui/Notice";
import { appAtomRegistry } from "../../state/atom-registry";

import { useAtomCommand } from "../../state/use-atom-command";
import type { AttachmentPreviewFile } from "../../lib/attachmentDownload";
import { KinWorkLoading } from "./components/KinWorkPieces";
import { kinWritePreview } from "./KinInvoice";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinAskAgent, useKinMoneyActions, useKinRecipes } from "./state/useKinMoney";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

/** The templates Kin makes documents from: who changed each last, a preview, and ways back. */
export function KinTemplateRows(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.companyRead.permissionAtom(environmentId));
  const canUndo = useAtomValue(kinClient.undoRecipe.permissionAtom(environmentId));
  const canLabel = useAtomValue(kinClient.labelRecipe.permissionAtom(environmentId));
  const canDefault = useAtomValue(kinClient.setDefaultRecipe.permissionAtom(environmentId));
  const canPreview = useAtomValue(kinClient.docRender.permissionAtom(environmentId));
  const recipes = useKinRecipes(props, allowed);
  const { names } = useKinWorkDirectory(props, allowed);
  const asker = useKinAskAgent(props);
  const actions = useKinMoneyActions(props);
  const undo = useAtomCommand(kinClient.undoRecipe, { reportFailure: false });
  const label = useAtomCommand(kinClient.labelRecipe, { reportFailure: false });
  const setDefault = useAtomCommand(kinClient.setDefaultRecipe, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const [shown, setShown] = useState<{
    readonly file: AttachmentPreviewFile;
    readonly name: string;
    readonly mimeType: string;
  } | null>(null);
  const [now] = useState(() => new Date());
  const preview = async (template: KinTemplateView, list: string | null) => {
    setSaid(null);
    let entry;
    if (list !== null) {
      const latest = await kinClient.workList.run(appAtomRegistry, {
        environmentId,
        input: { orgId, list, limit: 1 },
      });
      entry = AsyncResult.isSuccess(latest) ? latest.value.records[0]?.key : undefined;
      if (entry === undefined) return setSaid({ ok: false, text: KIN_TEMPLATES.noPreviewEntry });
    }
    const files = await actions.preview(template.name, entry);
    const file = files?.[0];
    if (file === undefined) {
      if (files !== null) setSaid({ ok: false, text: KIN_TEMPLATES.previewFailed });
      return;
    }
    const written = await kinWritePreview(file);
    if (typeof written === "string") return setSaid({ ok: false, text: written });
    shown?.file.dispose();
    setShown({ file: written, name: file.name, mimeType: file.mimeType });
  };
  const run = async (kind: "undo" | "clear" | "set", template: KinTemplateView) => {
    setBusy(true);
    setSaid(null);
    const input = { orgId, recipe: template.name };
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        kind === "undo"
          ? undo({ environmentId, input })
          : label({
              environmentId,
              input: { ...input, commit: template.commit, sensitive: kind === "set" },
            }),
    });
    setBusy(false);
    recipes.refresh();
    if (!outcome.ok) return setSaid({ ok: false, text: outcome.problem });
    setSaid({
      ok: true,
      text:
        kind === "clear"
          ? KIN_TEMPLATES.cleared
          : kind === "set"
            ? KIN_TEMPLATES.set
            : "removed" in outcome.value && outcome.value.removed
              ? KIN_TEMPLATES.removed
              : KIN_TEMPLATES.undone,
    });
  };
  const makeDefault = async (template: KinTemplateView, list: string) => {
    setBusy(true);
    setSaid(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => setDefault({ environmentId, input: { orgId, recipe: template.name } }),
    });
    setBusy(false);
    recipes.refresh();
    setSaid(
      outcome.ok
        ? { ok: true, text: KIN_TEMPLATES.defaultSet(list) }
        : { ok: false, text: outcome.problem },
    );
  };
  if (!allowed) return null;
  const { state } = recipes;
  return (
    <>
      <ListSection title={KIN_TEMPLATES.title} footer={KIN_TEMPLATES.detail}>
        {asker === null ? null : (
          <ListActionRow
            icon="bubble.left"
            label={KIN_TEMPLATES.askChange}
            onPress={() => asker.ask(KIN_TEMPLATES.askChangeDraft)}
          />
        )}
      </ListSection>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading templates" />
      ) : state._tag !== "ready" ? (
        <View className="items-start gap-2 px-2">
          <Notice message="Couldn't load your templates. Check your connection." tone="danger" />
          <Button tone="secondary" label="Try again" onPress={recipes.refresh} />
        </View>
      ) : state.value.recipes.length === 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_TEMPLATES.empty}
        </Text>
      ) : (
        kinTemplateGroups(state.value.recipes, names, now).map((group) => (
          <ListSection key={group.list ?? "other"} title={group.title}>
            {group.templates.map((template) => (
              <View key={template.name}>
                <View className="gap-1 px-4 py-3">
                  <View className="flex-row items-center gap-2">
                    <Text textRole="body" className="font-t3-medium text-foreground">
                      {template.title}
                    </Text>
                    {template.labelled || template.alwaysPrivate ? (
                      <Text textRole="footnote" className="font-t3-medium text-warning-foreground">
                        {KIN_TEMPLATES.private}
                      </Text>
                    ) : null}
                  </View>
                  {template.isDefault && group.list !== null ? (
                    <Text textRole="footnote" className="font-t3-medium text-foreground">
                      {KIN_TEMPLATES.isDefault(group.title)}
                    </Text>
                  ) : null}
                  {template.description === null ? null : (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {template.description}
                    </Text>
                  )}
                  <Text textRole="footnote" className="text-foreground-muted">
                    {template.changed}
                  </Text>
                  {template.alwaysPrivate || template.labelled ? (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {template.alwaysPrivate
                        ? KIN_TEMPLATES.alwaysPrivateDetail
                        : KIN_TEMPLATES.privateDetail}
                    </Text>
                  ) : null}
                </View>
                {canPreview ? (
                  <ListActionRow
                    icon="eye"
                    label={KIN_TEMPLATES.preview}
                    disabled={actions.busy || busy}
                    loading={actions.busy}
                    onPress={() => void preview(template, group.list)}
                  />
                ) : null}
                {canUndo && template.canUndo ? (
                  <ListActionRow
                    icon="arrow.uturn.backward"
                    label={KIN_TEMPLATES.undo}
                    disabled={busy}
                    onPress={() =>
                      Dialog.confirm({
                        title: KIN_TEMPLATES.undoTitle,
                        message: KIN_TEMPLATES.undoDetail,
                        confirmText: KIN_TEMPLATES.undo,
                        onConfirm: () => void run("undo", template),
                      })
                    }
                  />
                ) : null}
                {canDefault && group.list !== null && !template.isDefault ? (
                  <ListActionRow
                    icon="checkmark.circle"
                    label={KIN_TEMPLATES.pickFor(group.title)}
                    disabled={busy}
                    onPress={() => void makeDefault(template, group.title)}
                  />
                ) : null}
                {canLabel && !template.alwaysPrivate ? (
                  <ListActionRow
                    icon="lock"
                    label={
                      template.labelled ? KIN_TEMPLATES.clearPrivate : KIN_TEMPLATES.setPrivate
                    }
                    disabled={busy}
                    onPress={() =>
                      Dialog.confirm(
                        template.labelled
                          ? {
                              title: KIN_TEMPLATES.clearTitle,
                              message: KIN_TEMPLATES.clearDetail,
                              confirmText: KIN_TEMPLATES.clearPrivate,
                              onConfirm: () => void run("clear", template),
                            }
                          : {
                              title: KIN_TEMPLATES.setTitle,
                              message: KIN_TEMPLATES.setDetail,
                              confirmText: KIN_TEMPLATES.setPrivate,
                              onConfirm: () => void run("set", template),
                            },
                      )
                    }
                  />
                ) : null}
              </View>
            ))}
          </ListSection>
        ))
      )}
      {actions.problem !== null || (said !== null && !said.ok) ? (
        <Notice message={actions.problem ?? said?.text ?? ""} tone="danger" />
      ) : said !== null ? (
        <Notice message={said.text} icon="checkmark.circle" />
      ) : null}
      <FilePreviewModal
        source={
          shown === null
            ? null
            : { kind: "pdf", uri: shown.file.uri, name: shown.name, mimeType: shown.mimeType }
        }
        onRequestClose={() => {
          shown?.file.dispose();
          setShown(null);
        }}
      />
    </>
  );
}
