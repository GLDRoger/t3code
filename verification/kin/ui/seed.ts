// Seeds an invented company into a running Kin dev server, as its owner, and prints one session
// cookie per role. Run from apps/server: node ../../verification/kin/ui/seed.ts <baseDir> <origin>
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const [baseDir, origin] = process.argv.slice(2);
if (!baseDir || !origin) throw new Error("usage: seed.ts <baseDir> <origin>");
const serverDir = NodePath.resolve(import.meta.dirname, "../../../apps/server");
const fromServer = NodeModule.createRequire(NodePath.join(serverDir, "package.json"));
const load = (specifier: string) =>
  import(NodeURL.pathToFileURL(fromServer.resolve(specifier)).href);
const local = (file: string) => import(NodeURL.pathToFileURL(NodePath.join(serverDir, file)).href);

const Effect = await load("effect/Effect");
const Option = await load("effect/Option");
const Layer = await load("effect/Layer");
const NodeServices = await load("@effect/platform-node/NodeServices");
const NodeCrypto = await load("@effect/platform-node/NodeCrypto");
const NetService = await local("../../packages/shared/src/Net.ts");
const { RpcGroup } = await load("effect/rpc");
const { KinRpcs } = await local("../../packages/contracts/src/kinRpcs.ts");
const { openRemote, remoteLayer } = await local("src/kin/cli/openRemote.ts");
const { resolveCliAuthConfig } = await local("src/cli/config.ts");

const org = "kin-default";
let n = 0;
const rid = () => `uifuzz-${n++}`;
const dayAt = (day: string) => `${day}T12:00:00.000Z`;

// Roles the fuzzer walks as. `places` are the dock places a member is given.
const PEOPLE = [
  { role: "coowner", name: "Arjun Mehta", access: "co_owner" },
  { role: "lead", name: "Dev Iyer", access: "member", places: { clients: true, docs: true } },
  { role: "member", name: "Zoya Sheikh", access: "member", places: { clients: false, docs: true } },
  { role: "member2", name: "Kabir Rao", access: "member", places: { clients: true, docs: true } },
] as const;

const program = Effect.gen(function* () {
  const client = yield* openRemote(
    origin,
    RpcGroup.make(...KinRpcs),
    "Kin UI fuzz seed",
    new Error(`No Kin at ${origin}`),
  );
  const call = (method: string, payload: object) =>
    Effect.suspend(() => client[method]({ orgId: org, ...payload })).pipe(
      Effect.tapDefect(() =>
        Effect.sync(() => console.error(`seed failed at ${method} ${JSON.stringify(payload)}`)),
      ),
      Effect.mapError((e: unknown) => new Error(`${method}: ${JSON.stringify(e)}`)),
    );

  yield* call("kin.people.setOwnerName", { displayName: "Rhea Kapoor" });
  const people: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  for (const p of PEOPLE) {
    const invite = yield* call("kin.people.createInvite", { displayName: p.name });
    const res = yield* Effect.promise(() =>
      fetch(new URL("/kin/invites/accept", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: invite.secret, label: `uifuzz ${p.role}` }),
      }).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`accept ${p.name}: ${r.status}`)),
      ),
    );
    people[p.role] = res.person.personId;
    cookies[p.role] = res.accessToken;
    if (p.access === "co_owner")
      yield* call("kin.people.setAccess", { personId: res.person.personId, access: "co_owner" });
    if ("places" in p)
      yield* call("kin.people.setPlaces", { personId: res.person.personId, ...p.places });
  }
  const person = (role: string) => ({ _tag: "person", personId: people[role] });

  // Dev leads the Lumen Grove project; Zoya and Kabir are on it.
  const p1 = yield* call("kin.work.project", { key: "P-1" });
  yield* call("kin.work.updateProject", {
    key: "P-1",
    rev: p1.project.rev,
    owner: person("lead"),
    members: [person("member"), person("member2")],
    value: { minor: 41877700, currency: "INR" },
  });

  const holders: Record<string, string> = {
    "W-1": "member",
    "W-2": "member",
    "W-3": "member2",
    "W-4": "lead",
    "W-5": "lead",
  };
  for (const [key, role] of Object.entries(holders))
    yield* call("kin.work.assign", { key, to: person(role) });
  yield* call("kin.work.share", { keys: ["W-1", "W-2", "W-3", "W-4", "W-5", "W-6"], shared: true });

  for (const [title, day] of [
    ["Booking flow ready", "2026-11-30"],
    ["Pilot clinics live", "2027-01-15"],
  ] as const)
    yield* call("kin.work.create", {
      list: "milestones",
      project: "P-1",
      title,
      dueAt: dayAt(day),
      dueAllDay: true,
      clientRequestId: rid(),
    });

  // The owner's private entries carry canary titles so a leak shows up as text.
  const priv = yield* call("kin.work.create", {
    title: "CANARY-PRIVATE-TASK pilot pricing for Lumen",
    project: "P-1",
    dueAt: dayAt("2026-11-24"),
    dueAllDay: true,
    clientRequestId: rid(),
  });
  yield* call("kin.work.update", { key: priv.key, rev: priv.rev, sensitive: true });
  const priv2 = yield* call("kin.work.create", {
    title: "CANARY-PRIVATE-NOTE Kabir appraisal",
    clientRequestId: rid(),
  });
  yield* call("kin.work.update", { key: priv2.key, rev: priv2.rev, sensitive: true });

  yield* call("kin.work.createContact", {
    party: "C-2",
    name: "Anita Desai",
    role: "Accounts",
    email: "canary.anita@orbit-dental.example",
    phone: "+91 98450 73194",
    clientRequestId: rid(),
  });
  return { people, cookies };
});

const runtime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);
const config = await Effect.runPromise(
  resolveCliAuthConfig({ baseDir: Option.some(baseDir), devUrl: Option.none() }, Option.none(), {
    quietLogs: true,
  }).pipe(Effect.provide(runtime)),
);
const result = await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(remoteLayer(config)),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  ),
);
process.stdout.write(JSON.stringify(result) + "\n");
