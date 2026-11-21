import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_TASKS_KEYS_COPY,
  kinTasksKeyGuide,
  kinTasksKeyLabelCheck,
  kinTasksKeyMade,
  kinTasksKeyMakeBlocked,
  kinTasksKeyRemoveCopy,
  kinTasksKeyRows,
  type KinTasksKeyRow,
} from "@t3tools/client-runtime/kin/kinTasksKeys";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinTasksKeysIssueResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentSession } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

/**
 * A person's coding agent keys. Your own: list, make one, remove. The owner level on a
 * teammate's: list and remove only. The host decides both.
 */
export function KinTasksKeysSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  /** Null on your own profile; the holder's name on a teammate's. */
  readonly holder: string | null;
}) {
  const { environmentId, orgId, personId, holder } = props;
  const query = kinClient.tasksKeys({ environmentId, input: { orgId, personId } });
  const result = useAtomValue(query);
  const canMake = useAtomValue(kinClient.tasksKeyIssue.permissionAtom(environmentId));
  const canRemove = useAtomValue(kinClient.tasksKeyRevoke.permissionAtom(environmentId));
  const issue = useAtomCommand(kinClient.tasksKeyIssue, { reportFailure: false });
  const revoke = useAtomCommand(kinClient.tasksKeyRevoke, { reportFailure: false });
  // Shown gone at once; the host's next read is the authority.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  // The key just made. Held here only, so leaving the screen is the last anyone sees of it.
  const [made, setMade] = useState<KinTasksKeysIssueResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const connection = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const listed = Option.getOrNull(AsyncResult.value(result));
  const keys = listed?.keys ?? null;
  const live = keys?.filter((key) => !removed.has(key.sessionId)) ?? null;
  const rows = live === null ? null : kinTasksKeyRows(live);
  const blocked = live === null ? null : kinTasksKeyMakeBlocked(live.length);
  const refresh = () => appAtomRegistry.refresh(query);
  const guide =
    holder === null && listed !== null
      ? kinTasksKeyGuide({
          origin: listed.origin,
          httpBaseUrl: connection?.httpBaseUrl ?? null,
          device: "phone",
        })
      : undefined;

  const remove = async (row: KinTasksKeyRow) => {
    setProblem(null);
    setRemoved((held) => new Set(held).add(row.sessionId));
    const outcome = await revoke({ environmentId, input: { orgId, sessionId: row.sessionId } });
    if (!AsyncResult.isSuccess(outcome)) {
      setRemoved((held) => {
        const next = new Set(held);
        next.delete(row.sessionId);
        return next;
      });
      setProblem(
        kinFailureText(squashAtomCommandFailure(outcome), KIN_TASKS_KEYS_COPY.removeFailed, {
          gone: KIN_TASKS_KEYS_COPY.removeGone,
        }),
      );
    }
    refresh();
  };

  const askRemove = (row: KinTasksKeyRow) => {
    const copy = kinTasksKeyRemoveCopy(row.label, holder);
    Dialog.confirm({
      title: copy.title,
      message: copy.detail,
      confirmText: copy.confirm,
      destructive: true,
      onConfirm: () => void remove(row),
    });
  };

  const make = async (typed: string) => {
    const checked = kinTasksKeyLabelCheck(typed);
    if (!checked.ok) return setProblem(checked.problem);
    setBusy(true);
    setProblem(null);
    const outcome = await issue({ environmentId, input: { orgId, label: checked.label } });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome)) setMade(outcome.value);
    else
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_TASKS_KEYS_COPY.makeFailed));
    refresh();
  };

  const askLabel = () =>
    Dialog.prompt({
      title: KIN_TASKS_KEYS_COPY.makeTitle,
      message: `${KIN_TASKS_KEYS_COPY.labelLabel} ${KIN_TASKS_KEYS_COPY.labelHint}`,
      initialValue: "",
      confirmText: KIN_TASKS_KEYS_COPY.create,
      onConfirm: (value) => void make(value),
    });

  const footer =
    holder === null
      ? (blocked ?? KIN_TASKS_KEYS_COPY.intro)
      : KIN_TASKS_KEYS_COPY.theirsIntro(holder);
  return (
    <>
      <ListSection title={KIN_TASKS_KEYS_COPY.title} footer={footer}>
        {rows === null ? (
          <ListRowLayout
            label={AsyncResult.isFailure(result) ? KIN_TASKS_KEYS_COPY.loadFailed : "Loading…"}
            disabled
          />
        ) : rows.length === 0 ? (
          <ListRowLayout
            label={
              holder === null ? KIN_TASKS_KEYS_COPY.none : KIN_TASKS_KEYS_COPY.noneTheirs(holder)
            }
            disabled
          />
        ) : (
          rows.map((row, index) => (
            <View
              key={row.sessionId}
              className={index === 0 ? "" : "border-t border-border-subtle"}
            >
              <ListRowLayout
                label={row.label}
                description={row.line}
                accessory={
                  canRemove && row.canRemove ? (
                    <Button
                      tone="outline"
                      size="compact"
                      label={KIN_TASKS_KEYS_COPY.remove}
                      accessibilityLabel={`${KIN_TASKS_KEYS_COPY.remove} ${row.label}`}
                      onPress={() => askRemove(row)}
                    />
                  ) : undefined
                }
              />
            </View>
          ))
        )}
        {holder === null && canMake ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              label={KIN_TASKS_KEYS_COPY.make}
              icon="lock"
              loading={busy}
              disabled={blocked !== null || rows === null}
              onPress={askLabel}
            />
          </View>
        ) : null}
      </ListSection>
      {guide === undefined ? null : (
        <KinTasksKeyGuide
          guide={guide}
          onMake={canMake && rows?.length === 0 && blocked === null ? askLabel : null}
        />
      )}
      {problem === null ? null : <ErrorBanner message={problem} />}
      {made === null ? null : (
        <KinTasksKeyOnce made={made} environmentId={environmentId} onDone={() => setMade(null)} />
      )}
    </>
  );
}

