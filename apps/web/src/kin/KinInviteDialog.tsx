import {
  KIN_INVITE_LOCAL_ONLY_NOTE,
  KIN_INVITE_PHONE_NOTE,
  KIN_TEAMMATE_NAME_MAX,
  KIN_TEAM_ADD_COPY,
  kinInviteLink,
  kinInviteLinkCopy,
  kinInviteLinkLocalOnly,
  kinTeammateNameCheck,
  type KinMadeInvite,
  type KinTeamActions,
} from "@t3tools/client-runtime/kin/kinTeam";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CheckIcon, CopyIcon, ShareIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { usePreparedConnection } from "../state/session";

/** What the dialog is showing: the name form, or a link the host just made. */
export type KinInviteDialogState =
  | { readonly stage: "name" }
  | { readonly stage: "link"; readonly invite: KinMadeInvite };

/**
 * Adds a teammate by name, then shows their link once. The link lives in the Team page's state
 * only, so closing the dialog is the last anyone sees of it.
 */
export function KinInviteDialog(props: {
  readonly state: KinInviteDialogState;
  readonly environmentId: EnvironmentId;
  readonly actions: KinTeamActions;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        {props.state.stage === "name" ? (
          <NameForm
            busy={busy}
            setBusy={setBusy}
            actions={props.actions}
            onMade={props.onMade}
            onClose={props.onClose}
          />
        ) : (
          <InviteLink
            invite={props.state.invite}
            environmentId={props.environmentId}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function NameForm(props: {
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly actions: KinTeamActions;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const { busy } = props;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const nameId = useId();
  const checked = kinTeammateNameCheck(name);

  const save = async () => {
    if (!checked.ok || busy) return;
    props.setBusy(true);
    setProblem(null);
    const made = await props.actions.makeLink({
      displayName: checked.name,
      personId: null,
      replaces: null,
    });
    props.setBusy(false);
    if (made.ok) props.onMade(made.invite);
    else setProblem(made.problem);
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{KIN_TEAM_ADD_COPY.title}</DialogTitle>
        <DialogDescription>{KIN_TEAM_ADD_COPY.detail}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>{KIN_TEAM_ADD_COPY.nameLabel}</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={KIN_TEAMMATE_NAME_MAX}
              placeholder={KIN_TEAM_ADD_COPY.namePlaceholder}
              autoComplete="off"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{KIN_TEAM_ADD_COPY.nameHint}</p>
          </div>
          {problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!checked.ok || busy} aria-busy={busy}>
          {KIN_TEAM_ADD_COPY.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

function InviteLink(props: {
  readonly invite: KinMadeInvite;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { invite } = props;
  const connection = Option.getOrNull(usePreparedConnection(props.environmentId));
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "invite link" });
  const linkId = useId();
  const copy = kinInviteLinkCopy(invite);
  // The connection can drop while the dialog is up; the link was made, so say how to get another.
  const link = connection === null ? null : kinInviteLink(connection.httpBaseUrl, invite.secret);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.detail}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {link === null || connection === null ? (
          <Alert variant="error">
            <AlertDescription>
              The connection dropped before the link could be shown. Make a new link for{" "}
              {invite.displayName} from Team once you're back online.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            <Label htmlFor={linkId} className="sr-only">
              Invite link for {invite.displayName}
            </Label>
            <Textarea
              id={linkId}
              readOnly
              rows={3}
              value={link}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => copyToClipboard(link)}>
                {isCopied ? <CheckIcon /> : <CopyIcon />}
                {isCopied ? "Copied" : "Copy link"}
              </Button>
              {canShare ? (
                <Button
                  variant="outline"
                  // Dismissing the share sheet rejects; there is nothing to report.
                  onClick={() => void navigator.share({ url: link }).catch(() => undefined)}
                >
                  <ShareIcon />
                  Share…
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{KIN_INVITE_PHONE_NOTE}</p>
            {kinInviteLinkLocalOnly(connection.httpBaseUrl) ? (
              <Alert variant="warning">
                <AlertDescription>{KIN_INVITE_LOCAL_ONLY_NOTE}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
