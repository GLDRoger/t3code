import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { KinWorkerHost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/**
 * The hosts one worker's shell may reach, written by the server under its state directory before
 * the worker starts, and the hosts its commands were refused. The provider layer that starts the
 * session has no database, so these files carry the owner's list across; a child can't read them.
 */
const HostList = Schema.fromJsonString(Schema.Array(KinWorkerHost));
const decodeHosts = Schema.decodeEffect(HostList);
const encodeHosts = Schema.encodeEffect(HostList);
const isHost = Schema.is(KinWorkerHost);

const directory = (stateDir: string) => `${stateDir}/kin/work-network`;
// Worker ids are Kin's own `wk-<hash>`; anything else gets no file and so no network.
const safeId = (workerId: string) => /^[A-Za-z0-9_-]{1,80}$/.test(workerId);
const grantFile = (stateDir: string, workerId: string) => `${directory(stateDir)}/${workerId}.json`;
const blockedFile = (stateDir: string, workerId: string) =>
  `${directory(stateDir)}/${workerId}.blocked.json`;

const read = Effect.fn("KinWorkNetwork.read")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeHosts));
  },
  Effect.orElseSucceed((): ReadonlyArray<string> => []),
);

const write = Effect.fn("KinWorkNetwork.write")(function* (
  stateDir: string,
  file: string,
  hosts: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory(stateDir), { recursive: true });
  yield* fs.writeFileString(file, yield* encodeHosts(hosts));
});

export const grantHosts = (stateDir: string, workerId: string, hosts: ReadonlyArray<string>) =>
  safeId(workerId) ? write(stateDir, grantFile(stateDir, workerId), hosts) : Effect.void;

/** What the server granted this worker; a missing or unreadable file grants nothing. */
export const grantedHosts = (stateDir: string, workerId: string) =>
  safeId(workerId) ? read(grantFile(stateDir, workerId)) : Effect.succeed([]);

const blockedHosts = (stateDir: string, workerId: string) =>
  safeId(workerId) ? read(blockedFile(stateDir, workerId)) : Effect.succeed([]);

export const noteBlocked = Effect.fn("KinWorkNetwork.noteBlocked")(
  function* (stateDir: string, workerId: string, hosts: ReadonlyArray<string>) {
    if (!safeId(workerId) || hosts.length === 0) return;
    const known = yield* blockedHosts(stateDir, workerId);
    const added = hosts.filter((host) => !known.includes(host));
    // A cap so a command that tries thousands of hosts can't grow the report without bound.
    if (added.length > 0 && known.length < 20)
      yield* write(stateDir, blockedFile(stateDir, workerId), [...known, ...added].slice(0, 20));
  },
  Effect.ignoreCause({ log: true }),
);

/** The hosts refused since the last report, cleared so the next report names only new ones. */
export const takeBlocked = Effect.fn("KinWorkNetwork.takeBlocked")(function* (
  stateDir: string,
  workerId: string,
) {
  const hosts = yield* blockedHosts(stateDir, workerId);
  if (hosts.length === 0) return hosts;
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(blockedFile(stateDir, workerId), { force: true })
    .pipe(Effect.ignoreCause({ log: true }));
  return hosts;
});

// Claude Code's own report of a refused connection, which it hands the model with the result.
const violation = /deny network-outbound ([^\s:]+):\d+/g;

/** The hosts a tool result says the sandbox's network rule refused. */
export const refusedHosts = (message: SDKMessage): ReadonlyArray<string> => {
  if (message.type !== "user") return [];
  const content = message.message.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const hosts = [...text.matchAll(violation)].map((match) => match[1]!.toLowerCase());
  return [...new Set(hosts.filter(isHost))];
};
