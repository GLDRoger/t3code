import { useAtomValue } from "@effect/atom-react";
import type { KinPlaces } from "@t3tools/client-runtime/kin/kinPlaces";
import {
  KIN_PINS_COPY,
  kinChatMayWritePins,
  kinPinFailureText,
  kinPinStrip,
  type KinPinItem,
  type KinPinStrip,
  type KinPinView,
} from "@t3tools/client-runtime/kin/kinPins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinChatId,
  KinChatMember,
  KinChatPinId,
  KinOrgId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import { Sheet } from "../../../components/ui/Sheet";
import { cn } from "../../../lib/cn";
import { kinPlacesAtom } from "../state/kinChatOnly";
import {
  subscribeKinPinsForeground,
  useKinPinActions,
  useKinPins,
  useKinPinZones,
} from "../state/useKinPins";

const LARGE_TEXT_SCALE = 1.5;
const noPlacesAtom = Atom.make<KinPlaces>({ destinations: [], answered: false });

export interface KinChatPinsController {
  readonly visible: boolean;
  readonly strip: KinPinStrip;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly unpinning: KinChatPinId | null;
  readonly problem: { readonly pinId: KinChatPinId; readonly text: string } | null;
  readonly openSource: (opens: NonNullable<KinPinView["opens"]>) => void;
  readonly unpin: (pinId: KinChatPinId) => Promise<void>;
}

/** Live pinned cards state for a mobile chat screen, keeping the bar overlap math in sync. */
export function useKinChatPins(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly personId: string | null;
  readonly members: ReadonlyArray<KinChatMember>;
  readonly enabled?: boolean;
}): KinChatPinsController {
  const { environmentId, orgId, chatId, personId, members, enabled = true } = props;
  const navigation = useNavigation();
  const zones = useKinPinZones({ environmentId, orgId }, personId, enabled);
  const { supported, pins, views } = useKinPins({ environmentId, orgId, chatId }, zones, {
    enabled,
    subscribeForeground: subscribeKinPinsForeground,
  });
  const actions = useKinPinActions({ environmentId, orgId });
  const places = useAtomValue(enabled ? kinPlacesAtom({ environmentId, orgId }) : noPlacesAtom);
  const [open, setOpen] = useState(false);
  const [unpinning, setUnpinning] = useState<KinChatPinId | null>(null);
  const [problem, setProblem] = useState<{
    readonly pinId: KinChatPinId;
    readonly text: string;
  } | null>(null);

  const writable = kinChatMayWritePins(members, personId);
  const strip = kinPinStrip(pins, views, {
    canUnpin: actions.canUnpin,
    writable,
    hasMoney: places.destinations.includes("money"),
  });
  const visible = enabled && supported && strip.count > 0 && strip.first !== null;

  const openSource = (opens: NonNullable<KinPinView["opens"]>) => {
    setOpen(false);
    const target = { environmentId: String(environmentId), orgId: String(orgId) };
    if (opens.kind === "project") {
      navigation.navigate("KinProject", { ...target, project: opens.key });
      return;
    }
    if (opens.kind === "goal") {
      navigation.navigate("KinWork", { ...target, show: "money" });
      return;
    }
    navigation.navigate("KinWorkItem", { ...target, task: opens.key });
  };

  const unpin = async (pinId: KinChatPinId) => {
    if (unpinning !== null) return;
    setUnpinning(pinId);
    setProblem(null);
    const outcome = await actions.unpin({ chatId, pinId });
    setUnpinning(null);
    if (AsyncResult.isFailure(outcome)) {
      setProblem({
        pinId,
        text: kinPinFailureText(squashAtomCommandFailure(outcome), "unpin"),
      });
      return;
    }
    if (outcome.value.pins.length === 0) setOpen(false);
  };

  return {
    visible,
    strip,
    open,
    setOpen: (next) => {
      setOpen(next);
      if (!next) setProblem(null);
    },
    unpinning,
    problem,
    openSource,
    unpin,
  };
}

/**
 * One-line pinned strip under the chat bar.
 * Always stays one line; at largest Dynamic Type sizes collapses to "N pinned".
 */
