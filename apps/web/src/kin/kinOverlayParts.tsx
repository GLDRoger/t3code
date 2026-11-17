import type { ReactNode } from "react";

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
 * One detail view as a side sheet over a Kin page, or as a dialog over Settings: a sheet sits on
 * the layer under dialogs, so one opened from the Settings modal would land behind it.
 */
export const KIN_SHEET_PARTS = {
  Root: Sheet,
  Popup: (props: { readonly children: ReactNode }) => (
    <SheetPopup side="right">{props.children}</SheetPopup>
  ),
  Header: SheetHeader,
  Title: SheetTitle,
  Description: SheetDescription,
};
export const KIN_DIALOG_PARTS = {
  Root: Dialog,
  Popup: (props: { readonly children: ReactNode }) => <DialogPopup>{props.children}</DialogPopup>,
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
};
