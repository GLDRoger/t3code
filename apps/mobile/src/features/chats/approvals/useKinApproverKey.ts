import { useAtomValue } from "@effect/atom-react";
import { encodeGrantSigningInput } from "@t3tools/shared/kinGrant";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  kinApprovalFailure,
  kinChallengeMatchesCard,
  type KinApprovalDeviceCode,
  type KinApprovalFailure,
} from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import {
  KIN_APPROVER_ENROLMENT_VERSION,
  KinApprovalError,
  type EnvironmentId,
  type KinApprovalsListKeysResult,
  type KinApproverKey,
  type KinOrgId,
  type KinPendingAction,
  type KinPendingActionState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import { AsyncResult } from "effect/reactivity";
import * as Device from "expo-device";
import * as ExpoCrypto from "expo-crypto";
import { Platform } from "react-native";

import * as ApprovalKey from "../../../../modules/kin-approval-key";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  addPendingKeyCleanup,
  clearApproverKeyRecord,
  kinApproverKeyRecordAtom,
  readApproverKeyRecord,
  readPendingKeyCleanup,
  removePendingKeyCleanup,
  saveApproverKeyRecord,
  type KinApproverKeyRecord,
} from "./approverKeyRecord";
import {
  createKinApproverKeyCleanup,
  createKinApproverKeyEnrolment,
  type KinApproverKeyRef,
  type KinEnrolOutcome,
  type KinRevokeAnswer,
} from "./approverKeyReplace";

/** Where this phone's approval key stands with one host and org, beside the org's other phones. */
export type KinApproverKeyStatus =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unreadable"; readonly retry: () => void }
  | ({
      readonly _tag: "ready";
      /** This phone's key while it can approve; null when it has none, or one that was removed. */
      readonly own: KinApproverKey | null;
      /** This phone holds a key the host no longer accepts, so setting up replaces it. */
      readonly staleKey: boolean;
      /** The other host and org this phone's one key approves for, which a new key ends. */
      readonly elsewhere: KinApproverKeyRecord | null;
      /** The key record this phone holds now, which a replacement must still match. */
      readonly saved: KinApproverKeyRecord | null;
    } & KinApprovalsListKeysResult);

export function useKinApproverKey(environmentId: EnvironmentId, orgId: KinOrgId) {
  const record = useAtomValue(kinApproverKeyRecordAtom);
  const keysAtom = kinClient.approverKeys({ environmentId, input: { orgId } });
  const keys = useAtomValue(keysAtom);
  const refresh = () => {
    appAtomRegistry.refresh(kinApproverKeyRecordAtom);
    appAtomRegistry.refresh(keysAtom);
  };
  return { status: approverKeyStatus(record, keys, environmentId, orgId, refresh), refresh };
}

function approverKeyStatus(
  record: AsyncResult.AsyncResult<KinApproverKeyRecord | null, unknown>,
  keys: AsyncResult.AsyncResult<KinApprovalsListKeysResult, unknown>,
  environmentId: EnvironmentId,
  orgId: KinOrgId,
  retry: () => void,
): KinApproverKeyStatus {
  if (AsyncResult.isInitial(record) || AsyncResult.isInitial(keys)) return { _tag: "loading" };
  if (AsyncResult.isFailure(record) || AsyncResult.isFailure(keys))
    return { _tag: "unreadable", retry };
  const saved = record.value;
  const here =
    saved !== null && saved.environmentId === environmentId && saved.orgId === orgId ? saved : null;
  const own = keys.value.keys.find((key) => here !== null && key.thumbprint === here.thumbprint);
  // The list holds only keys that can approve, so a removed key reads as gone.
  return {
    _tag: "ready",
    own: own ?? null,
    staleKey: saved !== null && own === undefined,
    elsewhere: saved !== null && here === null ? saved : null,
    saved,
    ...keys.value,
  };
}

const deviceCodeOf = (error: unknown): KinApprovalDeviceCode | null =>
  ApprovalKey.isKinApprovalKeyError(error) ? error.code : null;

export type KinApprovalOutcome =
  | { readonly _tag: "done"; readonly state: KinPendingActionState }
  | { readonly _tag: "failed"; readonly failure: KinApprovalFailure }
  | { readonly _tag: "canceled" };

const failedFrom = (cause: unknown, deviceCode: KinApprovalDeviceCode | null = null) => {
  const failure = kinApprovalFailure(cause, deviceCode);
  return failure === null
    ? ({ _tag: "canceled" } as const)
    : ({ _tag: "failed", failure } as const);
};

