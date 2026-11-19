// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fake mail, moved dates and reads for a dev instance.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { database, sqlite } from "./actors.ts";
import { type Instance, ROOT } from "./instance.ts";
import { VerifyError } from "./rpc.ts";

const mailbox = (instance: Instance) => NodePath.join(instance.userdata, "kin-fake-mail.json");

/** The dev server's fake mailbox, through the repo's own `kin-fake-mail.ts`. */
function fakeMail(instance: Instance, args: ReadonlyArray<string>): string {
  const out = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(ROOT, "apps", "server", "scripts", "kin-fake-mail.ts"),
      mailbox(instance),
      ...args,
    ],
    { cwd: NodePath.join(ROOT, "apps", "server"), encoding: "utf8" },
  );
  if (out.status !== 0)
    throw new VerifyError(out.stderr.trim().split("\n").at(-1) ?? "fake mail failed");
  return out.stdout;
}

/** The dev server's fake Zernio, through the repo's own `kin-fake-social.ts`. */
export function fakeSocial(instance: Instance, args: ReadonlyArray<string>): string {
  const out = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(ROOT, "apps", "server", "scripts", "kin-fake-social.ts"),
      NodePath.join(instance.userdata, "kin-fake-social.json"),
      ...args,
    ],
    { cwd: NodePath.join(ROOT, "apps", "server"), encoding: "utf8" },
  );
  if (out.status !== 0)
    throw new VerifyError(out.stderr.trim().split("\n").at(-1) ?? "fake social failed");
  return out.stdout.trimEnd();
}

export interface SentMail {
  readonly messageId: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: ReadonlyArray<string> | string;
  readonly subject: string;
  readonly inReplyTo?: string | null;
  readonly attachments?: ReadonlyArray<string>;
}

export const mailSent = (instance: Instance) =>
  JSON.parse(fakeMail(instance, ["sent"])) as Array<SentMail>;

