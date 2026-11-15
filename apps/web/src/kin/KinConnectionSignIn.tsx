import {
  KIN_CONNECTIONS_COPY as COPY,
  kinGoogleSetupSteps,
} from "@t3tools/client-runtime/kin/kinConnections";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/**
 * Opens the window the service's sign-in page loads in. It opens blank on the owner's click, so
 * the browser doesn't block it while the host prepares the address.
 */
export function openSignInWindow(): Window | null {
  return window.open("about:blank", "kin-sign-in", "popup,width=520,height=720");
}

/** The address to copy, with a Copy button. */
function CopyAddress(props: { readonly address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-md bg-muted/50 px-2 py-1.5 text-xs">
        {props.address}
      </code>
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(props.address).then(() => setCopied(true))
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? COPY.copied : COPY.copy}
      </Button>
    </div>
  );
}

/** The one-time Google client setup: numbered steps, the exact return address, and two fields. */
export function GoogleSetup(props: {
  readonly signInAddress: string;
  readonly disabled: boolean;
  readonly onSave: (clientId: string, clientSecret: string) => Promise<string | null>;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { id: useId(), secret: useId() };
  const steps = kinGoogleSetupSteps(props.signInAddress);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{COPY.googleSetupTitle}</h3>
        <p className="text-xs text-muted-foreground">{COPY.googleSetupDetail}</p>
      </div>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        {steps.map((step, index) => (
          <li key={step}>
            {index === 3 ? (
              <div className="flex flex-col gap-1.5">
                <span>
                  In Clients → Create client, choose Web application, and under Authorized redirect
                  URIs add exactly this address:
                </span>
                <CopyAddress address={props.signInAddress} />
              </div>
            ) : (
              step
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.id}>{COPY.clientIdLabel}</Label>
        <Input
          id={ids.id}
          value={clientId}
          placeholder={COPY.clientIdPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setClientId(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.secret}>{COPY.clientSecretLabel}</Label>
        <Input
          id={ids.secret}
          type="password"
          value={clientSecret}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setClientSecret(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">{COPY.keyHint}</p>
      </div>
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        className="self-start"
        disabled={props.disabled || busy}
        aria-busy={busy}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          void props.onSave(clientId, clientSecret).then((failed) => {
            setBusy(false);
            setProblem(failed);
          });
        }}
      >
        {COPY.saveClient}
      </Button>
    </div>
  );
}

/**
 * While the owner signs in at the service: the return page hands the result back to this
 * window, or the owner pastes the address it landed on.
 */
export function SignInWaiting(props: {
  readonly host: string;
  readonly authorizationUrl: string;
  readonly signInAddress: string;
  readonly opened: boolean;
  readonly onFinish: (response: string) => Promise<string | null>;
}) {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const finish = (response: string) => {
    setBusy(true);
    setProblem(null);
    void props.onFinish(response).then((failed) => {
      setBusy(false);
      setProblem(failed);
    });
  };
  const received = useEffectEvent(finish);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the sign-in window's message, outside React.
  useEffect(() => {
    const origin = new URL(props.signInAddress).origin;
    const receive = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.origin !== origin || typeof data !== "object" || data === null) return;
      if (!("type" in data) || data.type !== "kin-sign-in") return;
      if (!("response" in data) || typeof data.response !== "string") return;
      received(data.response);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [props.signInAddress]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{COPY.waiting}</h3>
        <p className="text-xs text-muted-foreground">{COPY.waitingDetail(props.host)}</p>
      </div>
      {props.opened ? null : (
        <Button
          className="self-start"
          render={<a href={props.authorizationUrl} target="_blank" rel="noopener noreferrer" />}
        >
          {COPY.signInTo(props.host)}
        </Button>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{COPY.pasteLabel}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            value={pasted}
            placeholder={COPY.pastePlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPasted(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || pasted.trim() === ""}
            aria-busy={busy}
            onClick={() => finish(pasted)}
          >
            {COPY.finish}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{COPY.pasteHint}</p>
      </div>
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription role="alert">{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