export function KinChatPinsStrip(props: { readonly pins: KinChatPinsController }) {
  const { pins } = props;
  const { fontScale } = useWindowDimensions();
  const first = pins.strip.first;
  if (!pins.visible || first === null) return null;
  const { strip } = pins;
  const large = fontScale >= LARGE_TEXT_SCALE;

  const content = (
    <View className="min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-4">
      <SymbolView
        name="pin"
        size={13}
        tintColorClassName={
          !large && first.view.tone === "late" ? "accent-danger" : "accent-icon-muted"
        }
      />
      {large ? (
        <Text
          textRole="footnote"
          numberOfLines={1}
          ellipsizeMode="tail"
          className="min-w-0 flex-1 font-t3-medium text-foreground"
        >
          {strip.largeLabel}
        </Text>
      ) : (
        <>
          <Text
            textRole="footnote"
            numberOfLines={1}
            ellipsizeMode="tail"
            className={cn(
              "min-w-0 shrink font-t3-medium",
              first.view.tone === "muted" ? "text-foreground-muted" : "text-foreground",
            )}
          >
            {first.view.title}
          </Text>
          {first.view.line === null ? null : (
            <Text
              textRole="footnote"
              numberOfLines={1}
              ellipsizeMode="tail"
              className={cn(
                "min-w-0 shrink tabular-nums",
                first.view.tone === "late" ? "text-danger-foreground" : "text-foreground-muted",
              )}
            >
              {first.view.line}
            </Text>
          )}
          {strip.more === null ? null : (
            <Text
              textRole="footnote"
              numberOfLines={1}
              className="ml-auto shrink-0 font-t3-medium tabular-nums text-foreground-muted"
            >
              {strip.more}
            </Text>
          )}
        </>
      )}
    </View>
  );

  const label = large
    ? strip.largeLabel
    : [first.view.title, first.view.line, strip.more].filter((part) => part !== null).join(", ");

  return (
    <>
      {strip.hasActions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => pins.setOpen(true)}
          className="active:opacity-70"
        >
          {content}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={label}>
          {content}
        </View>
      )}
      {pins.open ? <KinChatPinsSheet pins={pins} /> : null}
    </>
  );
}

function KinChatPinsSheet(props: { readonly pins: KinChatPinsController }) {
  const { pins } = props;
  return (
    <Sheet
      title={KIN_PINS_COPY.sheetTitle}
      dismissDisabled={pins.unpinning !== null}
      onClose={() => pins.setOpen(false)}
    >
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-10">
        {pins.strip.items.map((item) => (
          <KinPinSheetRow
            key={item.pin.pinId}
            item={item}
            unpinning={pins.unpinning}
            problem={pins.problem?.pinId === item.pin.pinId ? pins.problem.text : null}
            onOpen={pins.openSource}
            onUnpin={pins.unpin}
          />
        ))}
      </ScrollView>
    </Sheet>
  );
}

function KinPinSheetRow(props: {
  readonly item: KinPinItem;
  readonly unpinning: KinChatPinId | null;
  readonly problem: string | null;
  readonly onOpen: (opens: NonNullable<KinPinView["opens"]>) => void;
  readonly onUnpin: (pinId: KinChatPinId) => Promise<void>;
}) {
  const { item } = props;
  const opens = item.view.opens;
  const body = (
    <View className="flex-row items-center gap-2 py-3.5">
      <View className="min-w-0 flex-1 gap-1">
        <Text
          textRole="body"
          className={cn(
            "font-t3-medium",
            item.view.tone === "muted" ? "text-foreground-muted" : "text-foreground",
          )}
        >
          {item.view.title}
        </Text>
        {item.view.line === null ? null : (
          <Text
            textRole="footnote"
            className={cn(
              "tabular-nums",
              item.view.tone === "late" ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {item.view.line}
          </Text>
        )}
      </View>
      {opens === null ? null : (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      )}
    </View>
  );

  return (
    <View className="border-b border-border pb-2">
      <View className="flex-row items-center gap-3">
        {opens === null ? (
          <View accessible className="min-w-0 flex-1">
            {body}
          </View>
        ) : (
          <Pressable
            accessibilityRole="link"
            onPress={() => props.onOpen(opens)}
            className="min-w-0 flex-1 active:opacity-70"
          >
            {body}
          </Pressable>
        )}
        {item.canUnpin ? (
          <Button
            tone="secondary"
            size="compact"
            label={KIN_PINS_COPY.unpinFromChat}
            loading={props.unpinning === item.pin.pinId}
            disabled={props.unpinning !== null}
            onPress={() => void props.onUnpin(item.pin.pinId)}
          />
        ) : null}
      </View>
      {props.problem === null ? null : (
        <Text accessibilityRole="alert" textRole="footnote" className="pb-1 text-danger-foreground">
          {props.problem}
        </Text>
      )}
    </View>
  );
}
