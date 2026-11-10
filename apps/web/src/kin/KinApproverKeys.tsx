import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KinApprovalError,
  type EnvironmentId,
  type KinApproverKey,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

const isApprovalError = Schema.is(KinApprovalError);

/**
 * The first phone that approves is confirmed here, in the desktop app on the Kin host: the server
 * refuses any other session. Shown only until some phone can approve.
 */
export function KinApproverKeyConfirm(props: { readonly environmentId: EnvironmentId }) {
  const orgs = useAtomValue(kinClient.orgs({ environmentId: props.environmentId, input: {} }));
  const orgId = AsyncResult.isSuccess(orgs) ? orgs.value.me[0]?.orgId : undefined;
  if (!isElectron || orgId === undefined) return null;
  return <PendingKeys environmentId={props.environmentId} orgId={orgId} />;
}

function PendingKeys(props: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId }) {
  const atom = kinClient.approverKeys({
    environmentId: props.environmentId,
    input: { orgId: props.orgId },
  });
  const result = useAtomValue(atom);
  if (!AsyncResult.isSuccess(result)) return null;
  const keys = result.value.keys;
  if (keys.some((key) => key.state === "active")) return null;
  const pending = keys.filter((key) => key.state === "pending" && key.attested);
  return (
    <section
      aria-label="Approvals"
      className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5 text-xs"
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <SmartphoneIcon aria-hidden className="size-3.5" />
        {pending.length === 0 ? "No phone can approve yet" : "Confirm the phone that approves"}
      </p>
      {pending.length === 0 ? (
        <>
          <p className="text-muted-foreground">
            Set up approvals in Kin on your iPhone, then check here for its code.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => appAtomRegistry.refresh(atom)}
          >
            Check again
          </Button>
        </>
      ) : (
        pending.map((key) => (
          <ConfirmKey
            key={key.thumbprint}
            environmentId={props.environmentId}
            approverKey={key}
            onDone={() => appAtomRegistry.refresh(atom)}
          />
        ))
      )}
    </section>
  );
}

function ConfirmKey(props: {
  readonly environmentId: EnvironmentId;
  readonly approverKey: KinApproverKey;
  readonly onDone: () => void;
}) {
  const { approverKey } = props;
  const confirm = useAtomCommand(kinClient.confirmKey, { reportFailure: false });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{6}$/.test(code);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const result = await confirm({
      environmentId: props.environmentId,
      input: { orgId: approverKey.orgId, thumbprint: approverKey.thumbprint, code },
    });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      // The server writes these refusals for the owner ("The code doesn't match the phone.").
      setError(isApprovalError(cause) ? cause.message : "Kin didn't answer. Try again.");
      return;
    }
    props.onDone();
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`kin-key-${approverKey.thumbprint}`} className="text-muted-foreground">
        Enter the code {approverKey.deviceLabel} shows.
      </label>
      <div className="flex gap-2">
        <Input
          id={`kin-key-${approverKey.thumbprint}`}
          size="sm"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="123 456"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <Button size="sm" type="submit" disabled={!valid || busy}>
          Confirm
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </form>
  );
}
