import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

const failureText = (result: AsyncResult.AsyncResult<unknown, unknown>, fallback: string) => {
  const cause = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
  return cause instanceof Error && cause.message !== "" ? cause.message : fallback;
};

/** The owner's list of outside hosts visuals may load from: see it, add to it, take from it. */
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
    setProblem(failureText(result, on ? "Couldn't add that host." : "Couldn't remove that host."));
  };

  return (
    <section aria-label="Visuals" className="flex flex-col gap-2 border-t border-border/60 pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">Visuals</h3>
      <p className="text-sm text-muted-foreground">
        A visual an agent sends can't reach the internet. A host you add here is the exception: any
        visual can load images, fonts and data from it, and send it what the visual shows.
      </p>
      {hosts === null ? null : hosts.length === 0 ? (
        <p className="text-sm">No hosts added.</p>
      ) : (
        <ul className="flex flex-col">
          {hosts.map((host) => (
            <li
              key={host}
              className="flex items-center gap-2 border-b border-border/60 py-1.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{host}</span>
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={busy}
                onClick={() => void change(host, false)}
              >
                Remove
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
          aria-label="Host to add"
          placeholder="tiles.example.com"
          value={draft}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy || draft.trim() === ""}>
          Add host
        </Button>
      </form>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </section>
  );
}
