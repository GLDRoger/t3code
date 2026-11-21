import { EnvironmentId, KinKeyThumbprint, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";

// Public facts only: the private key never leaves the Secure Enclave or Keystore.
const STORE_KEY = "t3code.kin.approval-key";

/** Which host and org this phone's one approval key is registered with. */
const Record = Schema.Struct({
  environmentId: EnvironmentId,
  orgId: KinOrgId,
  thumbprint: KinKeyThumbprint,
});
export type KinApproverKeyRecord = typeof Record.Type;
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Record));

export async function readApproverKeyRecord(): Promise<KinApproverKeyRecord | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  return raw === null ? null : Option.getOrNull(decode(raw));
}

export const kinApproverKeyRecordAtom = connectionAtomRuntime
  .atom(Effect.promise(readApproverKeyRecord))
  .pipe(Atom.withLabel("kin:approver-key-record"));

export async function saveApproverKeyRecord(record: KinApproverKeyRecord): Promise<void> {
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(record));
  appAtomRegistry.refresh(kinApproverKeyRecordAtom);
}

export async function clearApproverKeyRecord(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY);
  appAtomRegistry.refresh(kinApproverKeyRecordAtom);
}

// Keys this phone replaced whose host hasn't confirmed dropping them yet.
const PENDING_KEY = "t3code.kin.approval-key.pending";
const decodePending = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Record)));
const sameKey = (a: KinApproverKeyRecord, b: KinApproverKeyRecord) =>
  a.environmentId === b.environmentId && a.orgId === b.orgId && a.thumbprint === b.thumbprint;

export async function readPendingKeyCleanup(): Promise<ReadonlyArray<KinApproverKeyRecord>> {
  const raw = await SecureStore.getItemAsync(PENDING_KEY);
  return raw === null ? [] : Option.getOrElse(decodePending(raw), () => []);
}

export async function addPendingKeyCleanup(record: KinApproverKeyRecord): Promise<void> {
  const pending = await readPendingKeyCleanup();
  if (pending.some((one) => sameKey(one, record))) return;
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify([...pending, record]));
}

export async function removePendingKeyCleanup(record: KinApproverKeyRecord): Promise<void> {
  const pending = (await readPendingKeyCleanup()).filter((one) => !sameKey(one, record));
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(pending));
}
