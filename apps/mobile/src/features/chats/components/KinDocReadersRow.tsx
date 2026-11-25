import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DOC_READERS,
  kinDocReaders,
  type KinDocReaders,
} from "@t3tools/client-runtime/kin/kinDocs";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinDocDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import type { KinWorkTarget } from "../state/useKinWork";

/** Who can read a teammate's doc, with a sheet list for the choices the host allows this viewer. */
export function KinDocReadersRow(
  props: KinWorkTarget & {
    readonly doc: Pick<
      KinDocDetail,
      "key" | "rev" | "readers" | "readersCan" | "draftOf" | "project" | "owner" | "kindLabel"
    >;
    readonly names: KinWorkNames;
    readonly disabled: boolean;
    readonly onSettled: () => void;
  },
) {
  const { environmentId, orgId, doc } = props;
  const canChange = useAtomValue(kinClient.docReaders.permissionAtom(environmentId));
  const setReaders = useAtomCommand(kinClient.docReaders, { reportFailure: false });
  // What was asked, held only until the host's read moves past the revision it was asked from.
  const [asked, setAsked] = useState<{
    readonly to: KinDocReaders;
    readonly from: KinDocReaders;
    readonly rev: number;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const current =
    asked !== null && asked.from === doc.readers && asked.rev === doc.rev ? asked.to : doc.readers;
  const readers = kinDocReaders(
    { ...doc, readers: current, readersCan: canChange ? doc.readersCan : [] },
    props.names,
  );
  if (readers === null) return null;
  const pick = (to: KinDocReaders) => {
    if (props.disabled || pending || doc.readers === undefined || to === readers.current) return;
    setAsked({ to, from: doc.readers, rev: doc.rev });
    setPending(true);
    setFailed(false);
    void setReaders({
      environmentId,
      input: { orgId, key: doc.key, to, rev: doc.rev },
    }).then((outcome) => {
      const refused = AsyncResult.isFailure(outcome);
      setFailed(refused);
      setPending(false);
      if (refused) setAsked(null);
      props.onSettled();
    });
  };
  const icon = readers.current === "draft" ? "lock" : "eye";
  const description = failed ? KIN_DOC_READERS.failed : readers.answer;
  if (readers.choices.length === 0) {
    return (
      <View accessible accessibilityLabel={`${KIN_DOC_READERS.title}: ${description}`}>
        <ListRowLayout
          icon={icon}
          label={KIN_DOC_READERS.title}
          description={description}
          disabled={props.disabled || pending}
        />
      </View>
    );
  }
  return (
    <>
      <ListRow
        icon={icon}
        label={KIN_DOC_READERS.title}
        description={description}
        detail={KIN_DOC_READERS.change}
        disabled={props.disabled || pending}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <Sheet
          title={KIN_DOC_READERS.title}
          onClose={() => setOpen(false)}
          dismissDisabled={pending}
        >
          <View className="gap-4 px-4 pt-2 pb-10">
            <ListSection>
              {readers.choices.map((choice, index) => (
                <ListChoiceRow
                  key={choice.id}
                  label={choice.label}
                  selected={choice.id === readers.current}
                  separated={index > 0}
                  disabled={pending}
                  onPress={() => {
                    setOpen(false);
                    pick(choice.id);
                  }}
                />
              ))}
            </ListSection>
          </View>
        </Sheet>
      ) : null}
    </>
  );
}
