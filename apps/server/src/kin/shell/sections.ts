import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { listNumberSeenBy, seenBy, type KinViewer } from "../work/teamView.ts";

import type { KinPulseSense } from "@t3tools/contracts";

import type { SHARED_TOOLS } from "../lead/SharedTools.ts";
import type { PresetId } from "../work/registers.ts";
import type { ListName } from "../work/lists.ts";

export const DEALS_OFF = "Deals is turned off for this company.";

export type SectionId = "clients" | "deals" | "money" | "invoices" | "docs";

export const SECTIONS = {
  tools: {
    kin_chat_post: null,
    kin_widget_upsert: null,
    kin_ask: null,
    kin_ask_close: null,
    kin_ask_person: null,
    kin_react: null,
    message_withdraw: null,
    message_replace: null,
    kin_chart: null,
    kin_visual: null,
    kin_chat_read: null,
    kin_leads: null,
    agent_update: null,
    kin_computer: null,
    people_read: null,
    people_update: null,
    away_set: null,
    kin_hand_off: null,
    kin_take_private: null,
    kin_relay: null,
    team_open: null,
    team_say: null,
    memory_search: null,
    memory_read: null,
    memory_write: null,
    kin_journal: null,
    memory_label: null,
    kin_defer: null,
    kin_schedule: null,
    kin_cancel: null,
    kin_github_review: null,
    kin_github_review_ask: null,
    kin_github_link: null,
    kin_github_watch: null,
    records_query: null,
    record_get: null,
    touch_log: "clients",
    client_read: "clients",
    record_create: null,
    record_update: null,
    pulse_read: null,
    pulse_handle: null,
    pulse_nudge: null,
    record_assign: null,
    record_hand_back: null,
    record_comment: null,
    record_link: null,
    project_note: "clients",
    doc_create: null,
    doc_read: null,
    doc_edit: null,
    doc_rewrite: null,
    doc_move: null,
    doc_link: null,
    docs_search: null,
    doc_history: null,
    doc_restore: null,
    list_define: null,
    payment_record: "invoices",
    deal_stages: "deals",
    money_summary: "money",
    money_query: "money",
    budget_set: "money",
    number_record: null,
    numbers_read: null,
    dates_query: null,
    company_profile: null,
    company_sections: null,
    numbers_watch: null,
    statement_read: "money",
    statement_rows: "money",
    bills_add: "money",
    bill_read: "money",
    kin_document: null,
    kin_picture: null,
    kin_recipes: null,
    kin_issue: null,
    kin_recipe_undo: null,
    kin_receipt: "money",
    kin_connection_tools: null,
    kin_connection_call: null,
    kin_connection_offer: null,
    kin_connection_note: null,
    social_read: null,
    social_lookup: null,
    social_draft: null,
    social_week: null,
    social_pack: null,
    pipeline_read: "deals",
    web_page: null,
    orchestrator_capabilities: null,
    delegate_task: null,
    task_status: null,
    task_cancel: null,
    t3_workflow_stop: null,
    t3_background_wait: null,
    t3_thread_list: null,
    t3_thread_read: null,
    t3_thread_send: null,
    t3_thread_wait: null,
    t3_thread_interrupt: null,
    t3_pending_request: null,
    t3_environment_links: null,
    t3_environment_read: null,
    t3_project_list: null,
    t3_project_read: null,
    t3_project_create: null,
    t3_project_update: null,
    t3_project_delete: null,
    t3_project_clone: null,
    t3_worktree_handoff: null,
    t3_worktree_status: null,
    t3_worktree_list: null,
    link_pull_request: null,
    link_pull_requests: null,
    unlink_pull_request: null,
    unlink_pull_requests: null,
    list_thread_pull_requests: null,
    watch_pull_request: null,
    unwatch_pull_request: null,
    write_pull_request_guides: null,
    read_pull_request_guide: null,
    preview_status: null,
    preview_open: null,
    preview_dialog: null,
    preview_navigate: null,
    preview_resize: null,
    preview_set_appearance: null,
    preview_snapshot: null,
    preview_act: null,
    preview_evaluate: null,
    preview_wait_for: null,
    preview_recording_start: null,
    preview_recording_stop: null,
    t3_preview_list: null,
    t3_preview_close: null,
    device_list: null,
    device_open: null,
    device_screenshot: null,
    device_close: null,
    html_preview: null,
    html_render: null,
    t3_attachment_prepare_upload: null,
    t3_attachment_discard: null,
    t3_thread_send_attachments: null,
  } satisfies Record<keyof typeof SHARED_TOOLS, SectionId | null>,
  lists: {
    work: null,
    clients: "clients",
    contacts: "clients",
    projects: "clients",
    milestones: "clients",
    goals: null,
    deals: "deals",
    docs: null,
    expenses: "money",
    receipts: "money",
    dates: "money",
    bank_transactions: "money",
    subscriptions: "money",
    invoices: "invoices",
    quotes: "invoices",
  } satisfies Record<ListName | PresetId | "bank_transactions" | "subscriptions", SectionId | null>,
  keys: {
    W: null,
    C: "clients",
    CT: "clients",
    P: "clients",
    M: "clients",
    G: null,
    DL: "deals",
    D: null,
    EXP: "money",
    RCT: "money",
    DT: "money",
    BNK: "money",
    BTX: "money",
    BANK: "money",
    BKTX: "money",
    BK9: "money",
    INV: "invoices",
    QT: "invoices",
  } satisfies Record<string, SectionId | null>,
  senses: {
    task_late: null,
    task_due_soon: null,
    task_stalled: null,
    waiting_long: null,
    theirs_late: null,
    to_confirm: null,
    invoice_overdue: "invoices",
    quote_unanswered: "invoices",
    retainer_due: "invoices",
    renewal_due: "money",
    budget_over: "money",
    budget_near: "money",
    worker_failed: null,
    task_stuck: null,
    work_held: null,
    client_quiet: "clients",
    client_cold: "clients",
    client_waiting_on_us: "clients",
    goal_behind: null,
    pr_open_long: null,
    pr_failing: null,
    pr_review_waiting: null,
    pr_ready: null,
    milestone_late: "clients",
    milestone_at_risk: "clients",
    project_no_plan: "clients",
    project_quiet: "clients",
    spec_changed: null,
    meeting_passed: null,
    meeting_soon: null,
    holder_removed: null,
    statement_missing: "money",
    bank_alerts_unreadable: "money",
    deal_no_next_step: "deals",
    deal_quiet: "deals",
    deal_date_passed: "deals",
    number_off: null,
    number_stale: null,
    // A list section's own facts: each carries its `list:<id>` section, whose switch silences it.
    entry_late: null,
    entry_check: null,
    sense_overflow: null,
    // A project's contract renewal, which needs no deal (`KIN_PROMISE_SENSES`).
    notice_due: null,
  } satisfies Record<KinPulseSense, SectionId | null>,
};