const notMatching: KinApprovalOutcome = {
  _tag: "failed",
  failure: {
    text: "This changed since you opened it. Check it again before you approve.",
    refresh: true,
    reenrol: false,
  },
};

/** `keyExists`: this phone holds a key the host doesn't know; replacing it is the way out. */
export interface KinEnrolFailure {
  readonly text: string;
  readonly keyExists: boolean;
}
interface EnrolTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

// A revoke never holds up setup longer than this; one that doesn't answer is asked again later.
const REVOKE_WAIT_MS = 4_000;

async function revokeReplaced(ref: KinApproverKeyRef): Promise<KinRevokeAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    runAtomCommand(
      appAtomRegistry,
      kinClient.approverKeyRevoke,
      { environmentId: ref.environmentId, input: { orgId: ref.orgId, thumbprint: ref.thumbprint } },
      { reportFailure: false },
    ).then((result): KinRevokeAnswer => {
      if (AsyncResult.isSuccess(result)) return "done";
      const cause = squashAtomCommandFailure(result);
      if (!isApprovalError(cause)) return "retry";
      // Gone already is what was wanted; anything but an outage is that host's lasting answer.
      return cause.reason === "not_found"
        ? "done"
        : cause.reason === "unavailable"
          ? "retry"
          : "final";
    }),
    new Promise<KinRevokeAnswer>((resolve) => {
      timer = setTimeout(() => resolve("retry"), REVOKE_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return answer;
}

const failure = (text: string, keyExists = false) =>
  ({ ok: false, failure: { text, keyExists } }) as const;

const enrolment = createKinApproverKeyEnrolment<EnrolTarget, string, KinEnrolFailure>({
  readRecord: readApproverKeyRecord,
  begin: (target) =>
    orDeviceFailure(async () => {
      const challenge = await runAtomCommand(
        appAtomRegistry,
        kinClient.keyChallenge,
        { environmentId: target.environmentId, input: {} },
        { reportFailure: false },
      );
      if (AsyncResult.isFailure(challenge))
        return failure(hostText(squashAtomCommandFailure(challenge)));
      return { ok: true, value: challenge.value.challenge } as const;
    }),
  discardLocal: async () => {
    await ApprovalKey.deleteKey();
    await clearApproverKeyRecord();
  },
  finish: ({ environmentId, orgId }, challenge) =>
    orDeviceFailure(async () => {
      const created = await ApprovalKey.createKey(challenge);
      const registered = await runAtomCommand(
        appAtomRegistry,
        kinClient.registerKey,
        {
          environmentId,
          input: {
            enrolmentVersion: KIN_APPROVER_ENROLMENT_VERSION,
            orgId,
            publicJwk: created.publicJwk,
            platform: Platform.OS === "android" ? "android" : "ios",
            challenge,
            ...(created.attestation === undefined ? {} : { attestation: created.attestation }),
            deviceLabel: deviceLabel(),
          },
        },
        { reportFailure: false },
      );
      if (AsyncResult.isFailure(registered)) {
        // The host never took this key, so nothing trusts it: remove it so a retry can make one.
        await ApprovalKey.deleteKey();
        return failure(hostText(squashAtomCommandFailure(registered)));
      }
      await saveApproverKeyRecord({
        environmentId,
        orgId,
        thumbprint: registered.value.key.thumbprint,
      });
      appAtomRegistry.refresh(kinClient.approverKeys({ environmentId, input: { orgId } }));
      return { ok: true } as const;
    }),
  revoke: revokeReplaced,
  addPending: addPendingKeyCleanup,
});

/**
 * Sets up this phone's approval key with a host: challenge, hardware key, attested register. One
 * setup runs at a time on the phone; `replace` names the key the person confirmed replacing.
 */
export function enrolApproverKey(input: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly replace: { readonly confirmed: KinApproverKeyRecord | null } | null;
}): Promise<KinEnrolOutcome<KinEnrolFailure>> {
  return enrolment({
    target: { environmentId: input.environmentId, orgId: input.orgId },
    replace: input.replace,
  }).catch((error: unknown) => ({ _tag: "stopped" as const, failure: deviceFailure(error) }));
}

const isConnected = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
    .phase === "connected";

const cleanup = createKinApproverKeyCleanup({
  pending: readPendingKeyCleanup,
  connected: isConnected,
  revoke: revokeReplaced,
  removePending: removePendingKeyCleanup,
});

/** Asks a host again to drop a key this phone replaced, whenever a host connects. */
export function startApproverKeyCleanup(): () => void {
  const run = () => {
    void cleanup().catch((cause: unknown) =>
      console.warn("Kin approval key cleanup failed", cause),
    );
  };
  return appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, run, {
    immediate: true,
  });
}

