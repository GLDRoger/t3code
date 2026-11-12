import { KIN_SEARCH, type KinSearchHitView } from "@t3tools/client-runtime/kin/kinDocs";
import { useId } from "react";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { KinSearchHits } from "./KinDocsList";
import { KinWorkNotice } from "./KinWorkParts";
import { useKinSearch } from "./useKinDocs";
import type { KinWorkTarget } from "./useKinWork";

/** One search box over tasks, clients, contacts, projects and docs. */
export function KinSearchDialog(
  props: KinWorkTarget & {
    readonly onOpen: (hit: KinSearchHitView) => void;
    readonly onClose: () => void;
  },
) {
  const { state, search } = useKinSearch(props, null);
  const closedId = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{KIN_SEARCH.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex min-h-64 flex-col gap-3">
            <Input
              type="search"
              autoFocus
              autoComplete="off"
              aria-label={KIN_SEARCH.placeholder}
              placeholder={KIN_SEARCH.placeholder}
              value={state.text}
              onChange={(event) => search.setText(event.currentTarget.value)}
            />
            <div className="flex items-center gap-2">
              <Switch id={closedId} checked={state.closed} onCheckedChange={search.setClosed} />
              <Label htmlFor={closedId}>{KIN_SEARCH.includeClosed}</Label>
            </div>
            {state.text.trim() === "" ? (
              <KinWorkNotice {...KIN_SEARCH.hint} />
            ) : (
              <KinSearchHits state={state} onRetry={search.retry} onOpen={props.onOpen} />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
