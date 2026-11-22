import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_VISUAL_HOSTS as COPY } from "@t3tools/client-runtime/kin/kinConnections";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { KinSettingsDialog } from "./settings/KinSettingsControls";
import { KinSettingsRow, KinSettingsSection } from "./settings/KinSettingsLayout";

const failureText = (result: AsyncResult.AsyncResult<unknown, unknown>, fallback: string) => {
  const cause = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
};

/** Charts: the websites charts may load from, one row that opens the list to add to or take from. */
export function KinVisualHosts(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const hostsAtom = kinClient.visualHosts({ environmentId, input: { orgId } });
  const hosts = Option.getOrNull(AsyncResult.value(useAtomValue(hostsAtom)))?.hosts ?? null;
  const reload = useAtomRefresh(hostsAtom);
  const allow = useAtomCommand(kinClient.visualHostAllow, { reportFailure: false });
  const remove = useAtomCommand(kinClient.visualHostRemove, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const change = async (host: string, on: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await (on ? allow : remove)({ environmentId, input: { orgId, host } });
    setBusy(false);
    reload();
    if (AsyncResult.isSuccess(result)) {
      if (on) setDraft("");
      return;
    }
    setProblem(failureText(result, on ? COPY.addFailed : COPY.removeFailed));
  };

  return (
    <>
      <KinSettingsSection title={COPY.section}>
        <KinSettingsRow
          title={COPY.title}
          wrap
          detail={hosts === null ? undefined : COPY.summary(hosts)}
          onOpen={() => {
            setProblem(null);
            setOpen(true);
          }}
        />
      </KinSettingsSection>
      {!open ? null : (
        <KinSettingsDialog
          title={COPY.title}
          description={COPY.detail}
          busy={busy}
          problem={problem}
          onClose={() => setOpen(false)}
        >
          {hosts === null || hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{COPY.none}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {hosts.map((host) => (
                <li key={host} className="flex min-h-10 items-center gap-2 px-3 py-1">
                  <span className="min-w-0 flex-1 truncate text-sm">{host}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${COPY.remove} ${host}`}
                    onClick={() => void change(host, false)}
                  >
                    {COPY.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== "") void change(draft, true);
            }}
          >
            <Input
              aria-label={COPY.inputLabel}
              placeholder={COPY.placeholder}
              value={draft}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={busy || draft.trim() === ""}>
              {COPY.add}
            </Button>
          </form>
        </KinSettingsDialog>
      )}
    </>
  );
}
