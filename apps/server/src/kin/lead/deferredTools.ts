/**
 * Kin tools a lead finds through its provider's tool search instead of carrying every turn: rarely
 * used jobs. Every other Kin tool loads up front (each provider's descriptor), so a
 * tool added later is never deferred by default, and a name here that no longer exists is inert.
 */
export const KIN_DEFERRED_TOOLS: ReadonlySet<string> = new Set([
  "kin_issue",
  "kin_receipt",
  "kin_recipe_undo",
  "list_define",
  "company_profile",
  "budget_set",
  "doc_restore",
  "kin_connection_note",
  "kin_github_review",
  "kin_github_watch",
  "kin_github_link",
  "kin_chart",
  "kin_visual",
  "kin_picture",
  "kin_widget_upsert",
  "doc_rewrite",
  "doc_history",
  "doc_link",
  "doc_move",
  "team_open",
  "people_update",
  "agent_update",
  "record_hand_back",
  "record_link",
  "project_note",
]);

/** `Tool.Meta` for a deferred tool: Claude Code overrides the server's `alwaysLoad` with it. */
export const deferredMeta = { "anthropic/alwaysLoad": false } as const;
