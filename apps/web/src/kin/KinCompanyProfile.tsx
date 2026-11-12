import { useAtomValue } from "@effect/atom-react";
import {
  KIN_COMPANY,
  KIN_COMPANY_SECTIONS,
  kinCompanyDraftOf,
  kinCompanyEmpty,
  kinCompanyInput,
  kinCompanyRead,
  type KinCompanyDraft,
  type KinCompanyFieldId,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import type { KinCompanyProfile } from "@t3tools/contracts";
import { LockIcon, PencilIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { useAtomCommand } from "../state/use-atom-command";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient } from "./kinClient";
import { kinHostConnected, useKinHost } from "./useKinHost";
import { useKinCompanyProfile } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

function Notice(props: {
  readonly title: string;
  readonly detail: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
      {props.action === undefined ? null : <EmptyContent>{props.action}</EmptyContent>}
    </Empty>
  );
}

/** The company's legal, tax and bank details, for whoever runs this Kin and nobody else. */
export function KinCompanyProfileSettings() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return <Notice {...KIN_COMPANY.noKin} />;
  return <Permitted environmentId={target.environmentId} orgId={target.orgId} />;
}

function Permitted(props: KinWorkTarget) {
  const allowed = useAtomValue(kinClient.companyRead.permissionAtom(props.environmentId));
  const { state, refresh } = useKinCompanyProfile(props, allowed);
  if (!allowed || state._tag === "refused") return <Notice {...KIN_COMPANY.onlyOwner} />;
  if (state._tag === "loading") {
    return (
      <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading company details">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    );
  }
  if (state._tag !== "ready") {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{KIN_COMPANY.loadFailed}. Check your connection.</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }
  return <Profile {...props} profile={state.value} onRefresh={refresh} />;
}

function Profile(
  props: KinWorkTarget & { readonly profile: KinCompanyProfile; readonly onRefresh: () => void },
) {
  const { environmentId, orgId, profile } = props;
  const canEdit = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const [draft, setDraft] = useState<KinCompanyDraft | null>(null);
  const [problems, setProblems] = useState<Readonly<Partial<Record<KinCompanyFieldId, string>>>>(
    {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const formId = useId();
  const save = async (typed: KinCompanyDraft) => {
    const checked = kinCompanyInput(orgId, profile, typed);
    setProblem(null);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    const { input } = checked;
    if (input === null) return setDraft(null);
    setSaving(true);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSaving(false);
    props.onRefresh();
    if (!outcome.ok) return setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
    setDraft(null);
    setSaved(true);
  };
  const lock = (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {KIN_COMPANY.private}
    </p>
  );
  if (draft === null) {
    const sections = kinCompanyRead(profile).filter((section) => section.rows.length > 0);
    return (
      <div className="flex flex-col gap-5 px-3 sm:px-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">{lock}</div>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSaved(false);
                setDraft(kinCompanyDraftOf(profile));
              }}
            >
              <PencilIcon />
              {KIN_COMPANY.edit}
            </Button>
          ) : null}
        </div>
        {saved ? (
          <p role="status" className="text-xs text-muted-foreground">
            {KIN_COMPANY.saved}
          </p>
        ) : null}
        {kinCompanyEmpty(profile) ? (
          <p className="text-sm text-muted-foreground">{KIN_COMPANY.empty}</p>
        ) : (
          sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{section.title}</h3>
              <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-1.5 text-sm">
                {section.rows.map((row) => (
                  <div key={row.id} className="contents">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-6 px-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft);
      }}
    >
      {lock}
      {KIN_COMPANY_SECTIONS.map((section) => (
        <fieldset key={section.title} className="flex flex-col gap-3">
          <legend className="pb-2 text-xs font-medium text-muted-foreground">
            {section.title}
          </legend>
          {section.fields.map((field) => {
            const id = `${formId}-${field.id}`;
            const shared = {
              id,
              value: draft[field.id],
              placeholder: field.placeholder,
              disabled: saving,
              "aria-invalid": problems[field.id] !== undefined,
              "aria-describedby": problems[field.id] === undefined ? undefined : `${id}-problem`,
            };
            return (
              <div key={field.id} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{field.label}</Label>
                {field.multiline ? (
                  <Textarea
                    {...shared}
                    rows={3}
                    onChange={(event) => setDraft({ ...draft, [field.id]: event.target.value })}
                  />
                ) : (
                  <Input
                    {...shared}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize={field.code ? "characters" : undefined}
                    onChange={(event) => setDraft({ ...draft, [field.id]: event.target.value })}
                  />
                )}
                {problems[field.id] === undefined ? null : (
                  <p id={`${id}-problem`} className="text-xs text-destructive-foreground">
                    {problems[field.id]}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => {
            setProblems({});
            setProblem(null);
            setDraft(null);
          }}
        >
          {KIN_COMPANY.cancel}
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {KIN_COMPANY.save}
        </Button>
      </div>
    </form>
  );
}
