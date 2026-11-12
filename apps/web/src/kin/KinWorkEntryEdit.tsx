import { KIN_LISTS } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinWorkFile } from "@t3tools/contracts";
import { ChevronDownIcon, FileIcon, ImageIcon, PencilIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { cn } from "../lib/utils";
import { KinWorkRowSkeletons } from "./KinWorkParts";
import { useKinWorkFiles } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

/** One of an entry's details that is one of a few things: a category, a client, a choice, a person. */
export function KinEntryPick(props: {
  readonly label: string;
  readonly shown: string | null;
  readonly current: string | null;
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly disabled: boolean;
  readonly onPick: (value: string | null) => void;
}) {
  const shown = props.shown ?? KIN_LISTS.entry.none;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            aria-label={`${props.label}: ${shown}. Change`}
          />
        }
      >
        <span className={cn("truncate", props.shown === null && "text-muted-foreground")}>
          {shown}
        </span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.choices.map((choice) => (
          <MenuItem
            key={choice.value}
            disabled={choice.value === props.current}
            onClick={() => props.onPick(choice.value)}
          >
            {choice.label}
          </MenuItem>
        ))}
        {props.current === null ? null : (
          <>
            {props.choices.length === 0 ? null : <MenuSeparator />}
            <MenuItem onClick={() => props.onPick(null)}>{KIN_LISTS.entry.none}</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/**
 * A detail that is typed: shown as it reads until it is tapped, then a box with Save and Cancel
 * right where it was. `onSave` answers why it wasn't saved, or null once it was.
 */
export function KinEntryText(props: {
  readonly label: string;
  readonly shown: string | null;
  readonly draft: string;
  readonly placeholder?: string;
  readonly numeric?: boolean;
  /** The entry's headline amount reads large; everything else reads as a row. */
  readonly headline?: boolean;
  readonly disabled: boolean;
  readonly onSave: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  if (text === null)
    return (
      <button
        type="button"
        disabled={props.disabled}
        aria-label={`${props.label}: ${props.shown ?? KIN_LISTS.entry.none}. ${KIN_LISTS.entry.edit}`}
        onClick={() => {
          setProblem(null);
          setText(props.draft);
        }}
        className={cn(
          "group -mx-1.5 flex max-w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset disabled:pointer-events-none",
          props.headline
            ? "text-2xl font-semibold tracking-tight text-foreground tabular-nums"
            : "text-sm text-foreground",
          props.shown === null && "text-muted-foreground",
        )}
      >
        <span className="min-w-0 whitespace-pre-wrap">
          {props.shown ?? (props.headline ? `Add ${props.label.toLowerCase()}` : "–")}
        </span>
        <PencilIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    );
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void props.onSave(text).then((failed) => {
          setSaving(false);
          setProblem(failed);
          if (failed === null) setText(null);
        });
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          id={id}
          aria-label={props.label}
          autoFocus
          autoComplete="off"
          {...(props.numeric ? { inputMode: "decimal" as const } : {})}
          {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
          value={text}
          disabled={saving}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setText(null);
            }
          }}
        />
        <Button type="submit" size="sm" disabled={saving} aria-busy={saving}>
          {KIN_LISTS.entry.save}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => setText(null)}
        >
          {KIN_WORK_COPY.cancel}
        </Button>
      </div>
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

const sentFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** The files already in the owner's chats, newest first, to keep one on an entry. */
export function KinEntryFilePicker(
  props: KinWorkTarget & {
    readonly label: string;
    /** Already on the entry, so not offered again. */
    readonly held: ReadonlyArray<string>;
    readonly onPick: (file: KinWorkFile) => void;
    readonly onClose: () => void;
  },
) {
  const [text, setText] = useState("");
  const { state, retry } = useKinWorkFiles(props, text);
  const files =
    state._tag === "ready"
      ? state.files.filter((file) => !props.held.includes(file.attachmentId))
      : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{KIN_LISTS.entry.filesTitle}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              type="search"
              autoFocus
              aria-label={KIN_LISTS.entry.filesSearch}
              placeholder={KIN_LISTS.entry.filesSearch}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {state._tag === "loading" ? (
              <div role="status" aria-label="Loading files">
                <KinWorkRowSkeletons />
              </div>
            ) : state._tag === "failed" ? (
              <div className="flex flex-col items-start gap-3">
                <Alert variant="error">
                  <AlertDescription>{KIN_LISTS.entry.filesFailed}</AlertDescription>
                </Alert>
                <Button size="sm" variant="outline" onClick={retry}>
                  Retry
                </Button>
              </div>
            ) : files.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                {text.trim() === "" ? KIN_LISTS.entry.filesNone : KIN_LISTS.entry.filesNoMatch}
              </p>
            ) : (
              <ul aria-label={props.label} className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
                {files.map((file) => {
                  const Icon = file.mimeType.startsWith("image/") ? ImageIcon : FileIcon;
                  return (
                    <li key={file.attachmentId}>
                      <button
                        type="button"
                        onClick={() => props.onPick(file)}
                        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
                      >
                        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {file.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {sentFormat.format(new Date(file.sentAt))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
