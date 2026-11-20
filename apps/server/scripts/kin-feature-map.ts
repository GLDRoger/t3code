// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a dev command that prints a report.
// Renders src/kin/feature-map.yaml as Markdown, generated on demand and never committed.
//   node scripts/kin-feature-map.ts [out.md]
import * as NodeFS from "node:fs";

import {
  checkFeatureMap,
  DOCK_TABS,
  type Feature,
  factsOf,
  loadFeatureMap,
  phoneProofGap,
  readInventory,
} from "../src/kin/featureMap/featureMap.ts";

const map = loadFeatureMap();
const inventory = readInventory();
const problems = checkFeatureMap(map, inventory);
const facts = new Map(map.features.map((feature) => [feature.id, factsOf(feature, inventory)]));

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const path = (steps: ReadonlyArray<string> | undefined) =>
  steps === undefined ? "—" : steps.map((step) => `\`${step}\``).join(" → ");
const reach = (feature: Feature) =>
  Object.entries(feature.roles)
    .map(([role, where]) => `${role.replace("_", "-")}: ${where}`)
    .join(", ");
const proof = (feature: Feature) =>
  feature.proof === "none"
    ? "**none**"
    : feature.proof.map((file) => `\`${file.split("/").at(-1)}\``).join(", ");
const deepest = (feature: Feature) =>
  Math.max(facts.get(feature.id)!.depth.web ?? 0, facts.get(feature.id)!.depth.phone ?? 0);

const tabs = [...DOCK_TABS, "settings", "join"];
const byTab = tabs.map((tab) => ({
  tab,
  features: map.features.filter((feature) => feature.tab === tab),
}));
const noProof = map.features.filter((feature) => feature.proof === "none");
/** Features some role reaches on only one surface, with who. */
const onlyOn = (surface: "web" | "phone") =>
  map.features.filter((f) => Object.values(f.roles).includes(surface));
const whoOnly = (f: Feature, surface: "web" | "phone") =>
  `${f.id} (${Object.entries(f.roles)
    .filter(([, where]) => where === surface)
    .map(([role]) => role)
    .join(", ")})`;
const webOnly = onlyOn("web");
const phoneOnly = onlyOn("phone");
const deepestFeatures = [...map.features].sort((a, b) => deepest(b) - deepest(a)).slice(0, 6);

const lines = [
  "# Kin feature map",
  "",
  `Generated from \`apps/server/src/kin/featureMap/feature-map.yaml\`. ${map.features.length} features; ${inventory.webRoutes.size} web routes, ${inventory.webParams.size} web panes, ${inventory.phoneScreens.size} phone screens, ${inventory.tools.size} agent tools and ${inventory.rpcs.size} RPCs checked.`,
  "",
  problems.length === 0
    ? "The checker finds no problem."
    : `**The checker finds ${problems.length} problem(s):**\n\n${problems.map((one) => `- ${one}`).join("\n")}`,
  "",
  "## Summary",
  "",
  "| Tab | Features | No proof | Web only | Phone only | Deepest |",
  "|---|---|---|---|---|---|",
  ...byTab.map(
    ({ tab, features }) =>
      `| ${tab} | ${features.length} | ${features.filter((f) => f.proof === "none").length} | ${features.filter((f) => webOnly.includes(f)).length} | ${features.filter((f) => phoneOnly.includes(f)).length} | ${Math.max(0, ...features.map(deepest))} |`,
  ),
  "",
  `Deepest paths: ${deepestFeatures.map((f) => `${f.id} (${deepest(f)})`).join(", ")}.`,
  "",
  `No proof (${noProof.length}): ${noProof.map((f) => f.id).join(", ") || "none"}.`,
  "",
  `Reached on the phone with no proof under apps/mobile: ${phoneProofGap(map).length} of ${map.features.length}.`,
  "",
  `Some role reaches it on web only (${webOnly.length}): ${webOnly.map((f) => whoOnly(f, "web")).join(", ") || "none"}. On phone only (${phoneOnly.length}): ${phoneOnly.map((f) => whoOnly(f, "phone")).join(", ") || "none"}.`,
  "",
  ...byTab.flatMap(({ tab, features }) =>
    features.length === 0
      ? []
      : [
          `## ${tab[0]!.toUpperCase()}${tab.slice(1)}`,
          "",
          "| Feature | Web | Phone | Who | Agent tools | Proof |",
          "|---|---|---|---|---|---|",
          ...features.map(
            (feature) =>
              `| **${cell(feature.name)}** \`${feature.id}\`${feature.note ? `<br>${cell(feature.note)}` : ""}${feature.depth_reason ? `<br>Depth: ${cell(feature.depth_reason)}` : ""} | ${path(feature.web)} | ${path(feature.phone)} | ${reach(feature)} | ${(feature.tools ?? []).map((tool) => `\`${tool}\``).join(", ") || "—"} | ${proof(feature)} |`,
          ),
          "",
        ],
  ),
  ...(map.unlisted === undefined
    ? []
    : [
        "## Not in any feature, on purpose",
        "",
        ...Object.entries(map.unlisted).map(([key, why]) => `- \`${key}\`: ${why}`),
        "",
      ]),
];

const out = process.argv[2];
if (out === undefined) process.stdout.write(lines.join("\n"));
else {
  NodeFS.writeFileSync(out, lines.join("\n"));
  console.log(
    `kin-feature-map: wrote ${out} (${map.features.length} features, ${problems.length} problems)`,
  );
}
