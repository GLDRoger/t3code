import {
  KIN_GITHUB_LOGIN,
  kinGithubLoginFailure,
  kinGithubLoginInput,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId, KinPersonProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { useKinFormOpen } from "./kinOverlayParts";

/** Their GitHub username, where the host sends it: on a profile the reader may change. */
export function KinGithubLoginField(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  /** The settings search id that lands here. */
  readonly target?: string | undefined;
}) {
  const { profile } = props;
  const setLogin = useAtomCommand(kinClient.personSetGithubLogin, { reportFailure: false });
  const [editing, setEditing] = useKinFormOpen();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (profile.githubLogin === undefined) return null;
  const login = profile.githubLogin;
  const save = async (githubLogin: string | null) => {
    setBusy(true);
    setProblem(null);
    const outcome = await setLogin({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, personId: profile.personId, githubLogin },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) return true;
    setProblem(kinGithubLoginFailure(squashAtomCommandFailure(outcome)));
    return false;
  };
  return (
    <section
      id={props.target}
      tabIndex={props.target === undefined ? undefined : -1}
      className="flex flex-col gap-1"
    >
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_GITHUB_LOGIN.label}</h3>
      <p className="text-sm text-foreground">
        {login === null ? (
          <span className="text-muted-foreground">{KIN_GITHUB_LOGIN.none}</span>
        ) : (
          login
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {props.mine ? KIN_GITHUB_LOGIN.mineHint : KIN_GITHUB_LOGIN.theirHint}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
          {login === null ? KIN_GITHUB_LOGIN.set : KIN_GITHUB_LOGIN.change}
        </Button>
        {login === null ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-busy={busy && !editing}
            onClick={() => void save(null)}
          >
            {KIN_GITHUB_LOGIN.remove}
          </Button>
        )}
      </div>
      {problem === null || editing ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      {editing ? (
        <KinGithubLoginDialog
          login={login}
          busy={busy}
          problem={problem}
          onSave={async (next) => {
            if (await save(next)) setEditing(false);
          }}
          onClose={() => {
            setProblem(null);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}

function KinGithubLoginDialog(props: {
  readonly login: string | null;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSave: (login: string | null) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState(props.login ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useId();
  const shown = problem ?? props.problem;
  return (
    <Dialog open onOpenChange={(open) => !open && !props.busy && props.onClose()}>
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const read = kinGithubLoginInput(typed);
            setProblem(read.ok ? null : read.problem);
            if (read.ok) void props.onSave(read.login);
          }}
        >
          <DialogHeader>
            <DialogTitle>{KIN_GITHUB_LOGIN.label}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId}>{KIN_GITHUB_LOGIN.label}</Label>
              <Input
                id={fieldId}
                value={typed}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setTyped(event.currentTarget.value)}
              />
              {shown === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{shown}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy} aria-busy={props.busy}>
              {props.busy ? KIN_GITHUB_LOGIN.saving : KIN_GITHUB_LOGIN.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
