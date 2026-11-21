import {
  KIN_NEW_TEAMMATE_SEES,
  KIN_PLACE_SWITCHES,
  KIN_TEAM_COPY,
  KIN_INVITE_PHONE_NOTE,
  KIN_TEAMMATE_NAME_MAX,
  KIN_TEAM_ADD_COPY,
  kinInviteLinkCopy,
  kinInviteTyped,
  kinRemovedNamesake,
  kinShareLink,
  kinTeammateNameCheck,
  kinTeammateNameMatch,
  type KinMadeInvite,
  type KinTeamActions,
  type KinTeamList,
} from "@t3tools/client-runtime/kin/kinTeam";
import type { EnvironmentId, KinPersonPlaceSwitches } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CheckIcon, CopyIcon, ShareIcon } from "lucide-react";
import { useId, useState } from "react";

import { KIN_FORM_DISCARD } from "@t3tools/client-runtime/kin/kinWorkForms";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
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
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { usePreparedConnection } from "../state/session";
import { useKinPublicUrl } from "./useKinOwnerLevel";

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
  readonly list: KinTeamList;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Only the name form asks before closing; once the link is made there is nothing left to lose.
  const [typed, setTyped] = useState(false);
  const [asking, setAsking] = useState(false);
  const close = () => {
    if (props.state.stage === "name" && typed) setAsking(true);
    else props.onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-lg">
        {props.state.stage === "name" ? (
          <NameForm
            busy={busy}
            setBusy={setBusy}
            actions={props.actions}
            list={props.list}
            onMade={props.onMade}
            onTyped={setTyped}
            onClose={close}
          />
        ) : (
          <InviteLink
            invite={props.state.invite}
            environmentId={props.environmentId}
            onClose={props.onClose}
          />
        )}
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{KIN_FORM_DISCARD.title}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {KIN_FORM_DISCARD.keep}
              </AlertDialogClose>
              <Button variant="destructive" onClick={props.onClose}>
                {KIN_FORM_DISCARD.discard}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}

function NameForm(props: {
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly actions: KinTeamActions;
  readonly list: KinTeamList;
  readonly onMade: (invite: KinMadeInvite) => void;
  /** Whether what is typed would be lost on closing (`kinInviteTyped`), told as it changes. */
  readonly onTyped: (typed: boolean) => void;
  readonly onClose: () => void;
}) {
  const { busy } = props;
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // The host's offer to bring back a removed person by this name, and who that is.
  const [offer, setOffer] = useState<{
    readonly text: string;
    readonly person: ReturnType<typeof kinRemovedNamesake>;
  } | null>(null);
  const [sees, setSees] = useState<KinPersonPlaceSwitches>(KIN_NEW_TEAMMATE_SEES);
  const nameId = useId();
  const checked = kinTeammateNameCheck(name);
  const match = kinTeammateNameMatch(props.list, name);

  const make = async (
    person: NonNullable<ReturnType<typeof kinRemovedNamesake>> | null,
    newPerson?: true,
  ) => {
    if (!checked.ok || busy) return;
    props.setBusy(true);
    setProblem(null);
    setOffer(null);
    const made = await props.actions.makeLink({
      displayName: person?.displayName ?? checked.name,
      personId: person?.personId ?? null,
      ...(newPerson === true ? { newPerson } : {}),
      // Someone coming back gets back what they had; only someone new starts with these.
      ...(person === null ? { sees } : {}),
      replaces:
        person === null
          ? null
          : (props.list.invites.find((held) => held.personId === person.personId)?.inviteId ??
            null),
    });
    props.setBusy(false);
    if (made.ok) props.onMade(made.invite);
    else if (made.bringBack === true)
      setOffer({ text: made.problem, person: kinRemovedNamesake(props.list, checked.name) });
    else setProblem(made.problem);
  };
  const save = () => make(null);

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
        <DialogDescription>{KIN_TEAM_ADD_COPY.detail(false)}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>{KIN_TEAM_ADD_COPY.nameLabel}</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={KIN_TEAMMATE_NAME_MAX}
              autoComplete="off"
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                props.onTyped(kinInviteTyped({ name: event.target.value, sees }));
              }}
            />
            <p className="text-xs text-muted-foreground">{KIN_TEAM_ADD_COPY.nameHint}</p>
          </div>
          {match === null ? null : (
            <Alert variant="warning">
              <AlertDescription>{match}</AlertDescription>
            </Alert>
          )}
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium text-foreground">
              {KIN_TEAM_COPY.canSee}
            </legend>
            {KIN_PLACE_SWITCHES.map((entry) => {
              const id = `${nameId}-${entry.place}`;
              return (
                <div key={entry.place} className="flex items-start justify-between gap-3">
                  <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">{entry.label}</span>
                    <span className="text-xs text-muted-foreground">{entry.detail}</span>
                  </label>
                  <Switch
                    id={id}
                    checked={sees[entry.place]}
                    disabled={busy}
                    onCheckedChange={(on) => {
                      const next = { ...sees, [entry.place]: on };
                      setSees(next);
                      props.onTyped(kinInviteTyped({ name, sees: next }));
                    }}
                  />
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{KIN_TEAM_ADD_COPY.seesFooter}</p>
          </fieldset>
          {problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          {offer === null ? null : (
            <Alert>
              <AlertDescription>
                {offer.text}
                {offer.person === null ? null : (
                  <Button
                    type="button"
                    size="sm"
                    className="self-start"
                    disabled={busy}
                    onClick={() => void make(offer.person)}
                  >
                    Bring back {offer.person.displayName}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => void make(null, true)}
                >
                  {KIN_TEAM_ADD_COPY.someoneElse}
                </Button>
              </AlertDescription>
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
  const publicUrl = useKinPublicUrl(props.environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("invite link"),
  });
  const linkId = useId();
  const copy = kinInviteLinkCopy(invite);
  // The connection can drop while the dialog is up; the link was made, so say how to get another.
  const shared =
    connection === null
      ? null
      : kinShareLink({ publicUrl, httpBaseUrl: connection.httpBaseUrl }, invite.secret);
  const link = shared?.link ?? null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.detail}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {link === null || shared === null ? (
          <Alert variant="error">
            <AlertDescription>{KIN_TEAM_ADD_COPY.linkDropped(invite.displayName)}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            <Label htmlFor={linkId} className="sr-only">
              {KIN_TEAM_COPY.inviteLinkFor(invite.displayName)}
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
            {shared.note === null ? null : (
              <Alert variant="warning">
                <AlertDescription>{shared.note}</AlertDescription>
              </Alert>
            )}
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
