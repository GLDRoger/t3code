#!/bin/sh
# Runs fixtures/grant-vectors.json through the Swift and Java grant parsers on a Mac with the
# Xcode command line tools and a JDK. No simulator, emulator or Android SDK needed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
module=$(cd "$here/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

node -e '
const { now, cases } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const lines = cases.map((c) => [c.name, c.signingInput ?? `${b64(c.header)}.${b64(c.payload)}`, c.prompt ?? "!" + c.error].join("\t"));
process.stdout.write(`${now}\n${lines.join("\n")}\n`);
' "$module/fixtures/grant-vectors.json" > "$out/vectors.tsv"

xcrun swiftc -O -o "$out/swift-vectors" "$module/ios/KinGrant.swift" "$here/swift/main.swift"
"$out/swift-vectors" "$out/vectors.tsv"

javac -d "$out/java" \
  "$module/android/src/main/java/expo/modules/kinapprovalkey/KinGrant.java" \
  "$here/java/KinGrantVectors.java"
java -cp "$out/java" expo.modules.kinapprovalkey.KinGrantVectors "$out/vectors.tsv"
