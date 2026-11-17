import { assert } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const state = createOxlintRuleHarness("t3code/kin-one-format", { filename: "fixture.ts" });

// Each invalid case is a copy that drifted before contracts held the one source.
state.invalid(
  "catches a home currency written in",
  'const currency = input.currency ?? "INR";',
  (output) => assert.include(output, "KIN_DEFAULT_HOME_CURRENCY"),
);
state.invalid(
  "catches a currency formatted at the call site",
  `const shown = new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);`,
  (output) => assert.include(output, "formatKinMoney"),
);
state.invalid(
  "catches a number's currency toLocaleString",
  'const shown = amount.toLocaleString("en-US", { style: "currency", currency: "USD" });',
);
state.invalid(
  "catches a time format picked at the call site",
  `const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", minute: "2-digit" });`,
  (output) => assert.include(output, "formatKinWhen"),
);
state.invalid(
  "catches a toLocaleDateString",
  'const shown = at.toLocaleDateString("en-GB", { timeZone: zone, day: "numeric" });',
);
state.invalid(
  "catches a host compared by hand",
  'const local = host === "127.0.0.1" || host === "localhost";',
  (output) => assert.include(output, "kinIsLocalOnlyHost"),
);
state.invalid(
  "catches a locale written in",
  'const shown = formatKinWhen(at, "time", { zone, locale: "en-GB" });',
  (output) => assert.include(output, "textLocale"),
);
state.invalid("catches a loopback prefix by hand", 'const local = host.startsWith("127.");');
state.valid(
  "allows a zone-name lookup",
  'const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });',
);
state.valid(
  "allows a zone read",
  "const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;",
);
state.valid(
  "allows a plain number format",
  'const shown = new Intl.NumberFormat("en-US").format(n);',
);
state.valid("allows the one source", 'const shown = formatKinWhen(at, "day", { zone });');
