import { assert } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const scoped = createOxlintRuleHarness("t3code/kin-viewer-scoped-reads", {
  filename: "fixture.ts",
});

scoped.invalid(
  "refuses an optional viewer list, where leaving it out reads everything",
  "export const page = Effect.fn('p')(function* (row: RecordRow, viewers?: ReadonlyArray<KinPersonId>) {});",
  (output) => assert.include(output, "KIN_OWNER_LEVEL"),
);
scoped.invalid(
  "refuses a viewer typed as possibly undefined",
  "const reader = (team: KinPersonId | undefined) => team;",
);
scoped.invalid(
  "refuses an optional viewer in an options type",
  "type QueryInput = { readonly team?: KinPersonId };",
);
scoped.valid(
  "allows an optional flag that only shares the name",
  "type Patch = { readonly team?: boolean };",
);

// projectPage after its first fix: the viewer reached the page, but its counts, waiting
// and next queries read every task in the project, so private tasks leaked (H02, J02).
scoped.invalid(
  "catches a page whose record queries skip the viewer it was given",
  `export const projectPage = Effect.fn("KinCrm.projectPage")(function* (
    row: RecordRow, now: number, seq: number, viewer: KinViewer,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const inProject = sql\`r.org_id = \${row.orgId} AND r.register_id = 'work'
      AND r.project_id = \${row.recordId}\`;
    const [counts] = yield* sql\`SELECT SUM(r.state = 'open') AS open
      FROM kin_records r WHERE \${inProject}\`;
    const milestones = yield* milestonesOf(row.orgId, row.recordId, now, viewer);
    return { counts, milestones };
  });`,
  (output) => assert.include(output, "ignores the viewer"),
);
scoped.valid(
  "accepts queries that carry the viewer through fragments and rows read with it",
  `export const projectPage = Effect.fn("KinCrm.projectPage")(function* (
    row: RecordRow, now: number, viewer: KinViewer,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const inProject = sql\`r.org_id = \${row.orgId} AND \${seenBy(sql, viewer)}\`;
    const since = yield* sql\`SELECT r.record_id FROM kin_records r WHERE \${inProject}\`;
    const rows = yield* sql\`\${selectRecords(sql)} WHERE r.record_id IN \${sql.in(since.map((one) => one.recordId))}\`;
    return rows;
  });`,
);
scoped.invalid(
  "treats a selectRecords helper as a record read",
  `const one = Effect.fn("x")(function* (viewer: KinViewer, id: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql\`\${selectRecords(sql)} WHERE r.record_id = \${id}\`;
  });`,
);

const readModel = createOxlintRuleHarness("t3code/kin-viewer-scoped-reads", {
  filename: "fixture.ts",
  ruleOptions: [{ readModel: true }],
});
// The page before H02's fix: no viewer at all, so ownerClients.project served a lead every task
// in the project, private or not (H02).
readModel.invalid(
  "catches an exported page read with no viewer",
  `export const projectPage = Effect.fn("KinCrm.projectPage")(function* (
    row: RecordRow, now: number, seq: number,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const inProject = sql\`r.org_id = \${row.orgId} AND r.project_id = \${row.recordId}\`;
    return yield* sql\`SELECT SUM(r.state = 'open') AS open FROM kin_records r WHERE \${inProject}\`;
  });`,
  (output) => assert.include(output, "without a viewer"),
);
readModel.valid(
  "allows an owner-level read named as one",
  `export const ownerLevelHistory = Effect.fn("KinCrm.history")(function* (row: RecordRow) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql\`SELECT * FROM kin_records r WHERE r.record_id = \${row.recordId}\`;
  });`,
);
readModel.valid(
  "ignores exports that read no records",
  "export const pullNumber = (url: string) => Number.parseInt(url, 10);",
);

const transport = createOxlintRuleHarness("t3code/kin-viewer-scoped-reads", {
  filename: "fixture.ts",
  ruleOptions: [{ transport: true }],
});
transport.invalid(
  "keeps record SQL out of RPC handlers and agent tools",
  "const rows = sql`SELECT * FROM kin_records r WHERE r.org_id = ${orgId}`;",
  (output) => assert.include(output, "don't query records"),
);
transport.valid(
  "allows other SQL in a transport",
  "const rows = sql`SELECT * FROM kin_people p WHERE p.org_id = ${orgId}`;",
);

scoped.invalid(
  "holds a function that resolves its own viewer to it",
  `export const summary = Effect.fn("KinWork.summary")(function* (people: ReadonlyArray<PersonIdentity>, orgId: KinOrgId) {
    const viewer = yield* viewerOf(people, orgId);
    const sql = yield* SqlClient.SqlClient;
    return yield* sql\`SELECT COUNT(*) FROM kin_records r WHERE r.org_id = \${orgId}\`;
  });`,
);
scoped.valid(
  "treats an owner-gated function as an owner-level read",
  `export const updateList = Effect.fn("KinMoney.updateList")(function* (people: ReadonlyArray<PersonIdentity>, orgId: KinOrgId) {
    const viewer = yield* viewerOf(people, orgId);
    yield* theOwner(people, orgId);
    const sql = yield* SqlClient.SqlClient;
    return yield* sql\`SELECT COUNT(*) FROM kin_records r WHERE r.org_id = \${orgId}\`;
  });`,
);
scoped.invalid(
  "refuses an optional view list",
  "const dates = (orgId: KinOrgId, view?: ReadonlyArray<KinPersonId>) => orgId;",
);

// runLog as it was: touch_log runs in teammates' turns, resolved a guessed client
// key and read its title with no viewer, so a hidden client's name came back in a shared chat.
scoped.invalid(
  "catches an agent tool body that reads records with no viewer",
  `const runLog = Effect.fnUntraced(function* (lead: Lead, input: typeof TouchInput.Type) {
    const partyId = yield* refOrNull(lead, input.client, "clients");
    const sql = yield* SqlClient.SqlClient;
    const [client] = yield* sql\`SELECT key, title FROM kin_records
      WHERE org_id = \${lead.orgId} AND record_id = \${partyId!} ORDER BY key\`;
    return { client: \`\${client!.title} (\${client!.key})\` };
  });
  export const logTouch = leadTool("KinClientTools.logTouch", runLog);`,
  (output) => assert.include(output, "teammates read its turns"),
);
scoped.valid(
  "accepts an agent tool that resolves through the turn's viewer or is gated to the owner",
  `const runLog = Effect.fnUntraced(function* (lead: Lead, input: typeof TouchInput.Type) {
    const client = yield* refRecord(lead, input.client, "clients");
    return { client: \`\${client.name} (\${client.key})\` };
  });
  export const logTouch = leadTool("KinClientTools.logTouch", runLog);
  export const rows = leadTool("KinStatementTools.rows", function* (lead: Lead) {
    yield* ownerTurn(lead);
    const sql = yield* SqlClient.SqlClient;
    return yield* sql\`SELECT * FROM kin_records r WHERE r.org_id = \${lead.orgId}\`;
  });`,
);
