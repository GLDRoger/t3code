import { Blobatar } from "@blobatar/react";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { BotIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { useKinPicture } from "./kinPictures";

const PIXELS = { lg: 72, md: 32, sm: 24, xs: 16 } as const;
/** About 30% of the side, as the phone draws it, on the nearest radius token. */
const TILE_RADIUS = {
  lg: "rounded-3xl",
  md: "rounded-lg",
  sm: "rounded-lg",
  xs: "rounded-sm",
} as const;

/**
 * Who a chat is with: the picture they chose, else the blobatar for their stable id. An agent is a
 * rounded tile with the robot mark, so it is never mistaken for a person at a glance.
 */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `sm` sits in a header beside the chat's title; `xs` leads an author line; `lg` heads a profile. */
  readonly size?: "lg" | "md" | "sm" | "xs";
}) {
  const size = PIXELS[props.size ?? "md"];
  const tileRadius = TILE_RADIUS[props.size ?? "md"];
  const picture = useKinPicture(props.avatar.seed);
  if (props.avatar.kind === "agent")
    return (
      <span
        aria-hidden
        data-kin-avatar="agent"
        className={cn(
          "flex shrink-0 items-center justify-center bg-update/12 text-update-foreground dark:bg-update/20",
          tileRadius,
        )}
        style={{ width: size, height: size }}
      >
        <BotIcon style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6) }} />
      </span>
    );
  return (
    <span aria-hidden data-kin-avatar={props.avatar.kind} className="flex shrink-0">
      {picture === undefined ? (
        <Blobatar name={props.avatar.seed} size={size} alt="" draggable={false} />
      ) : (
        <img
          src={picture}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="rounded-full object-cover"
          style={{ width: size, height: size }}
        />
      )}
    </span>
  );
}
