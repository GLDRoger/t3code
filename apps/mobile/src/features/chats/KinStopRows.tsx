import { KIN_STOP } from "@t3tools/client-runtime/kin/kinStop";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { useKinStop } from "./state/useKinStop";
import type { KinWorkTarget } from "./state/useKinWork";

/** The company stop switch, for an owner or co-owner; a teammate is told in the chat instead. */
export function KinStopRows(props: KinWorkTarget) {
  const { row, canAct, refresh, stop, resume } = useKinStop(props);
  if (!canAct) return null;
  if (row._tag === "loading")
    return (
      <ListSection title={KIN_STOP.title}>
        <ListRowLayout label={row.detail} />
      </ListSection>
    );
  if (row._tag === "failed")
    return (
      <ListSection title={KIN_STOP.title}>
        <ListRowLayout label={row.detail} />
        {row.retry === null ? null : (
          <ListActionRow label={row.retry} icon="arrow.clockwise" onPress={refresh} />
        )}
      </ListSection>
    );
  const [state, ...rest] = row.lines;
  const description = [...rest, ...(row.reason === null ? [] : [row.reason])].join("\n");
  const action = row.action;
  return (
    <ListSection title={KIN_STOP.title}>
      <ListRowLayout label={state ?? ""} {...(description === "" ? {} : { description })} />
      {action === null ? null : (
        <ListActionRow
          label={action.label}
          icon={action.kind === "stop" ? "pause" : "play"}
          tone={action.kind === "stop" ? "danger" : "default"}
          loading={action.busy}
          onPress={() =>
            action.kind === "resume"
              ? void resume()
              : Dialog.prompt({
                  title: KIN_STOP.ask.title,
                  message: `${KIN_STOP.ask.detail}\n\n${KIN_STOP.ask.reasonHint}`,
                  placeholder: KIN_STOP.ask.reasonLabel,
                  initialValue: "",
                  cancelText: KIN_STOP.ask.cancel,
                  confirmText: KIN_STOP.ask.confirm,
                  onConfirm: (typed) => void stop(typed),
                })
          }
        />
      )}
      {row.problem === null ? null : <Notice message={row.problem} tone="danger" />}
    </ListSection>
  );
}
