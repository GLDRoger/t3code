import {
  KIN_GITHUB_LOGIN,
  kinGithubLoginFailure,
  kinGithubLoginInput,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId, KinPersonProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import { useKinFormOpen } from "./kinOverlayParts";
import { KinSettingsField, KinSettingsFormDialog } from "./settings/KinSettingsControls";
import { KinSettingsRow } from "./settings/KinSettingsLayout";

/** Their GitHub username, where the host sends it: a profile row that opens its own form. */
export function KinGithubLoginRow(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  /** The settings search id that lands on this row. */
  readonly searchId?: string;
}) {
  const { profile } = props;
  const [editing, setEditing] = useKinFormOpen();
  if (profile.githubLogin === undefined) return null;
  const login = profile.githubLogin;
  return (
    <>
      <KinSettingsRow
        {...(props.searchId === undefined ? {} : { searchId: props.searchId })}
        title={KIN_GITHUB_LOGIN.label}
        detail={login ?? KIN_GITHUB_LOGIN.none}
        openLabel={`${KIN_GITHUB_LOGIN.label}: ${login ?? KIN_GITHUB_LOGIN.none}`}
        onOpen={() => setEditing(true)}
      />
      {editing ? (
        <KinGithubLoginDialog {...props} login={login} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

function KinGithubLoginDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
  readonly login: string | null;
  readonly onClose: () => void;
}) {
  const setLogin = useAtomCommand(kinClient.personSetGithubLogin, { reportFailure: false });
  const [typed, setTyped] = useState(props.login ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const save = async (githubLogin: string | null) => {
    setBusy(true);
    setProblem(null);
    const outcome = await setLogin({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, personId: props.profile.personId, githubLogin },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) props.onClose();
    else setProblem(kinGithubLoginFailure(squashAtomCommandFailure(outcome)));
  };
  return (
    <>
      <KinSettingsFormDialog
        title={KIN_GITHUB_LOGIN.label}
        description={props.mine ? KIN_GITHUB_LOGIN.mineHint : KIN_GITHUB_LOGIN.theirHint}
        submitLabel={KIN_GITHUB_LOGIN.saveUsername}
        busy={busy}
        problem={problem}
        remove={
          props.login === null ? undefined : (
            <Button
              type="button"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => setAsking(true)}
            >
              {KIN_GITHUB_LOGIN.remove}
            </Button>
          )
        }
        onSubmit={() => {
          const read = kinGithubLoginInput(typed);
          if (read.ok) void save(read.login);
          else setProblem(read.problem);
        }}
        onClose={props.onClose}
      >
        <KinSettingsField label={KIN_GITHUB_LOGIN.label}>
          {(ids) => (
            <Input
              id={ids.control}
              value={typed}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setTyped(event.currentTarget.value)}
            />
          )}
        </KinSettingsField>
      </KinSettingsFormDialog>
      <KinConfirm
        ask={
          asking
            ? {
                title: KIN_GITHUB_LOGIN.removeTitle,
                detail: KIN_GITHUB_LOGIN.removeDetail(props.mine),
                action: KIN_GITHUB_LOGIN.remove,
                destructive: true,
              }
            : null
        }
        onConfirm={() => void save(null)}
        onClose={() => setAsking(false)}
      />
    </>
  );
}
