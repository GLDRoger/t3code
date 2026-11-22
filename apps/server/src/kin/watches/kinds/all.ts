import { invoicePaid } from "./invoicePaid.ts";
import type { WatchKind } from "./kind.ts";
import { pr } from "./pr.ts";
import { taskOut } from "./taskOut.ts";
import { turnFailed } from "./turnFailed.ts";

/** Every kind the round runs, in order. Kinds still to come (host, asked, …) join this list. */
export const ALL_KINDS: ReadonlyArray<WatchKind> = [invoicePaid, taskOut, pr, turnFailed];

export const kindOf = (kind: string) => ALL_KINDS.find((one) => one.kind === kind);
