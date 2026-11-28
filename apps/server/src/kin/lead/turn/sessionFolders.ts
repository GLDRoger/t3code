import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

type Session = { readonly threadId: ThreadId; readonly providerSessionId: string };

export const sessionFolderKey = ({ threadId, providerSessionId }: Session) =>
  JSON.stringify([threadId, providerSessionId]);

/** The roots of the open provider query for a thread bearer, never roots named by the caller. */
export const KinSessionFolders = Context.Reference<Map<string, ReadonlyArray<string>>>(
  "t3/kin/lead/KinSessionFolders",
  { defaultValue: () => new Map() },
);
