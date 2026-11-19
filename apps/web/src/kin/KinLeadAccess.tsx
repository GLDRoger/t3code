import { useAtomValue } from "@effect/atom-react";
import {
  KIN_LEAD_EVERYONE,
  kinLeadAccessCandidates,
  kinLeadAccessChanged,
  kinLeadAccessProblem,
  KIN_AGENTS_COPY,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinLeadAccessResult,
  KinLeadProfile,
  KinPersonId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";

export function KinAgentSection(props: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

type AccessPerson = KinLeadAccessResult["people"][number];

/** Who besides the owner can message this lead, and the way to add or remove a person. */
export function KinLeadAccess(props: {
  readonly lead: KinLeadProfile;
  readonly environmentId: EnvironmentId;
  readonly personId: string | null;
}) {
  const { lead, environmentId } = props;
  const target = { orgId: lead.orgId, agentId: lead.agentId };
  const accessAtom = kinClient.leadAccess({ environmentId, input: target });
  const access = useAtomValue(accessAtom);
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId: lead.orgId } }));
  const allow = useAtomCommand(kinClient.leadAllow, { reportFailure: false });
  const disallow = useAtomCommand(kinClient.leadDisallow, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [removing, setRemoving] = useState<AccessPerson | null>(null);
  // What was last read stays up while a change is read again.
  const read = Option.getOrNull(AsyncResult.value(access));
  const allowed = read?.people ?? null;
  // The team agent is everyone's: no one is added or removed there.
  const everyone = read?.everyone === true;
  const candidates = kinLeadAccessCandidates(
    everyone ? [] : (Option.getOrNull(AsyncResult.value(people))?.people ?? []),
    allowed ?? [],
    props.personId,
  );

  const change = async (
    person: {
      readonly personId: KinPersonId;
      readonly displayName: string;
      readonly ownerLevel?: boolean | undefined;
    },
    on: boolean,
  ) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const input = { ...target, personId: person.personId };
    const result = await (on ? allow : disallow)({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      appAtomRegistry.refresh(accessAtom);
      setNote({
        text: kinLeadAccessChanged(person.displayName, lead.name, on, person.ownerLevel),
        failed: false,
      });
      return;
    }
    setNote({
      text: kinLeadAccessProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
      ),
      failed: true,
    });
  };

  return (
    <KinAgentSection title="Who can message">
      {allowed === null ? (
        <p className="text-sm text-muted-foreground">
          {AsyncResult.isFailure(access) ? KIN_AGENTS_COPY.accessFailed : "Loading…"}
        </p>
      ) : everyone || allowed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {everyone ? KIN_LEAD_EVERYONE : KIN_AGENTS_COPY.onlyOwners}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {allowed.map((person) => (
            <li key={person.personId} className="flex min-h-9 items-center gap-3">
              <KinAvatar avatar={{ kind: "person", seed: `person:${person.personId}` }} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {person.displayName}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${person.displayName}`}
                onClick={() => setRemoving(person)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {allowed === null || everyone || allowed.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {(lead.intro ?? "").trim() === ""
            ? KIN_AGENTS_COPY.nameOnly
            : KIN_AGENTS_COPY.seesIntro((lead.intro ?? "").trim())}
        </p>
      )}
      {note === null ? null : (
        <p
          role={note.failed ? "alert" : "status"}
          className={
            note.failed ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
          }
        >
          {note.text}
        </p>
      )}
      {candidates.length === 0 ? null : (
        <Menu>
          <MenuTrigger
            render={<Button size="sm" variant="outline" className="self-start" disabled={busy} />}
          >
            Add a person
          </MenuTrigger>
          <MenuPopup align="start">
            {candidates.map((person) => (
              <MenuItem key={person.personId} onClick={() => void change(person, true)}>
                {person.displayName}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {KIN_AGENTS_COPY.removeAccess(
                removing?.displayName ?? "",
                lead.name,
                removing?.ownerLevel,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const person = removing;
                setRemoving(null);
                if (person !== null) void change(person, false);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </KinAgentSection>
  );
}
