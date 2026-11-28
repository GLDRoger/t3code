#!/bin/sh
set -eu
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0
trap 'exit 1' HUP INT TERM

identity=${KIN_SIGNER_IDENTITY:--}
export KIN_PROBE_OUT="$tmp" KIN_PROBE_ARCH="$(uname -m)"
if [ "$identity" != "-" ]; then
  : "${KIN_SIGNER_PROFILE:?set the signer profile}"
  : "${KIN_SIGNER_TEAM_ID:?set the signer team}"
  : "${KIN_SIGNER_ID:?set the signer bundle ID}"
  case "${KIN_SIGNER_ATTEST_ENV:-}" in
    development|production) ;; *) echo "Set KIN_SIGNER_ATTEST_ENV to development or production." >&2; exit 1 ;;
  esac
  case "$KIN_SIGNER_PROFILE" in /*) ;; *) export KIN_SIGNER_PROFILE="$PWD/$KIN_SIGNER_PROFILE";; esac
fi
cd "$(dirname "$0")/../../../../scripts"
node --input-type=module <<'JS'
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { buildKinSigner } from "./lib/kin-signer.ts";
await Effect.runPromise(Effect.gen(function* () {
  const real = process.env.KIN_SIGNER_IDENTITY && process.env.KIN_SIGNER_IDENTITY !== "-";
  const id = real ? process.env.KIN_SIGNER_ID : "example.kin.signer";
  if (!id.endsWith(".signer")) throw new Error("KIN_SIGNER_ID must end in .signer.");
  const signing = real ? {
    teamId: process.env.KIN_SIGNER_TEAM_ID,
    profilePath: process.env.KIN_SIGNER_PROFILE,
    expectedEnvironment: process.env.KIN_SIGNER_ATTEST_ENV,
  } : undefined;
  const arch = process.env.KIN_PROBE_ARCH === "arm64" ? "arm64" : "x64";
  yield* buildKinSigner({ arch, outDir: process.env.KIN_PROBE_OUT, appId: id.slice(0, -7), version: "1.0.0", signing });
}).pipe(Effect.provide(NodeServices.layer)));
JS
app="$tmp/Kin Signer.app"
set -- --probe --out "$tmp/probe.json"
if [ -n "${KIN_SIGNER_ATTEST_NONCE:-}" ]; then set -- "$@" --attest --nonce "$KIN_SIGNER_ATTEST_NONCE"; fi
if [ "$identity" = "-" ]; then codesign -s - --force --options runtime --timestamp=none "$app"; else codesign -s "$identity" --force --options runtime --timestamp --entitlements "$tmp/kin-signer-entitlements.plist" "$app"; fi
"$app/Contents/MacOS/kin-signer" "$@"
