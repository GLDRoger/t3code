import {
  KIN_MARKETING,
  kinCameFromLabel,
  kinCampaignResultRows,
  kinContactListView,
  kinIsCampaignSource,
  kinTagChoices,
  kinTagsWith,
  kinTagsWithout,
  type KinCampaignResultId,
} from "@t3tools/client-runtime/kin/kinMarketing";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  KinCameFrom,
  KinCampaignResults,
  KinContactListInput,
  KinMarketing,
  KinRecordKey,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon, XIcon } from "lucide-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
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
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { KinWorkSection } from "./KinWorkParts";
import type { KinWorkTarget } from "./useKinWork";

const NONE: KinMarketing = { tags: [], cameFrom: [] };

/** The tags and places "Came from" offers this reader; none while it loads or on an older host. */
export function useKinMarketing({ environmentId, orgId }: KinWorkTarget): KinMarketing {
  const result = useAtomValue(kinClient.workMarketing({ environmentId, input: { orgId } }));
  return Option.getOrNull(AsyncResult.value(result)) ?? NONE;
}

/** Tags on a contact: each one with a way off, a field to add one, and the company's to pick. */
export function KinTagEditor(props: {
  readonly id: string;
  readonly tags: ReadonlyArray<string>;
  readonly company: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onChange: (tags: ReadonlyArray<string>) => void;
}) {
  const [typed, setTyped] = useState("");
  const choices = kinTagChoices(props.tags, props.company, typed);
  const add = (tag: string) => {
    props.onChange(kinTagsWith(props.tags, tag));
    setTyped("");
  };
  return (
    <div className="flex flex-col gap-2">
      {props.tags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5" aria-label={KIN_MARKETING.tags}>
          {props.tags.map((tag) => (
            <li key={tag}>
              <Badge size="sm" variant="outline">
                {tag}
                <Button
                  type="button"
                  size="icon-tiny"
                  variant="ghost"
                  aria-label={KIN_MARKETING.removeTag(tag)}
                  disabled={props.disabled}
                  onClick={() => props.onChange(kinTagsWithout(props.tags, tag))}
                >
                  <XIcon />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={props.id}
          value={typed}
          maxLength={60}
          placeholder={KIN_MARKETING.tagPlaceholder}
          autoComplete="off"
          disabled={props.disabled}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter adds the tag; it never saves the form around it.
            event.preventDefault();
            add(typed);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={props.disabled || typed.trim() === ""}
          onClick={() => add(typed)}
        >
          {KIN_MARKETING.addTag}
        </Button>
      </div>
      {choices.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {choices.map((tag) => (
            <Button
              key={tag}
              type="button"
              size="xs"
              variant="outline"
              disabled={props.disabled}
              onClick={() => add(tag)}
            >
              {tag}
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{KIN_MARKETING.tagsHint}</p>
    </div>
  );
}

/** "Came from": the company's campaigns to pick, or their own words. */
export function KinCameFromField(props: {
  readonly id: string;
  readonly value: string;
  readonly choices: ReadonlyArray<KinCameFrom>;
  readonly placeholder: string;
  readonly onChange: (source: string) => void;
}) {
  const campaigns = props.choices.filter((one) => one.campaign);
  if (kinIsCampaignSource(props.value))
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline">
          {KIN_MARKETING.campaign}: {kinCameFromLabel(props.value, props.choices)}
        </Badge>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Clear ${KIN_MARKETING.cameFrom}`}
          onClick={() => props.onChange("")}
        >
          <XIcon />
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <Input
        id={props.id}
        value={props.value}
        maxLength={120}
        placeholder={props.placeholder}
        autoComplete="off"
        onChange={(event) => props.onChange(event.target.value)}
      />
      {campaigns.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{KIN_MARKETING.cameFromCampaigns}</span>
          {campaigns.map((one) => (
            <Button
              key={one.source}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => props.onChange(one.source)}
            >
              {one.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Downloads a list as the host made it: a CSV of what this reader may see. */
export function KinExportListButton(
  props: KinWorkTarget & { readonly input: KinContactListInput; readonly size?: "sm" | "default" },
) {
  const exportList = useAtomCommand(kinClient.workContactsExport, { reportFailure: false });
  const [state, setState] = useState<"idle" | "busy" | { readonly failed: string }>("idle");
  const run = async () => {
    setState("busy");
    const result = await exportList({ environmentId: props.environmentId, input: props.input });
    if (!AsyncResult.isSuccess(result))
      return setState({
        failed: kinFailureText(
          AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
          KIN_MARKETING.exportFailed,
        ),
      });
    const url = URL.createObjectURL(
      new Blob([result.value.csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = result.value.filename;
    link.click();
    URL.revokeObjectURL(url);
    setState("idle");
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size={props.size ?? "sm"}
        variant="outline"
        disabled={state === "busy"}
        aria-busy={state === "busy"}
        onClick={() => void run()}
      >
        <DownloadIcon />
        {state === "busy" ? KIN_MARKETING.exporting : KIN_MARKETING.exportList}
      </Button>
      {typeof state === "object" ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {state.failed}
        </p>
      ) : null}
    </div>
  );
}

/** A list on screen: its contacts, read again as they change, with Export list. */
export function KinContactListDialog(
  props: KinWorkTarget & {
    readonly input: KinContactListInput;
    readonly title: string;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const result = useAtomValue(
    kinClient.workContactList({ environmentId: props.environmentId, input: props.input }),
  );
  const list = Option.getOrNull(AsyncResult.value(result));
  const view = list === null ? null : kinContactListView(list);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{list?.title ?? props.title}</DialogTitle>
          {view === null ? null : (
            <p className="text-sm text-muted-foreground tabular-nums">{view.count}</p>
          )}
        </DialogHeader>
        <DialogPanel>
          {view === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {AsyncResult.isFailure(result)
                ? kinFailureText(Cause.squash(result.cause), KIN_MARKETING.listFailed)
                : "Loading…"}
            </p>
          ) : view.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_MARKETING.listEmpty}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {view.note === null ? null : (
                <p className="text-xs text-muted-foreground">{view.note}</p>
              )}
              <ul className="-mx-2 flex flex-col">
                {view.rows.map((row) => (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => props.onOpenClient(row.party as KinRecordKey)}
                      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                    >
                      <span className="truncate text-sm text-foreground">{row.name}</span>
                      {row.line === "" ? null : (
                        <span className="truncate text-xs text-muted-foreground">{row.line}</span>
                      )}
                      {row.reach === null ? null : (
                        <span className="truncate text-xs text-muted-foreground">{row.reach}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {view.more === null ? null : (
                <p className="text-xs text-muted-foreground">{view.more}</p>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <div className="me-auto">
            <KinExportListButton {...props} />
          </div>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A campaign's results, counted by the host; each count opens the list it counts. */
export function KinCampaignResultsSection(props: {
  readonly results: KinCampaignResults;
  readonly audience: string | null;
  readonly onOpen: (id: KinCampaignResultId) => void;
}) {
  const rows = kinCampaignResultRows(props.results, props.audience);
  return (
    <KinWorkSection title={KIN_MARKETING.results}>
      <ul className="-mx-2 flex flex-col">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => props.onOpen(row.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
            >
              <span className="text-sm text-muted-foreground">{row.label}</span>
              <span className="text-sm text-foreground tabular-nums">{row.value}</span>
            </button>
          </li>
        ))}
      </ul>
      {props.audience === null ? (
        <p className="text-xs text-muted-foreground">{KIN_MARKETING.noAudience}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{KIN_MARKETING.resultsNote}</p>
    </KinWorkSection>
  );
}
