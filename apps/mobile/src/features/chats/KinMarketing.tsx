import {
  KIN_MARKETING,
  kinCameFromLabel,
  kinCampaignResultRows,
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
  KinContactExport,
  KinContactListInput,
  KinMarketing,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinWorkTextField } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import type { KinWorkTarget } from "./state/useKinWork";

const NONE: KinMarketing = { tags: [], cameFrom: [] };

/** The tags and places "Came from" offers this reader; none while it loads or on an older host. */
export function useKinMarketing({ environmentId, orgId }: KinWorkTarget): KinMarketing {
  const result = useAtomValue(kinClient.workMarketing({ environmentId, input: { orgId } }));
  return Option.getOrNull(AsyncResult.value(result)) ?? NONE;
}

/** Writes the host's CSV to the cache and opens the share sheet with it. */
async function shareCsv(file: KinContactExport) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const Sharing = await import("expo-sharing");
  const directory = new Directory(Paths.cache, "kin-exports");
  directory.create({ idempotent: true, intermediates: true });
  const out = new File(directory, file.filename);
  if (out.exists) out.delete();
  out.create();
  out.write(file.csv);
  const end = beginForegroundHandoff();
  try {
    await Sharing.shareAsync(out.uri, {
      mimeType: "text/csv",
      UTI: "public.comma-separated-values-text",
      dialogTitle: file.filename,
    });
  } finally {
    end();
  }
}

/** Export list: the host makes the file from what this reader may see; the phone shares it. */
export function useKinExportList(target: KinWorkTarget) {
  const exportList = useAtomCommand(kinClient.workContactsExport, { reportFailure: false });
  const [state, setState] = useState<"idle" | "busy" | { readonly failed: string }>("idle");
  const run = async (input: KinContactListInput) => {
    setState("busy");
    const result = await exportList({ environmentId: target.environmentId, input });
    if (!AsyncResult.isSuccess(result))
      return setState({
        failed: kinFailureText(
          AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
          KIN_MARKETING.exportFailed,
        ),
      });
    try {
      await shareCsv(result.value);
      setState("idle");
    } catch (cause) {
      setState({ failed: cause instanceof Error ? cause.message : KIN_MARKETING.exportFailed });
    }
  };
  return { state, run };
}

export function KinExportListRow(props: KinWorkTarget & { readonly input: KinContactListInput }) {
  const { state, run } = useKinExportList(props);
  return (
    <ListActionRow
      icon="square.and.arrow.up"
      label={state === "busy" ? KIN_MARKETING.exporting : KIN_MARKETING.exportList}
      description={typeof state === "object" ? state.failed : undefined}
      loading={state === "busy"}
      onPress={() => void run(props.input)}
    />
  );
}

/** Tags on a contact: each with a way off, a field to add one, and the company's to pick. */
export function KinTagFields(props: {
  readonly tags: ReadonlyArray<string>;
  readonly company: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (tags: ReadonlyArray<string>) => void;
}) {
  const [typed, setTyped] = useState("");
  const choices = kinTagChoices(props.tags, props.company, typed);
  const add = (tag: string) => {
    props.onChange(kinTagsWith(props.tags, tag));
    setTyped("");
  };
  return (
    <ListSection title={KIN_MARKETING.tags} footer={KIN_MARKETING.tagsHint}>
      {props.tags.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2 px-4 pt-3">
          {props.tags.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              size="small"
              trailingIcon="xmark"
              accessibilityLabel={KIN_MARKETING.removeTag(tag)}
              disabled={props.disabled}
              onPress={() => props.onChange(kinTagsWithout(props.tags, tag))}
            />
          ))}
        </View>
      )}
      <KinWorkTextField
        label={KIN_MARKETING.tagPlaceholder}
        value={typed}
        maxLength={60}
        disabled={props.disabled}
        placeholder={KIN_MARKETING.audiencePlaceholder}
        onChangeText={setTyped}
      />
      <View className="flex-row flex-wrap items-center gap-2 px-4 pb-3">
        <Button
          label={KIN_MARKETING.addTag}
          disabled={props.disabled || typed.trim() === ""}
          onPress={() => add(typed)}
        />
        {choices.map((tag) => (
          <Chip
            key={tag}
            label={tag}
            size="small"
            icon="plus"
            disabled={props.disabled}
            onPress={() => add(tag)}
          />
        ))}
      </View>
    </ListSection>
  );
}

/** "Came from": the company's campaigns to pick, or their own words. */
export function KinCameFromFields(props: {
  readonly label: string;
  readonly value: string;
  readonly choices: ReadonlyArray<KinCameFrom>;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly moved?: string | undefined;
  readonly onChange: (source: string) => void;
}) {
  if (kinIsCampaignSource(props.value))
    return (
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        <View className="flex-row">
          <Chip
            label={`${KIN_MARKETING.campaign}: ${kinCameFromLabel(props.value, props.choices)}`}
            trailingIcon="xmark"
            accessibilityLabel={`Clear ${props.label}`}
            disabled={props.disabled}
            onPress={() => props.onChange("")}
          />
        </View>
      </View>
    );
  const campaigns = props.choices.filter((one) => one.campaign);
  return (
    <>
      <KinWorkTextField
        label={props.label}
        value={props.value}
        disabled={props.disabled}
        maxLength={120}
        placeholder={props.placeholder}
        moved={props.moved}
        onChangeText={props.onChange}
      />
      {campaigns.length === 0 ? null : (
        <View className="flex-row flex-wrap items-center gap-2 px-4 pb-3">
          <Text className="text-sm text-foreground-muted">{KIN_MARKETING.cameFromCampaigns}</Text>
          {campaigns.map((one) => (
            <Chip
              key={one.source}
              label={one.label}
              size="small"
              disabled={props.disabled}
              onPress={() => props.onChange(one.source)}
            />
          ))}
        </View>
      )}
    </>
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
    <ListSection
      title={KIN_MARKETING.results}
      footer={
        props.audience === null
          ? `${KIN_MARKETING.noAudience} ${KIN_MARKETING.resultsNote}`
          : KIN_MARKETING.resultsNote
      }
    >
      {rows.map((row) => (
        <ListActionRow
          key={row.id}
          label={row.label}
          detail={row.value}
          onPress={() => props.onOpen(row.id)}
        />
      ))}
    </ListSection>
  );
}
