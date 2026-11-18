import { useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";

/**
 * Open state for a dialog kept outside the URL. It belongs to the page entry it opened on, so Back
 * closes it instead of leaving it over whatever sheet that entry brings back.
 */
export function useKinFormOpen() {
  const entry = useLocation({ select: (location) => location.href });
  const [openOn, setOpenOn] = useState<string | null>(null);
  if (openOn !== null && openOn !== entry) setOpenOn(null);
  const setOpen = (open: boolean) => setOpenOn(open ? entry : null);
  return [openOn === entry, setOpen] as const;
}

/**
 * One detail view as a side sheet over a Kin page, or as a dialog over Settings: a sheet sits on
 * the layer under dialogs, so one opened from the Settings modal would land behind it. One sheet
 * at a time: a detail hides while a form opened from it is open, and comes back after.
 */
export const KIN_SHEET_PARTS = {
  Root: Sheet,
  Popup: (props: { readonly children: ReactNode }) => (
    <SheetPopup side="right" className="data-nested-dialog-open:hidden">
      {props.children}
    </SheetPopup>
  ),
  Header: SheetHeader,
  Title: SheetTitle,
  Description: SheetDescription,
};
export const KIN_DIALOG_PARTS = {
  Root: Dialog,
  Popup: (props: { readonly children: ReactNode }) => (
    <DialogPopup className="data-nested-dialog-open:hidden">{props.children}</DialogPopup>
  ),
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
};
