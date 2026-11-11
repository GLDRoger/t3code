import type { KinRecordState } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  HourglassIcon,
} from "lucide-react";

import { cn } from "../lib/utils";

const STATE_ICON: Record<
  KinRecordState,
  { readonly icon: typeof CircleIcon; readonly className: string }
> = {
  open: { icon: CircleIcon, className: "text-muted-foreground" },
  doing: { icon: CircleDotIcon, className: "text-info-foreground" },
  waiting: { icon: HourglassIcon, className: "text-warning-foreground" },
  done: { icon: CircleCheckIcon, className: "text-success-foreground" },
  dropped: { icon: CircleSlashIcon, className: "text-muted-foreground" },
};

export function KinWorkStateIcon(props: { readonly state: KinRecordState }) {
  const { icon: Icon, className } = STATE_ICON[props.state];
  return <Icon aria-hidden className={cn("size-4 shrink-0", className)} />;
}
