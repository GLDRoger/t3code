import { KIN_NOTES, kinNotesVersions } from "@t3tools/client-runtime/kin/kinTemplates";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordDetail } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";

/** Earlier versions of an entry's notes, folded away, each with who wrote it and a way back. */
export function KinNotesVersions(props: {
  readonly item: KinRecordDetail;
  readonly names: KinWorkNames;
  readonly now: Date;
  readonly busy: boolean;
  /** Null where this device may not change the entry. */
  readonly onRestore: ((notes: string) => void) | null;
}) {
  const versions = kinNotesVersions(props.item, props.names, props.now);
  const [open, setOpen] = useState(false);
  if (versions.length === 0) return null;
  return (
    <ListSection>
      <ListActionRow
        label={open ? "Hide earlier versions" : KIN_NOTES.earlier(versions.length)}
        onPress={() => setOpen(!open)}
      />
      {open
        ? versions.map((version) => (
            <View key={version.key}>
              <View className="gap-1 px-4 py-3">
                <Text textRole="footnote" className="text-foreground-muted">
                  {version.by ?? KIN_NOTES.first}
                </Text>
                <Text textRole="body" selectable numberOfLines={6} className="text-foreground">
                  {version.text}
                </Text>
              </View>
              {props.onRestore === null ? null : (
                <ListActionRow
                  icon="arrow.uturn.backward"
                  label={KIN_NOTES.restore}
                  disabled={props.busy}
                  onPress={() =>
                    Dialog.confirm({
                      title: KIN_NOTES.restoreTitle,
                      message: KIN_NOTES.restoreDetail,
                      confirmText: KIN_NOTES.restore,
                      onConfirm: () => props.onRestore?.(version.text),
                    })
                  }
                />
              )}
            </View>
          ))
        : null}
    </ListSection>
  );
}
