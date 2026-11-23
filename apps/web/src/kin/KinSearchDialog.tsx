import { useKinViewerScope } from "./useKinOwnerLevel";
import {
  KIN_SEARCH,
  kinSearchHint,
  kinSearchPlaceholder,
  type KinSearchHitView,
} from "@t3tools/client-runtime/kin/kinDocs";
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
import { useKinShell } from "./useKinShell";

/** One search box over tasks, clients, contacts, projects, docs, money and, for the owner level, memory. */
export function KinSearchDialog(
  props: KinWorkTarget & {
    readonly onOpen: (hit: KinSearchHitView) => void;
    readonly onClose: () => void;
  },
) {
  const { state, search } = useKinSearch(props, null);
  const scope = useKinViewerScope(props.environmentId);
  const shell = useKinShell(props.environmentId);
  const placeholder = kinSearchPlaceholder(shell);
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
              aria-label={placeholder}
              placeholder={placeholder}
              value={state.text}
              onChange={(event) => search.setText(event.currentTarget.value)}
            />
            <div className="flex items-center gap-2">
              <Switch id={closedId} checked={state.closed} onCheckedChange={search.setClosed} />
              <Label htmlFor={closedId}>{KIN_SEARCH.includeClosed}</Label>
            </div>
            {state.text.trim() === "" ? (
              <KinWorkNotice {...kinSearchHint(scope, shell)} />
            ) : (
              <KinSearchHits
                state={state}
                scope={scope}
                onRetry={search.retry}
                onOpen={props.onOpen}
              />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
