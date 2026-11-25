import {
  KIN_PROJECT_PEOPLE,
  KIN_PROJECTS,
  kinProjectPeopleChoices,
  type KinProjectPageView,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import { kinWorkSend, type KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinWorkNames } from "@t3tools/client-runtime/kin/kinWork";
import type { KinPerson, KinWorkPrincipal } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinWorkProblem, KinWorkSection } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Who is on a project, as its page shows them; the owner, a co-owner and its lead put people and
 * agents on it and take them off (the host's `can.people`).
 */
export function KinProjectPeopleSection(
  props: KinWorkTarget & {
    readonly view: KinProjectPageView;
    readonly people: ReadonlyArray<KinPerson> | null;
    readonly names: KinWorkNames;
    readonly onChanged: () => void;
  },
) {
  const { environmentId, orgId, view } = props;
  const send = useAtomCommand(kinClient.workProjectPeople, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<KinWorkFormProblem | null>(null);
  const changes = view.changesPeople && view.closed === null;
  if (view.people.length === 0 && !changes) return null;
  const change = async (input: {
    readonly add?: ReadonlyArray<KinWorkPrincipal>;
    readonly remove?: ReadonlyArray<KinWorkPrincipal>;
  }) => {
    if (busy) return false;
    setBusy(true);
    setProblem(null);
    const outcome = await kinWorkSend({
      online: () => kinHostConnected(environmentId),
      send: () => send({ environmentId, input: { orgId, key: view.key, ...input } }),
      noun: "project",
      name: view.name,
      own: view.key,
    });
    setBusy(false);
    if (outcome.ok) props.onChanged();
    else setProblem(outcome.problem);
    return outcome.ok;
  };
  return (
    <KinWorkSection
      title={KIN_PROJECTS.people}
      action={
        changes ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setAdding(true)}>
            <PlusIcon />
            {KIN_PROJECT_PEOPLE.add}
          </Button>
        ) : null
      }
    >
      {view.people.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_PROJECT_PEOPLE.none}</p>
      ) : (
        <ul className="flex flex-col">
          {view.people.map((row) => (
            <li key={row.key} className="flex min-h-9 min-w-0 items-center gap-2">
              <KinAvatar avatar={row.avatar} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {row.line}
              </span>
              {changes && row.member ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={KIN_PROJECT_PEOPLE.remove(row.name)}
                  title={KIN_PROJECT_PEOPLE.remove(row.name)}
                  onClick={() => void change({ remove: [row.who] })}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : <KinWorkProblem problem={problem} />}
      {adding ? (
        <KinProjectPeopleSheet
          title={KIN_PROJECT_PEOPLE.choose}
          private={view.privacy.private}
          people={props.people}
          names={props.names}
          on={view.people}
          busy={busy}
          onSave={async (add) => {
            if (await change({ add })) setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </KinWorkSection>
  );
}

/** Teammates and agents to put on a project, ticked in a list. */
export function KinProjectPeoplePicker(props: {
  readonly people: ReadonlyArray<KinPerson> | null;
  readonly names: KinWorkNames;
  readonly on: Parameters<typeof kinProjectPeopleChoices>[0]["on"];
  readonly picked: ReadonlyArray<KinWorkPrincipal>;
  readonly disabled?: boolean;
  readonly onChange: (picked: ReadonlyArray<KinWorkPrincipal>) => void;
}) {
  const choices = kinProjectPeopleChoices({
    people: props.people,
    names: props.names,
    on: props.on,
  });
  if (choices.length === 0)
    return <p className="text-sm text-muted-foreground">{KIN_PROJECT_PEOPLE.nobodyLeft}</p>;
  const isPicked = (key: string) =>
    props.picked.some((who) =>
      who._tag === "person" ? `person:${who.personId}` === key : `agent:${who.agentId}` === key,
    );
  return (
    <ul className="flex flex-col">
      {choices.map((choice, at) => (
        <li key={choice.key}>
          {choice.agent && choices[at - 1]?.agent !== true ? (
            <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
              {KIN_PROJECT_PEOPLE.agents}
            </p>
          ) : null}
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent">
            <Checkbox
              checked={isPicked(choice.key)}
              disabled={props.disabled === true}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? [...props.picked, choice.who]
                    : props.picked.filter((who) => !same(who, choice.who)),
                )
              }
            />
            <span className="truncate text-sm text-foreground">{choice.name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

const same = (a: KinWorkPrincipal, b: KinWorkPrincipal) =>
  a._tag === "person"
    ? b._tag === "person" && a.personId === b.personId
    : b._tag === "agent" && a.agentId === b.agentId;

function KinProjectPeopleSheet(props: {
  readonly title: string;
  readonly private: boolean;
  readonly people: ReadonlyArray<KinPerson> | null;
  readonly names: KinWorkNames;
  readonly on: Parameters<typeof kinProjectPeopleChoices>[0]["on"];
  readonly busy: boolean;
  readonly onSave: (add: ReadonlyArray<KinWorkPrincipal>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [picked, setPicked] = useState<ReadonlyArray<KinWorkPrincipal>>([]);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{props.title}</SheetTitle>
          <SheetDescription>
            {props.private ? KIN_PROJECT_PEOPLE.privateDetail : KIN_PROJECT_PEOPLE.detail}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
          <KinProjectPeoplePicker
            people={props.people}
            names={props.names}
            on={props.on}
            picked={picked}
            disabled={props.busy}
            onChange={setPicked}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={props.busy || picked.length === 0}
            aria-busy={props.busy}
            onClick={() => void props.onSave(picked)}
          >
            {KIN_PROJECT_PEOPLE.save}
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
