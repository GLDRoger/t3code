import { Blobatar } from "@blobatar/react";
import type { KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";

import { cn } from "../lib/utils";

/**
 * The frame says what it is (DESIGN 8.7): an agent is an outlined square, a person a filled
 * circle, a group a filled square. The blobatar inside says which one. Static, so nothing repaints.
 */
export function KinAvatar(props: {
  readonly avatar: KinAvatarView;
  /** `sm` sits in a header beside the chat's title. */
  readonly size?: "md" | "sm";
}) {
  const { kind, seed } = props.avatar;
  const small = props.size === "sm";
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        small ? "size-7" : "size-9",
        kind === "agent" && "border-2 border-primary",
        kind === "agent" && (small ? "rounded-md" : "rounded-lg"),
        kind === "person" && "rounded-full border bg-secondary",
        kind === "group" && "border bg-secondary",
        kind === "group" && (small ? "rounded-md" : "rounded-lg"),
      )}
    >
      <Blobatar name={seed} size={small ? 24 : 32} alt="" draggable={false} />
    </span>
  );
}