const section = (table: Readonly<Record<string, SectionId | null>>, id: string) =>
  Object.hasOwn(table, id) ? (table[id] ?? null) : null;

export const sectionOfTool = (toolName: string) => section(SECTIONS.tools, toolName);
export const sectionOfList = (listId: string) => section(SECTIONS.lists, listId);
export const sectionOfKey = (recordKey: string) =>
  section(
    SECTIONS.keys,
    recordKey
      .trim()
      .toUpperCase()
      .match(/^([A-Z][A-Z0-9]{0,7})-[1-9]\d{0,8}$/)?.[1] ?? "",
  );
export const sectionOfSense = (senseId: string) => section(SECTIONS.senses, senseId);

type SectionRegister = {
  readonly id: string;
  readonly name: string | null;
  readonly payments: number | null;
};

export const sectionOfRegister = ({ id, name, payments }: SectionRegister): SectionId | null => {
  if (id === "invoices" || id === "quotes") return "invoices";
  if (id === "payments" || payments === 1 || name?.trim().toLowerCase() === "bank transactions")
    return "money";
  if (id === "dates" || id === "subscriptions") return null;
  return sectionOfList(id);
};

/** Kin's own lists, and any paid over time, have their place already: none is a section. */
export const listSectionRefused = (row: SectionRegister) =>
  Object.hasOwn(SECTIONS.lists, row.id) || sectionOfRegister(row) !== null;

export const registerSectionColumns = (sql: SqlClient.SqlClient) =>
  sql`r.register_id AS id, g.name, json_extract(g.definition_json, '$.payments') AS payments`;

export const looksLikeRecordReference = (value: string, explicit = false) =>
  value.length > 0 && value.length <= 40 && !/[\r\n]/.test(value) && (explicit || /\d/.test(value));

// An unresolved reference only gets a prefix classification for Kin's reserved built-ins.
const sectionOfBuiltInKey = (key: string) =>
  /^(?:C|CT|P|M|DL)-/.test(key.trim().toUpperCase()) ? sectionOfKey(key) : null;

const encodeReferences = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

// Exactly the key or the unambiguous displayed number; a row outside the viewer looks absent.
export const resolveSections = Effect.fn("KinShell.resolveSections")(function* (
  orgId: KinOrgId,
  references: ReadonlySet<string>,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  type Row = SectionRegister & {
    readonly key: string;
    readonly number: string | null;
    readonly visible: number;
  };
  const rows =
    references.size === 0
      ? []
      : yield* sql<Row>`
    WITH wanted AS (SELECT value FROM json_each(${yield* encodeReferences([...references])}))
    SELECT r.key, CASE WHEN ${listNumberSeenBy(sql, viewer)}
        THEN json_extract(r.fields_json, '$.number') END AS number, ${registerSectionColumns(sql)},
      ${seenBy(sql, viewer)} AS visible
    FROM kin_records r
    LEFT JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
    WHERE r.org_id = ${orgId}
      AND (r.key IN (SELECT upper(value) FROM wanted)
        OR json_extract(r.fields_json, '$.number') IN (SELECT value FROM wanted))
    ORDER BY r.key`;
  const keys = new Map(rows.map((row) => [row.key, row]));
  const numbers = new Map<string, Row | null>();
  for (const row of rows)
    if (row.number !== null) numbers.set(row.number, numbers.has(row.number) ? null : row);
  return (reference: string) => {
    const row = keys.get(reference.toUpperCase()) ?? numbers.get(reference);
    return row?.visible === 1 ? sectionOfRegister(row) : sectionOfBuiltInKey(reference);
  };
});
