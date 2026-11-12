import { useAtomValue } from "@effect/atom-react";
import { encodeGrantSigningInput } from "@t3tools/shared/kinGrant";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  kinApprovalFailure,
  type KinApprovalDeviceCode,
  type KinApprovalFailure,
} from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import type {
  EnvironmentId,
  KinApprovalsListKeysResult,
  KinApproverKey,
  KinOrgId,
  KinPendingAction,
  KinPendingActionState,
} from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import { AsyncResult } from "effect/reactivity";
import * as Device from "expo-device";
import * as ExpoCrypto from "expo-crypto";
import { Platform } from "react-native";

import * as ApprovalKey from "../../../../modules/kin-approval-key";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  clearApproverKeyRecord,
  kinApproverKeyRecordAtom,
  saveApproverKeyRecord,
  type KinApproverKeyRecord,
} from "./approverKeyRecord";

/** Where this phone's approval key stands with one host and org. */
export type KinApproverKeyStatus =
  | { readonly _tag: "loading" }
  | { readonly _tag: "unreadable"; readonly retry: () => void }
  /** No key here, or one this host doesn't know. */
  | { readonly _tag: "none"; readonly staleKey: boolean }
  /** Waiting for Allow in Kin on the web or desktop; `code` is null once the request expired. */
  | { readonly _tag: "pending"; readonly code: string | null; readonly thumbprint: string }
  /** No App Attest (a simulator, an old phone): the host never activates this key. */
  | { readonly _tag: "unattested" }
  | { readonly _tag: "revoked" }
  | { readonly _tag: "active"; readonly key: KinApproverKey };

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
  const key = keys.value.keys.find((k) => here !== null && k.thumbprint === here.thumbprint);
  if (here === null || key === undefined) return { _tag: "none", staleKey: saved !== null };
  if (key.state === "revoked") return { _tag: "revoked" };
  if (!key.attested) return { _tag: "unattested" };
  if (key.state === "active") return { _tag: "active", key };
  // The server's list says whether the request still waits, and with which number.
  const request = keys.value.requests?.find((r) => r.thumbprint === key.thumbprint);
  return { _tag: "pending", code: request?.matchCode ?? null, thumbprint: key.thumbprint };
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

type EnrolResult =
  | { readonly ok: true }
  /** `keyExists`: this phone holds a key the host doesn't know; replacing it is the way out. */
  | { readonly ok: false; readonly text: string; readonly keyExists: boolean };

/** Sets up this phone's approval key with a host: challenge, hardware key, attested register. */
export function useEnrolApproverKey() {
  const keyChallenge = useAtomCommand(kinClient.keyChallenge, { reportFailure: false });
  const registerKey = useAtomCommand(kinClient.registerKey, { reportFailure: false });
  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly orgId: KinOrgId;
    /** Delete the key this phone holds first, after the owner chose to replace it. */
    readonly replace: boolean;
  }): Promise<EnrolResult | null> => {
    const { environmentId, orgId } = input;
    return orDeviceFailure(async () => {
      if (input.replace) {
        await ApprovalKey.deleteKey();
        await clearApproverKeyRecord();
      }
      const challenge = await keyChallenge({ environmentId, input: {} });
      if (AsyncResult.isFailure(challenge))
        return { ok: false, text: hostText(squashAtomCommandFailure(challenge)), keyExists: false };
      if (!AsyncResult.isSuccess(challenge)) return null;
      const created = await ApprovalKey.createKey(challenge.value.challenge);
      const registered = await registerKey({
        environmentId,
        input: {
          orgId,
          publicJwk: created.publicJwk,
          platform: Platform.OS === "android" ? "android" : "ios",
          challenge: challenge.value.challenge,
          ...(created.attestation === undefined ? {} : { attestation: created.attestation }),
          deviceLabel: deviceLabel(),
        },
      });
      if (AsyncResult.isFailure(registered)) {
        // The host never took this key, so nothing trusts it: remove it so a retry can make one.
        await ApprovalKey.deleteKey();
        return {
          ok: false,
          text: hostText(squashAtomCommandFailure(registered)),
          keyExists: false,
        };
      }
      if (!AsyncResult.isSuccess(registered)) return null;
      await saveApproverKeyRecord({
        environmentId,
        orgId,
        thumbprint: registered.value.key.thumbprint,
        code: registered.value.code,
        codeExpiresAt: Date.now() + 10 * 60_000,
      });
      appAtomRegistry.refresh(kinClient.approverKeys({ environmentId, input: { orgId } }));
      return { ok: true };
    });
  };
}

/** What Settings shows for this phone: its name and, when they differ, its model. */
function deviceLabel() {
  const parts = [Device.deviceName, Device.modelName]
    .map((part) => part?.trim() ?? "")
    .filter((part, index, all) => part !== "" && all.indexOf(part) === index);
  return (parts.join(" · ") || "Phone").slice(0, 80);
}

// Outside the hook: the React Compiler can't compile value blocks inside try/catch.
async function orDeviceFailure(
  run: () => Promise<EnrolResult | null>,
): Promise<EnrolResult | null> {
  try {
    return await run();
  } catch (error) {
    const code = deviceCodeOf(error);
    const outcome = failedFrom(error, code);
    return outcome._tag === "canceled"
      ? null
      : { ok: false, text: outcome.failure.text, keyExists: code === "E_KEY_EXISTS" };
  }
}

function hostText(cause: unknown) {
  return kinApprovalFailure(cause)?.text ?? "Kin didn't answer. Try again.";
}

/** The facts a grant binds, as the server records them (approvals spec §5). */
const signedFacts = (facts: {
  readonly kind: string;
  readonly target: unknown;
  readonly headSha?: string | undefined;
  readonly base?: string | undefined;
  readonly mergeMethod?: string | undefined;
}) =>
  stableStringify({
    kind: facts.kind,
    target: facts.target,
    headSha: facts.headSha,
    base: facts.base,
    mergeMethod: facts.mergeMethod,
  });

const shownFacts = (action: KinPendingAction) =>
  signedFacts({
    kind: action.kind,
    target: action.target,
    headSha: action.resolved._tag === "none" ? undefined : action.resolved.headSha,
    base: action.resolved._tag === "pull_request" ? action.resolved.base : undefined,
    mergeMethod: action.target._tag === "pull_request" ? action.target.mergeMethod : undefined,
  });

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
    // What Face ID signs must be what the card showed; a newer head means the owner looks again.
    if (
      payload.actionId !== action.id ||
      payload.revision !== action.revision ||
      signedFacts(payload) !== shownFacts(action)
    )
      return notMatching;
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
