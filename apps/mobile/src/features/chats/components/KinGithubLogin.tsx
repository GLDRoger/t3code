import {
  KIN_GITHUB_LOGIN,
  kinGithubLoginFailure,
  kinGithubLoginInput,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId, KinPersonProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

/** Their GitHub username, where the host sends it: on a profile the reader may change. */
export function KinGithubLoginSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
  readonly mine: boolean;
}) {
  const { profile } = props;
  const setLogin = useAtomCommand(kinClient.personSetGithubLogin, { reportFailure: false });
  const [editing, setEditing] = useState(false);
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
  const hint = props.mine ? KIN_GITHUB_LOGIN.mineHint : KIN_GITHUB_LOGIN.theirHint;
  return (
    <>
      <ListSection
        title={KIN_GITHUB_LOGIN.label}
        footer={problem === null || editing ? hint : problem}
      >
        <View className="px-4 py-3">
          <Text
            textRole="body"
            className={login === null ? "text-foreground-muted" : "text-foreground"}
          >
            {login ?? KIN_GITHUB_LOGIN.none}
          </Text>
        </View>
        <View className="border-t border-border-subtle">
          <ListActionRow
            icon="pencil"
            label={login === null ? KIN_GITHUB_LOGIN.set : KIN_GITHUB_LOGIN.change}
            disabled={busy}
            onPress={() => setEditing(true)}
          />
        </View>
        {login === null ? null : (
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="trash"
              label={KIN_GITHUB_LOGIN.remove}
              loading={busy && !editing}
              disabled={busy}
              onPress={() => void save(null)}
            />
          </View>
        )}
      </ListSection>
      {editing ? (
        <KinGithubLoginSheet
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
    </>
  );
}

function KinGithubLoginSheet(props: {
  readonly login: string | null;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSave: (login: string | null) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState(props.login ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? props.problem;
  const submit = () => {
    const read = kinGithubLoginInput(typed);
    setProblem(read.ok ? null : read.problem);
    if (read.ok) void props.onSave(read.login);
  };
  return (
    <Sheet title={KIN_GITHUB_LOGIN.label} onClose={props.onClose} dismissDisabled={props.busy}>
      <View className="gap-4 px-4 pt-2 pb-10">
        <ListSection>
          <View className="px-4 py-3">
            <TextInput
              accessibilityLabel={KIN_GITHUB_LOGIN.label}
              value={typed}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!props.busy}
              returnKeyType="done"
              onChangeText={setTyped}
              onSubmitEditing={submit}
              className="min-h-8 font-sans text-base text-foreground"
            />
          </View>
        </ListSection>
        {shown === null ? null : <ErrorBanner message={shown} />}
        <Button
          label={props.busy ? KIN_GITHUB_LOGIN.saving : KIN_GITHUB_LOGIN.save}
          loading={props.busy}
          disabled={props.busy}
          fullWidth
          onPress={submit}
        />
      </View>
    </Sheet>
  );
}
