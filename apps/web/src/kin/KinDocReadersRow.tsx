import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DOC_READERS,
  kinDocReaders,
  type KinDocReaders,
} from "@t3tools/client-runtime/kin/kinDocs";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinDocDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/** Who can read a teammate's doc, with a Change menu for the choices the host allows this viewer. */
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
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{KIN_DOC_READERS.title}</span>
        <p className="text-xs text-muted-foreground">
          {failed ? KIN_DOC_READERS.failed : readers.answer}
        </p>
      </div>
      {readers.choices.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={props.disabled || pending}
                aria-label={`${KIN_DOC_READERS.title}: ${readers.answer} ${KIN_DOC_READERS.change}`}
              />
            }
          >
            {KIN_DOC_READERS.change}
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={readers.current}
              onValueChange={(value) => {
                const to = readers.choices.find((choice) => choice.id === value)?.id;
                if (to !== undefined) pick(to);
              }}
            >
              {readers.choices.map((choice) => (
                <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
                  {choice.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
