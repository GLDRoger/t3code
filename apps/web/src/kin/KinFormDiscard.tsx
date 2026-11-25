import { KIN_FORM_DISCARD } from "@t3tools/client-runtime/kin/kinWorkForms";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";

/**
 * Closing a form that holds unsaved typing asks "Discard what you typed?" first; an untouched
 * form closes at once. Route Cancel, Escape and a click outside through `close`, and render `ask`
 * inside the form's dialog.
 */
export function useKinFormDiscard(typed: boolean, onClose: () => void) {
  const [asking, setAsking] = useState(false);
  const close = () => {
    if (typed) setAsking(true);
    else onClose();
  };
  const ask = (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{KIN_FORM_DISCARD.title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {KIN_FORM_DISCARD.keep}
          </AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              setAsking(false);
              onClose();
            }}
          >
            {KIN_FORM_DISCARD.discard}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
  return { close, ask };
}