/** What Settings shows for this phone: its name and, when they differ, its model. */
function deviceLabel() {
  const parts = [Device.deviceName, Device.modelName]
    .map((part) => part?.trim() ?? "")
    .filter((part, index, all) => part !== "" && all.indexOf(part) === index);
  return (parts.join(" · ") || "Phone").slice(0, 80);
}

function deviceFailure(error: unknown): KinEnrolFailure | null {
  const code = deviceCodeOf(error);
  const outcome = failedFrom(error, code);
  return outcome._tag === "canceled"
    ? null
    : { text: outcome.failure.text, keyExists: code === "E_KEY_EXISTS" };
}

// Outside a hook: the React Compiler can't compile value blocks inside try/catch.
async function orDeviceFailure<A>(
  run: () => Promise<A>,
): Promise<A | { readonly ok: false; readonly failure: KinEnrolFailure } | null> {
  try {
    return await run();
  } catch (error) {
    const failed = deviceFailure(error);
    return failed === null ? null : { ok: false, failure: failed };
  }
}

const isApprovalError = Schema.is(KinApprovalError);

const SAYS_WHAT_TO_DO: ReadonlySet<string> = new Set([
  "invalid_state",
  "not_owner",
  "unattested",
  "too_many_keys",
  "bad_challenge",
]);

function hostText(cause: unknown) {
  // Registration's refusals (not a genuine app, not the owner, too many phones) say what to do.
  if (isApprovalError(cause) && SAYS_WHAT_TO_DO.has(cause.reason)) return cause.message;
  return kinApprovalFailure(cause)?.text ?? "Kin didn't answer. Try again.";
}

/**
 * Approve: the host's challenge, checked against the card the owner read, signed by the key
 * after Face ID, then submitted. The phone adds only `jti`, `iat` and `exp` to what the host sent.
 */
export function useDecidePendingAction() {
  const challenge = useAtomCommand(kinClient.approvalChallenge, { reportFailure: false });
  const submit = useAtomCommand(kinClient.submitGrant, { reportFailure: false });
  const decline = useAtomCommand(kinClient.declineAction, { reportFailure: false });

  const approve = async (input: {
    readonly environmentId: EnvironmentId;
    readonly action: KinPendingAction;
    readonly thumbprint: string;
  }): Promise<KinApprovalOutcome> => {
    const { environmentId, action } = input;
    const asked = await challenge({ environmentId, input: { actionId: action.id } });
    if (AsyncResult.isFailure(asked)) return failedFrom(squashAtomCommandFailure(asked));
    if (!AsyncResult.isSuccess(asked)) return { _tag: "canceled" };
    const { payload } = asked.value;
    if (payload.approver.kid !== input.thumbprint)
      return {
        _tag: "failed",
        failure: {
          text: "Kin expects another phone's key. Set up approvals on this phone again.",
          refresh: false,
          reenrol: true,
        },
      };
    if (!kinChallengeMatchesCard(payload, action)) return notMatching;
    const iat = Math.floor(Date.now() / 1000);
    const signingInput = encodeGrantSigningInput(
      { typ: "kin-grant+jws", alg: "ES256", kid: payload.approver.kid },
      {
        ...payload,
        jti: Base64Url.encode(ExpoCrypto.getRandomBytes(16)),
        iat,
        exp: iat + 600,
      },
    );
    let signature: string;
    try {
      signature = await ApprovalKey.sign(signingInput);
    } catch (error) {
      return failedFrom(error, deviceCodeOf(error));
    }
    const result = await submit({
      environmentId,
      input: { compact: `${signingInput}.${signature}` },
    });
    if (AsyncResult.isFailure(result)) return failedFrom(squashAtomCommandFailure(result));
    return AsyncResult.isSuccess(result)
      ? { _tag: "done", state: result.value.state }
      : { _tag: "canceled" };
  };

  const reject = async (input: {
    readonly environmentId: EnvironmentId;
    readonly action: KinPendingAction;
  }): Promise<KinApprovalOutcome> => {
    const result = await decline({
      environmentId: input.environmentId,
      input: { actionId: input.action.id, revision: input.action.revision },
    });
    if (AsyncResult.isFailure(result)) return failedFrom(squashAtomCommandFailure(result));
    return AsyncResult.isSuccess(result)
      ? { _tag: "done", state: result.value.state }
      : { _tag: "canceled" };
  };

  return { approve, reject };
}