export function mailSentLines(instance: Instance): string {
  const sent = mailSent(instance);
  return [
    `${sent.length} sent`,
    ...sent.map((mail) =>
      [
        mail.messageId,
        mail.threadId,
        `from ${mail.from}`,
        `to ${[mail.to].flat().join(",")}`,
        JSON.stringify(mail.subject),
        mail.inReplyTo == null ? "" : `inReplyTo ${mail.inReplyTo}`,
        (mail.attachments ?? []).length > 0 ? `files ${(mail.attachments ?? []).join(",")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ].join("\n");
}

export const mailDeliver = (instance: Instance, args: ReadonlyArray<string>) =>
  fakeMail(instance, ["deliver", ...args]).trim();

export const mailExpire = (instance: Instance, args: ReadonlyArray<string>) =>
  fakeMail(instance, ["expire", ...args.filter((arg) => arg !== "expire")]).trim();

/** The fake vendor's half of a sign-in: a working grant, and the page Kin's sign-in returns to. */
export function mailApprove(instance: Instance, authorizationUrl: string, address: string) {
  if (!NodeFS.existsSync(mailbox(instance)))
    throw new VerifyError(
      "this instance has no fake mailbox (KIN_DEV_FAKE_MAIL), so no sign-in here",
    );
  return fakeMail(instance, ["approve", authorizationUrl, address]).trim();
}

/** "3d", "12h", "90m", "2w" to milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)\s*(m|h|d|w)$/.exec(text.trim());
  if (match === null) throw new VerifyError(`duration "${text}": use 90m, 12h, 3d or 2w`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    match[2] as "m" | "h" | "d" | "w"
  ];
  return Number(match[1]) * unit;
}

const TIME_COLUMN = /(_at|_on|^at|due|until|not_before|expires|_day|^at_ms)$/i;

/**
 * "Time passes": every stored Kin time moves `ms` into the past, which is what the runs did by
 * hand. The server clock is untouched, so run it with the server stopped and start it again.
 */
export function shiftKinTimes(instance: Instance, ms: number): { columns: number; rows: number } {
  const db = new (sqlite().DatabaseSync)(NodePath.join(instance.userdata, "statev2.sqlite"));
  let columns = 0;
  let rows = 0;
  try {
    const seconds = Math.round(ms / 1000);
    const days = Math.floor(ms / 86_400_000);
    db.exec("BEGIN IMMEDIATE");
    // Append-only guards (a rendered figure, an audit row) refuse any update; time moves under
    // them too, so they step aside for this transaction and come back exactly as they were.
    const guards = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'kin\\_%' ESCAPE '\\' AND sql LIKE '%RAISE(ABORT%'",
      )
      .all() as Array<{ name: string; sql: string }>;
    for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kin\\_%' ESCAPE '\\' AND sql NOT LIKE '%VIRTUAL%' AND name NOT LIKE 'kin_search%' AND name NOT LIKE 'kin_audit%'",
      )
      .all() as Array<{ name: string }>;
    // Append-only tables refuse any update; their stamps are history, so they stay put.
    const frozen = new Set(
      (
        db
          .prepare(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%BEFORE UPDATE%' AND sql LIKE '%RAISE(ABORT%'",
          )
          .all() as Array<{ tbl_name: string }>
      ).map((row) => row.tbl_name),
    );
    for (const { name } of tables.filter((table) => !frozen.has(table.name))) {
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
        name: string;
        type: string;
      }>;
      for (const col of cols.filter((one) => TIME_COLUMN.test(one.name))) {
        columns++;
        const c = `"${col.name}"`;
        rows += Number(
          db
            .prepare(
              `UPDATE "${name}" SET ${c} = ${c} - ? WHERE typeof(${c}) = 'integer' AND ${c} > 1000000000000`,
            )
            .run(ms).changes,
        );
        rows += Number(
          db
            .prepare(
              `UPDATE "${name}" SET ${c} = strftime('%Y-%m-%dT%H:%M:%fZ', ${c}, ?) WHERE typeof(${c}) = 'text' AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'`,
            )
            .run(`-${seconds} seconds`).changes,
        );
        if (days > 0)
          rows += Number(
            db
              .prepare(
                `UPDATE "${name}" SET ${c} = date(${c}, ?) WHERE typeof(${c}) = 'text' AND length(${c}) = 10 AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
              )
              .run(`-${days} days`).changes,
          );
      }
    }
    for (const guard of guards) db.exec(guard.sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return { columns, rows };
}

/** A read-only query on this instance's database, as tab-separated rows (at most 200). */
export function query(instance: Instance, sql: string): string {
  const db = database(instance);
  try {
    const statement = db.prepare(sql);
    const rows = statement.all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return "(no rows)";
    const header = Object.keys(rows[0]!);
    const cell = (value: unknown) =>
      value === null ? "∅" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return [
      header.join("\t"),
      ...rows
        .slice(0, 200)
        .map((row) => header.map((key) => cell(row[key]).replace(/\s+/g, " ")).join("\t")),
      ...(rows.length > 200 ? [`… ${rows.length - 200} more rows`] : []),
    ].join("\n");
  } catch (error) {
    throw new VerifyError(`db: ${(error as Error).message}`);
  } finally {
    db.close();
  }
}

interface CapturedPush {
  readonly at: number;
  readonly token: string;
  readonly collapseId?: string;
  readonly payload: {
    readonly aps: {
      readonly alert?: { readonly title: string; readonly body: string };
      readonly badge?: number;
      readonly "thread-id"?: string;
      readonly "content-available"?: number;
    };
    readonly body?: { readonly cleared?: boolean };
  };
}

/** What the dev server's push capture (`KIN_DEV_PUSH_CAPTURE`) would have sent, by person. */
export function pushSentLines(instance: Instance): string {
  const file = NodePath.join(instance.userdata, "kin-push-capture.jsonl");
  const sent = NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedPush)
    : [];
  const db = database(instance);
  const owners = new Map(
    (
      db
        .prepare(
          `SELECT d.token, p.handle FROM kin_push_devices d
           JOIN kin_people p ON p.org_id = d.org_id AND p.person_id = d.person_id`,
        )
        .all() as Array<{ token: string; handle: string }>
    ).map((row) => [row.token, row.handle]),
  );
  db.close();
  return [
    `${sent.length} sent`,
    ...sent.map((push) => {
      const { aps } = push.payload;
      return [
        `${owners.get(push.token) ?? "?"}/${push.token.slice(0, 6)}`,
        `badge ${aps.badge ?? "-"}`,
        aps.alert === undefined
          ? "silent"
          : JSON.stringify(`${aps.alert.title}: ${aps.alert.body}`),
        aps["thread-id"] === undefined ? "" : `thread ${aps["thread-id"]}`,
        push.collapseId === undefined ? "" : `collapse ${push.collapseId}`,
        aps["content-available"] === 1 ? "wakes app" : "",
        push.payload.body?.cleared === true ? "chat cleared" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }),
  ].join("\n");
}
