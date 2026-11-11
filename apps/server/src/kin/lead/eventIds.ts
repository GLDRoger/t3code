// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinEventId } from "@t3tools/contracts";

/** The memory writer accepts only `[a-zA-Z0-9_-]` in event ids, so a readable key is hashed. */
export const hashedEventId = (prefix: string, key: string) =>
  KinEventId.make(
    `${prefix}-${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
  );