function KinTasksKeyOnce(props: {
  readonly made: KinTasksKeysIssueResult;
  readonly environmentId: EnvironmentId;
  readonly onDone: () => void;
}) {
  const connection = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(props.environmentId)),
  );
  if (connection === null) return <ErrorBanner message={KIN_TASKS_KEYS_COPY.dropped} />;
  const panel = kinTasksKeyMade({
    key: props.made.key,
    secret: props.made.secret,
    origin: props.made.origin,
    httpBaseUrl: connection.httpBaseUrl,
    device: "phone",
  });
  return (
    <>
      <View className="gap-2 px-2">
        <Text textRole="title" accessibilityRole="header" className="font-t3-bold text-foreground">
          {panel.title}
        </Text>
        {panel.lines.map((line) => (
          <Text key={line} textRole="body" className="text-foreground-muted">
            {line}
          </Text>
        ))}
      </View>
      <CopyField label={KIN_TASKS_KEYS_COPY.keyLabel} value={panel.secret} />
      <CopyField
        label={KIN_TASKS_KEYS_COPY.addressLabel}
        value={panel.address}
        footer={panel.addressNote ?? undefined}
      />
      <Text textRole="headline" className="px-2 text-foreground">
        {KIN_TASKS_KEYS_COPY.setupTitle}
      </Text>
      {panel.setups.map((setup) => (
        <CopyField key={setup.agent} label={setup.agent} value={setup.text} footer={setup.where} />
      ))}
      <Button tone="secondary" fullWidth label={KIN_TASKS_KEYS_COPY.done} onPress={props.onDone} />
    </>
  );
}

/** Where a key goes, always on your own section; the setup lines stay folded until asked for. */
function KinTasksKeyGuide(props: {
  readonly guide: ReturnType<typeof kinTasksKeyGuide>;
  /** The next step for someone with no key yet; null when they have one or can't make one. */
  readonly onMake: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const { guide } = props;
  if (guide === null) return <ErrorBanner message={KIN_TASKS_KEYS_COPY.addressUnknown} />;
  return (
    <>
      <CopyField
        label={KIN_TASKS_KEYS_COPY.addressLabel}
        value={guide.address}
        footer={guide.addressNote ?? undefined}
      />
      <Button
        tone="text"
        size="compact"
        icon={open ? "chevron.down" : "chevron.right"}
        label={KIN_TASKS_KEYS_COPY.setupHow}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <Text textRole="body" className="px-2 text-foreground-muted">
            {KIN_TASKS_KEYS_COPY.standIn}
          </Text>
          {guide.setups.map((setup) => (
            <CopyField
              key={setup.agent}
              label={setup.agent}
              value={setup.text}
              footer={setup.where}
            />
          ))}
          {props.onMake === null ? null : (
            <Button tone="secondary" label={KIN_TASKS_KEYS_COPY.makeTitle} onPress={props.onMake} />
          )}
        </>
      ) : null}
    </>
  );
}

function CopyField(props: {
  readonly label: string;
  readonly value: string;
  readonly footer?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <ListSection
      title={props.label}
      footer={props.footer}
      trailing={
        <Button
          tone="text"
          size="compact"
          icon={copied ? "checkmark" : "doc.on.doc"}
          label={copied ? KIN_TASKS_KEYS_COPY.copied : KIN_TASKS_KEYS_COPY.copy}
          accessibilityLabel={`${KIN_TASKS_KEYS_COPY.copy} ${props.label}`}
          onPress={() =>
            void tryCopyTextWithHaptic(props.value, { target: props.label }).then(setCopied)
          }
        />
      }
    >
      <View className="px-4 py-3">
        <Text textRole="footnote" selectable className="font-mono text-foreground">
          {props.value}
        </Text>
      </View>
    </ListSection>
  );
}
