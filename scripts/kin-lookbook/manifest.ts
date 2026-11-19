// @effect-diagnostics nodeBuiltinImport:off - reads and writes a look book set's manifest.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const SIZES = [
  { name: "wide", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const;
export type SizeName = (typeof SIZES)[number]["name"];

export interface ManifestScreen {
  readonly name: string;
  readonly size: SizeName;
  readonly file: string;
  readonly person: string;
  /** Regions painted over before capture because they cannot be made stable, and why. */
  readonly masked: ReadonlyArray<string>;
  /** Still changing after 20 s: two captures of this screen may differ. */
  readonly unsettled?: boolean;
}

export interface Manifest {
  readonly version: 1;
  /** `web` today; a phone capture would add `ios` or `android` sets beside it. */
  readonly surface: "web";
  readonly commit: string;
  readonly shortCommit: string;
  /** When the capture ran, real time. */
  readonly capturedAt: string;
  /** The moment the instance's clock was frozen at. */
  readonly frozenAt: string;
  readonly timeZone: string;
  readonly sizes: ReadonlyArray<{ name: SizeName; width: number; height: number }>;
  readonly screens: ReadonlyArray<ManifestScreen>;
  /** What a screenshot cannot see: the browser tab's title and icon, per person and screen. */
  readonly tab: Readonly<
    Record<string, { title: string; icon: string; iconSha256: string | null }>
  >;
  /** Screens that failed to capture, with the reason. */
  readonly failed: ReadonlyArray<{ name: string; size: SizeName; error: string }>;
}

export const fileOf = (name: string, size: SizeName) => `${name}.${size}.png`;

export function writeManifest(dir: string, manifest: Manifest) {
  NodeFS.writeFileSync(
    NodePath.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/** The set's manifest; a folder without one is not a look book set. */
export function readManifest(dir: string): Manifest {
  const path = NodePath.join(dir, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${dir} has no readable manifest.json; is it a look book set?`);
  }
  const manifest = raw as Partial<Manifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.commit !== "string" ||
    !Array.isArray(manifest.screens) ||
    manifest.screens.some((screen) => typeof screen?.file !== "string")
  )
    throw new Error(`${path} is not a version 1 look book manifest`);
  return manifest as Manifest;
}
