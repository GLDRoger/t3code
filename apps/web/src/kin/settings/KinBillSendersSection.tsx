import { useAtomValue } from "@effect/atom-react";
import { KIN_OFFLINE_PAGE, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_BILL_SENDERS,
  kinBillSenderAddInput,
  kinBillSenderConfirm,
  kinBillSenderGroups,
  kinBillSenderPermissions,
  type KinBillSenderAction,
  type KinBillSenderRowView,
} from "@t3tools/client-runtime/kin/kinBillSenders";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { Fragment, useState, type ReactNode } from "react";

import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinConfirm } from "../KinConfirm";
import { kinClient } from "../kinClient";
import { KinGateFailed } from "../KinWorkParts";
import { kinHostConnected, useKinGate } from "../useKinHost";
import { useKinBillSenders } from "../useKinMoney";
import type { KinWorkTarget } from "../useKinWork";
import { KinSenderAddress } from "./KinSenderAddress";
import { KinSettingsField, KinSettingsFormDialog } from "./KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./KinSettingsLayout";

type Ask = { readonly action: KinBillSenderAction | "add"; readonly address: string };

/** Settings → Company details → Billing senders, for the owner and co-owners only. */
export function KinBillSendersSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const searchableSetting = useSearchableSetting();
  const searchId = searchableSetting("kin-bill-senders").id;

  const listPermission = useAtomValue(kinClient.billSendersList.permissionStateAtom(environmentId));
  const canApprove = useAtomValue(kinClient.billSendersApprove.permissionAtom(environmentId));
  const canDecline = useAtomValue(kinClient.billSendersDecline.permissionAtom(environmentId));
  const canRemove = useAtomValue(kinClient.billSendersRemove.permissionAtom(environmentId));
  const canAdd = useAtomValue(kinClient.billSendersAdd.permissionAtom(environmentId));
  const permissions = kinBillSenderPermissions({
    list: listPermission,
    grants: {
      approve: canApprove,
      decline: canDecline,
      remove: canRemove,
      addBack: canAdd,
      add: canAdd,
    },
  });
  const gate = useKinGate(
    kinClient.billSendersList.permissionStateAtom(environmentId),
    environmentId,
  );
  const { state, refresh } = useKinBillSenders(props, gate === null);

  const commands = {
    approve: useAtomCommand(kinClient.billSendersApprove, { reportFailure: false }),
    decline: useAtomCommand(kinClient.billSendersDecline, { reportFailure: false }),
    remove: useAtomCommand(kinClient.billSendersRemove, { reportFailure: false }),
    add: useAtomCommand(kinClient.billSendersAdd, { reportFailure: false }),
  };

  const [ask, setAsk] = useState<Ask | null>(null);
  const [adding, setAdding] = useState<{ draft: string; problem: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [now] = useState(() => kinNow().getTime());

  if (!permissions.visible || state._tag === "refused") return null;

  const section = (children: ReactNode, action?: ReactNode) => (
    <KinSettingsSection
      title={KIN_BILL_SENDERS.title}
      description={KIN_BILL_SENDERS.description}
      searchId={searchId}
      problem={problem}
      said={said}
      action={action}
    >
      {children}
    </KinSettingsSection>
  );

  if (gate === "offline")
    return section(<KinSettingsEmpty>{KIN_OFFLINE_PAGE.detail}</KinSettingsEmpty>);
  if (gate === "failed") return section(<KinGateFailed className="px-4 py-3" />);
  if (gate === "loading" || state._tag === "loading")
    return section(<KinSettingsLoading rows={2} />);
  if (state._tag !== "ready") {
    const text =
      state._tag === "failed"
        ? kinFailureText(state.cause, KIN_BILL_SENDERS.loadFailed)
        : KIN_BILL_SENDERS.loadFailed;
    return section(<KinSettingsLoadFailed onRetry={refresh}>{text}</KinSettingsLoadFailed>);
  }

  const groups = kinBillSenderGroups(state.value.rows, { now });

  const act = async ({ action, address }: Ask) => {
    setBusy(address);
    setProblem(null);
    setSaid(null);
    const input = { orgId, address };
    const command =
      action === "approve"
        ? commands.approve
        : action === "decline"
          ? commands.decline
          : action === "remove"
            ? commands.remove
            : commands.add;
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => command({ environmentId, input }),
    });
    setBusy(null);
    refresh();
    if (!outcome.ok) {
      const text =
        outcome.problem ||
        (action === "add" ? KIN_BILL_SENDERS.addFailed : KIN_BILL_SENDERS.failed[action]);
      // A typed address comes back to its form, so nothing has to be typed again.
      return action === "add" ? setAdding({ draft: address, problem: text }) : setProblem(text);
    }
    const value: unknown = outcome.value;
    if (typeof value === "object" && value !== null && "message" in value)
      setSaid(String(value.message));
  };

  const addButton = permissions.can("add") ? (
    <Button
      size="xs"
      variant="outline"
      disabled={busy !== null}
      onClick={() => setAdding({ draft: "", problem: null })}
    >
      {KIN_BILL_SENDERS.add}
    </Button>
  ) : undefined;
  const question = ask === null ? null : kinBillSenderConfirm(ask.action, ask.address);

  return (
    <>
      {section(
        groups.length === 0 ? (
          <KinSettingsEmpty action={addButton}>{KIN_BILL_SENDERS.empty}</KinSettingsEmpty>
        ) : (
          groups.map((group) => (
            <Fragment key={group.state}>
              <h4 className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                {group.title}
              </h4>
              {group.rows.map((row) => (
                <BillSenderRow
                  key={row.address}
                  row={row}
                  can={permissions.can}
                  busy={busy !== null}
                  onAct={(action) => setAsk({ action, address: row.address })}
                />
              ))}
            </Fragment>
          ))
        ),
        groups.length === 0 ? undefined : addButton,
      )}
      <KinConfirm
        ask={question}
        onConfirm={() => {
          const target = ask;
          setAsk(null);
          if (target !== null) void act(target);
        }}
        onClose={() => setAsk(null)}
      />
      {adding === null ? null : (
        <KinSettingsFormDialog
          title={KIN_BILL_SENDERS.addTitle}
          description={KIN_BILL_SENDERS.addDescription}
          submitLabel={KIN_BILL_SENDERS.addSubmit}
          busy={false}
          problem={adding.problem}
          typed={adding.draft.trim() !== ""}
          onSubmit={() => {
            const checked = kinBillSenderAddInput(orgId, adding.draft);
            if (!checked.ok) return setAdding({ ...adding, problem: checked.problem });
            setAdding(null);
            setAsk({ action: "add", address: checked.input.address });
          }}
          onClose={() => setAdding(null)}
        >
          <KinSettingsField name="address" label={KIN_BILL_SENDERS.addressLabel}>
            {(ids) => (
              <Input
                id={ids.control}
                // Kin checks the address itself, in the host's own words.
                inputMode="email"
                value={adding.draft}
                placeholder={KIN_BILL_SENDERS.addressPlaceholder}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={adding.problem !== null}
                onChange={(event) => setAdding({ draft: event.target.value, problem: null })}
              />
            )}
          </KinSettingsField>
        </KinSettingsFormDialog>
      )}
    </>
  );
}

function BillSenderRow(props: {
  readonly row: KinBillSenderRowView;
  readonly can: (action: KinBillSenderAction) => boolean;
  readonly busy: boolean;
  readonly onAct: (action: KinBillSenderAction) => void;
}) {
  const { row } = props;
  const lines = [row.seenLine, row.askedLine, row.decidedLine].filter((line) => line !== null);
  const actions = row.actions.filter(props.can);
  return (
    <KinSettingsRow
      stack
      title={<KinSenderAddress segments={row.addressSegments} />}
      detail={
        lines.length === 0 ? null : (
          <span className="flex flex-col gap-0.5">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )
      }
      control={
        actions.length === 0
          ? null
          : actions.map((action) => (
              <Button
                key={action}
                size="xs"
                variant={action === "approve" ? "default" : "outline"}
                disabled={props.busy}
                aria-label={`${KIN_BILL_SENDERS.action[action]}: ${row.address}`}
                onClick={() => props.onAct(action)}
              >
                {KIN_BILL_SENDERS.action[action]}
              </Button>
            ))
      }
    />
  );
}
