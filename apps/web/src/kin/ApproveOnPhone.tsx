import { SmartphoneIcon } from "lucide-react";

/** Approvals need the phone's device key, so the browser points there instead. */
export function ApproveOnPhone() {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <SmartphoneIcon aria-hidden className="size-3.5" />
      Approve on your phone
    </p>
  );
}
