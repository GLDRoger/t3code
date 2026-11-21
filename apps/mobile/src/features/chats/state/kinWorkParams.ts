import { KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type KinWorkParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The place that opens: `tasks`, `clients`, `projects`, `docs` or `money`; Tasks otherwise. */
  readonly show?: string;
  /** The client the tasks start narrowed to, or a new task starts under. */
  readonly party?: string;
  readonly partyName?: string;
  readonly project?: string;
  readonly projectName?: string;
  /** `theirs` when a new task is something the client owes. */
  readonly side?: string;
  /** Tasks starts narrowed to what this person holds, from their page's "See all in Tasks". */
  readonly person?: string;
};

const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** A client or project named in a link: its handle, and the name to show until it is read. */
export function kinWorkRefParam(key: string | undefined, title: string | undefined) {
  const held = Option.getOrNull(decodeKey(key));
  return held === null ? null : { key: held, title: title ?? held };
}
