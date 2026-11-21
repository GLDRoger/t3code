import type { OxlintConfig } from "vite-plus/lint";

// Kin's own lint rules, spread into the root vite.config.ts overrides in place.
export const kinLintOverrides = [
  {
    // A person's read applies `personSees` through a required `KinViewer`; docs/kin/RULES.md.
    files: ["apps/server/src/kin/**"],
    excludeFiles: ["**/*.{test,testkit}.ts"],
    rules: {
      "t3code/kin-viewer-scoped-reads": "error",
      "t3code/kin-owner-level": "error",
      "t3code/kin-messages-to-people": "error",
    },
  },
  {
    // A failure's words come from client-runtime's kin/kinAnswers.ts; docs/kin/RULES.md.
    files: [
      "packages/client-runtime/src/kin/**",
      "apps/web/src/kin/**",
      "apps/web/src/components/settings/Kin*.tsx",
      "apps/mobile/src/features/chats/**",
    ],
    // Approvals (Face ID, keychain) and joining (before any Kin answers) fail on the device.
    excludeFiles: [
      "**/*.test.{ts,tsx}",
      "packages/client-runtime/src/kin/kinAnswers.ts",
      "packages/client-runtime/src/kin/kinApprovalPresentation.ts",
      "packages/client-runtime/src/kin/kinJoin.ts",
      "apps/mobile/src/features/chats/approvals/**",
    ],
    rules: { "t3code/kin-failure-words": "error" },
  },
  {
    // The gate, the floor, the chat service and the turn's own reply are the floor's path.
    files: [
      "apps/server/src/kin/lead/LevelGate.ts",
      "apps/server/src/kin/floor/**",
      "apps/server/src/kin/chat/KinChatService.ts",
      "apps/server/src/kin/reply/KinReplyBridge.ts",
      "apps/server/src/kin/mcp/KinChatToolkit.ts",
    ],
    rules: { "t3code/kin-messages-to-people": "off" },
  },
  {
    // The server's own zone is no person's; a client's device zone is its viewer's.
    files: ["apps/server/src/kin/**"],
    excludeFiles: ["**/*.{test,testkit}.ts"],
    rules: { "t3code/kin-zoned-time": "error" },
  },
  {
    // Money, days, times and local hosts each have one source in contracts; docs/kin/RULES.md.
    files: [
      "apps/server/src/kin/**",
      "packages/client-runtime/src/kin/**",
      "packages/contracts/src/kin*.ts",
      "apps/web/src/kin/**",
      "apps/web/src/components/settings/Kin*.tsx",
      "apps/web/src/components/settings/ApprovalsSettings.tsx",
      "apps/mobile/src/features/chats/**",
    ],
    excludeFiles: [
      "**/*.{test,testkit}.{ts,tsx}",
      "packages/contracts/src/kinCurrency.ts",
      "packages/contracts/src/kinWhen.ts",
      "packages/contracts/src/kinPeople.ts",
    ],
    rules: { "t3code/kin-one-format": "error" },
  },
  {
    // The one place that answers "may act as owner" and "is the owner himself".
    files: ["apps/server/src/kin/people/KinAccess.ts"],
    rules: { "t3code/kin-owner-level": "off" },
  },
  {
    files: [
      "apps/server/src/kin/work/crm.ts",
      "apps/server/src/kin/work/projectSpine.ts",
      "apps/server/src/kin/work/leadSpine.ts",
      "apps/server/src/kin/work/leadWork.ts",
      "apps/server/src/kin/work/leadDocs.ts",
      "apps/server/src/kin/work/leadClients.ts",
      "apps/server/src/kin/work/leadMoney.ts",
      "apps/server/src/kin/work/owner*.ts",
      "apps/server/src/kin/work/moneyViews.ts",
      "apps/server/src/kin/work/search.ts",
      "apps/server/src/kin/work/goals.ts",
      "apps/server/src/kin/pulse/people.ts",
      "apps/server/src/kin/pulse/checkIns.ts",
    ],
    rules: { "t3code/kin-viewer-scoped-reads": ["error", { readModel: true }] },
  },
  {
    files: [
      "apps/server/src/kin/**/rpcHandlers.ts",
      "apps/server/src/kin/**/mcp/**",
      "apps/server/src/kin/mcp/**",
    ],
    excludeFiles: ["**/*.{test,testkit}.ts"],
    rules: { "t3code/kin-viewer-scoped-reads": ["error", { transport: true }] },
  },
] satisfies NonNullable<OxlintConfig["overrides"]>;
