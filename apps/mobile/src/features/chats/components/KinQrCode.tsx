import { QrCode } from "@t3tools/shared/qrCode";
import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

const MARGIN = 2;

/** A QR code, always dark on light so any camera reads it, in either theme. */
export function KinQrCode(props: { readonly value: string; readonly size: number }) {
  const { path, cells } = useMemo(() => {
    const code = QrCode.encodeText(props.value, QrCode.Ecc.MEDIUM);
    const runs: Array<string> = [];
    for (let y = 0; y < code.size; y += 1) {
      let start = -1;
      for (let x = 0; x <= code.size; x += 1) {
        if (x < code.size && code.getModule(x, y)) {
          if (start === -1) start = x;
        } else if (start !== -1) {
          runs.push(`M${start + MARGIN} ${y + MARGIN}h${x - start}v1H${start + MARGIN}z`);
          start = -1;
        }
      }
    }
    return { path: runs.join(""), cells: code.size + MARGIN * 2 };
  }, [props.value]);
  return (
    <View className="self-center overflow-hidden rounded-xl bg-white">
      <Svg width={props.size} height={props.size} viewBox={`0 0 ${cells} ${cells}`}>
        <Path d={path} fill="#000" />
      </Svg>
    </View>
  );
}
