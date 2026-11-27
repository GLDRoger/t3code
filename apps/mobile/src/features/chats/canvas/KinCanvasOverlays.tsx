import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_CANVAS } from "@t3tools/client-runtime/kin/kinCanvasView";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import type { KinCanvasTasks as KinCanvasShow } from "../state/useKinCanvas";

const PANEL = "rounded-full border border-border bg-card";

function RoundButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="size-11 items-center justify-center rounded-full active:bg-subtle-strong"
    >
      <SymbolView name={props.icon} size={17} tintColorClassName="accent-icon" />
    </Pressable>
  );
}

export function KinCanvasZoomControls(props: {
  readonly onZoomOut: () => void;
  readonly onZoomIn: () => void;
  readonly onShowAll: () => void;
}) {
  return (
    <View className={`${PANEL} flex-row items-center p-0.5`}>
      <RoundButton icon="minus" label={KIN_CANVAS.zoomOut} onPress={props.onZoomOut} />
      <RoundButton
        icon="arrow.up.left.and.arrow.down.right"
        label={KIN_CANVAS.showAll}
        onPress={props.onShowAll}
      />
      <RoundButton icon="plus" label={KIN_CANVAS.zoomIn} onPress={props.onZoomIn} />
    </View>
  );
}

/** In progress, or every open task: what the map draws tasks of. */
export function KinCanvasShowSwitch(props: {
  readonly show: KinCanvasShow;
  readonly onShow: (show: KinCanvasShow) => void;
}) {
  return (
    <SegmentedControl<KinCanvasShow>
      size="compact"
      className="w-60"
      role="tab"
      options={[
        { value: "doing", label: KIN_CANVAS.doing },
        { value: "open", label: KIN_CANVAS.allOpen },
      ]}
      selected={props.show}
      onSelect={props.onShow}
    />
  );
}

/** Where the map stops short of everything, in one quiet line. */
/** Where the map stops short or what didn't load, with Retry when something failed. */
export function KinCanvasPartial(props: {
  readonly lines: ReadonlyArray<string>;
  readonly onRetry: (() => void) | null;
}) {
  if (props.lines.length === 0) return null;
  return (
    <View className="flex-row items-center gap-2 self-start rounded-full bg-card/90 py-1 ps-3 pe-1">
      <Text textRole="caption" className="shrink py-0.5 text-foreground-muted">
        {props.lines.join(" · ")}
      </Text>
      {props.onRetry === null ? null : (
        <Button tone="secondary" size="compact" label={KIN_RETRY} onPress={props.onRetry} />
      )}
    </View>
  );
}
