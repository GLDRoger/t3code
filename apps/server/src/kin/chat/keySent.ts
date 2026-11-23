/**
 * Words a person's coding agent sent through its key (`tasksKey/chat.ts`). The send's client id
 * starts `key:`, and the repository stores it as `send:key:…` (`storedClientId`). Whatever decides
 * that a person said, asked, answered or approved something themselves reads this, and only this.
 */
export const KEY_SENT = "key:";
/** How the repository stores a key's send id (`KinChatRepository.storedClientId("send", …)`). */
export const KEY_SENT_STORED = `send:${KEY_SENT}`;

/** Whether a stored request or origin id carries a key's request id (`…key:<session>:…`). */
export const isKeyRequest = (stored: string) =>
  stored.startsWith(KEY_SENT) || stored.includes(`:${KEY_SENT}`) || stored.includes(`"${KEY_SENT}`);
/** SQL over a trusted column name, for `sql.literal`: that row was written through a key. */
export const keyRequestSql = (column: string) =>
  `(substr(${column}, 1, ${KEY_SENT.length}) = '${KEY_SENT}' OR instr(${column}, ':${KEY_SENT}') > 0
    OR instr(${column}, '"${KEY_SENT}') > 0)`;

/** The client id a key's send carries: one per key and request. */
export const keySentClientId = (sessionId: string, request: string) =>
  `${KEY_SENT}${sessionId}:${request}`;

/** Whether a stored client id is a key's send. */
export const isKeySent = (stored: string | null | undefined) =>
  stored?.startsWith(KEY_SENT_STORED) === true;

/** SQL over a trusted column name, for `sql.literal`: that message was sent through a key. */
export const keySentSql = (column: string) =>
  `(substr(COALESCE(${column}, ''), 1, ${KEY_SENT_STORED.length}) = '${KEY_SENT_STORED}')`;

/**
 * SQL over a trusted alias, for `sql.literal`: wake event `e` carries what a key did, its message
 * or a task change or comment written through it (`coding_agent_key`).
 */
export const keyEventSql = (e: string) =>
  `(EXISTS (SELECT 1 FROM kin_messages km WHERE km.org_id = ${e}.org_id
      AND km.message_id = json_extract(${e}.json, '$.messageId')
      AND ${keySentSql("km.client_message_id")})
    OR (${e}.tag = 'record.changed' AND json_extract(${e}.json, '$.reason') IS NOT 'commented'
      AND EXISTS (SELECT 1 FROM kin_record_changes kc WHERE kc.org_id = ${e}.org_id
        AND kc.record_id = json_extract(${e}.json, '$.recordId')
        AND kc.seq = json_extract(${e}.json, '$.seq') AND kc.coding_agent_key IS NOT NULL))
    OR (${e}.tag = 'record.changed' AND json_extract(${e}.json, '$.reason') = 'commented'
      AND EXISTS (SELECT 1 FROM kin_record_comments kk WHERE kk.org_id = ${e}.org_id
        AND kk.record_id = json_extract(${e}.json, '$.recordId')
        AND kk.seq = json_extract(${e}.json, '$.seq') AND kk.coding_agent_key IS NOT NULL)))`;
