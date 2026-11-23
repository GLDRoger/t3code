import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DOC_HOMES,
  KIN_DOC_KIND_LABELS,
  kinDocFileDraft,
  kinDocFileInput,
  type KinDocFileDraft,
} from "@t3tools/client-runtime/kin/kinDocs";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_DOC_KINDS, type KinDocListRow } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import { kinWorkChoicesAtom, type KinWorkTarget } from "./useKinWork";
import { useKinSectionOn } from "./useKinShell";

const NO_PROJECT = "";

/** A doc's kind and its one home, a client and project or the company, set in one dialog. */
export function KinDocFileDialog(
  props: KinWorkTarget & {
    readonly doc: Pick<
      KinDocListRow,
      "key" | "rev" | "title" | "kind" | "company" | "party" | "project"
    >;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, doc } = props;
  const ids = { home: useId(), project: useId(), kind: useId() };
  const file = useAtomCommand(kinClient.docFile, { reportFailure: false });
  const held = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinWorkChoicesAtom({ environmentId, orgId }))),
  );
  const [draft, setDraft] = useState<KinDocFileDraft>(() => kinDocFileDraft(doc));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // With Clients off a doc is filed under the company or nothing, never a client.
  const clientsOn = useKinSectionOn(environmentId, "clients");
  const clients = clientsOn
    ? (held?.clients ?? []).filter((one) => one.active && one.kind === "client")
    : [];
  const projects = (held?.projects ?? []).filter(
    (one) =>
      one.state === "open" &&
      (draft.home === "none" ? one.party === null : one.party?.key === draft.home),
  );
  const homes = [
    { value: "company", label: KIN_DOC_HOMES.company },
    ...clients.map((one) => ({ value: String(one.key), label: one.name })),
    { value: "none", label: KIN_DOC_HOMES.noClient },
  ];
  // A client the list no longer offers still reads as itself until it is changed.
  const homeLabel =
    homes.find((one) => one.value === draft.home)?.label ?? doc.party?.title ?? draft.home;
  const projectLabel =
    draft.project === null
      ? "No project"
      : (projects.find((one) => one.key === draft.project)?.name ??
        doc.project?.title ??
        draft.project);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => file({ environmentId, input: kinDocFileInput(orgId, doc, draft) }),
    });
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    props.onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{KIN_DOC_HOMES.fileTitle}</DialogTitle>
            <DialogDescription>{doc.title}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.home}>{KIN_DOC_HOMES.home}</Label>
                <Select
                  value={draft.home}
                  onValueChange={(value) =>
                    setDraft({ ...draft, home: String(value), project: null })
                  }
                >
                  <SelectTrigger id={ids.home} className="w-full min-w-0">
                    <SelectValue>{homeLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {homes.map((home) => (
                      <SelectItem key={home.value} value={home.value}>
                        {home.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {draft.home === "company" ||
              (projects.length === 0 && draft.project === null) ? null : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.project}>Project</Label>
                  <Select
                    value={draft.project ?? NO_PROJECT}
                    onValueChange={(value) =>
                      setDraft({ ...draft, project: value === NO_PROJECT ? null : String(value) })
                    }
                  >
                    <SelectTrigger id={ids.project} className="w-full min-w-0">
                      <SelectValue>{projectLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      <SelectItem value={NO_PROJECT}>No project</SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.key} value={project.key}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.kind}>{KIN_DOC_HOMES.kind}</Label>
                <Select
                  value={draft.kind}
                  onValueChange={(value) => {
                    const kind = KIN_DOC_KINDS.find((one) => one === value);
                    if (kind !== undefined) setDraft({ ...draft, kind });
                  }}
                >
                  <SelectTrigger id={ids.kind} className="w-full min-w-0">
                    <SelectValue>{KIN_DOC_KIND_LABELS[draft.kind].one}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {KIN_DOC_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {KIN_DOC_KIND_LABELS[kind].one}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} aria-busy={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
