import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  AuthKinTasksScope,
  AuthSessionId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRpcs,
  kinRpcAccess,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { authorizeRpc } from "../auth/RpcAuthorization.ts";
import { layerKinAuthTest } from "./auth/ProofKeySessions.testkit.ts";
import { KinIdentity } from "./chat/KinIdentity.ts";
import type { Services } from "./KinServer.ts";
import { admits, forPerson } from "./rpcHandlers.ts";
import { countryFirstMessage } from "./work/companyProfile.ts";

const orgId = KinOrgId.make("kin-default");
const owner = { _tag: "person" as const, orgId, personId: KinPersonId.make("kin-default-owner") };
const session = (person: string): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(person),
  subject: person,
  method: "browser-session-cookie",
  scopes: [AuthKinChatScope],
});

// What a member reaches: their own chats and one with any teammate, Work shared with them and what needs them in it, their
// phone and their GitHub login, and the Clients, Docs and Money reads, where the service shows
// them only their places.
const MEMBER = [
  "kin.access.me",
  // Their own briefs; the service shows and changes only the ones they receive.
  "kin.briefs.list",
  "kin.briefs.save",
  "kin.chat.history",
  "kin.chat.members",
  "kin.chat.subscribe",
  "kin.chats.clear",
  "kin.chats.createDirect",
  "kin.chats.mute",
  "kin.chats.subscribe",
  "kin.chats.withPerson",
  "kin.docs.diff",
  // A hand edit: `Docs.editSectionByHand` refuses all but the owner level and the doc's project
  // lead, and keeps playbooks and What we sell to the owner level.
  "kin.docs.editSection",
  "kin.docs.get",
  "kin.docs.history",
  "kin.docs.list",
  "kin.docs.subscribe",
  "kin.goals.list",
  "kin.leads.list",
  "kin.messages.markRead",
  "kin.messages.react",
  "kin.messages.send",
  "kin.open.read",
  "kin.open.subscribe",
  "kin.org.get",
  "kin.orgs.list",
  "kin.people.linkDevice",
  "kin.people.list",
  "kin.people.listDevices",
  "kin.people.profiles",
  "kin.people.revokeDevice",
  "kin.people.setGithubLogin",
  "kin.people.updateProfile",
  // Set aside: the service makes a member's hold their own, seen and lifted by them alone.
  "kin.pulse.aside",
  "kin.pulse.handle",
  "kin.pulse.read",
  "kin.pulse.subscribe",
  "kin.push.registerDevice",
  "kin.push.unregisterDevice",
  "kin.push.watch",
  "kin.refreshes.subscribe",
  "kin.search",
  "kin.tasksKeys.issue",
  "kin.tasksKeys.list",
  "kin.tasksKeys.revoke",
  "kin.triggers.getTimeZone",
  "kin.widgets.act",
  "kin.work.assign",
  "kin.work.comment",
  "kin.work.commentRemove",
  "kin.work.comments",
  // Marketing's reads: `ownerMarketing.ts` shows what they see in Clients and refuses Clients off.
  "kin.work.contactList",
  "kin.work.create",
  // The light CRM's: the gate lets a person through, and `ownerClients.ts` decides the rest.
  "kin.work.createContact",
  // Deals': the gate lets a person through, and `deals.ts` decides the rest (Clients on, `crmSees`).
  "kin.work.createDeal",
  "kin.work.createParty",
  "kin.work.dates",
  "kin.work.deal",
  "kin.work.dealStages",
  "kin.work.dealStep",
  "kin.work.deals",
  "kin.work.exportContacts",
  "kin.work.get",
  "kin.work.handBack",
  "kin.work.handOver",
  "kin.work.history",
  "kin.work.linkAdd",
  "kin.work.linkRemove",
  "kin.work.list",
  "kin.work.lists",
  "kin.work.logTouch",
  "kin.work.marketing",
  "kin.work.money",
  "kin.work.moveDeal",
  "kin.work.nudge",
  "kin.work.parties",
  "kin.work.party",
  "kin.work.project",
  "kin.work.projectPeople",
  "kin.work.projects",
  "kin.work.removeTouch",
  "kin.work.subscribe",
  "kin.work.summary",
  "kin.work.update",
  "kin.work.updateContact",
  "kin.work.updateDeal",
  "kin.work.updateParty",
];

it.layer(layerKinAuthTest("kin-rpc-access-"))("KIN_RPC_ACCESS", (it) => {
  it.effect(
    "lets the owner do everything, a co-owner all but change kinds, a member only their own, read per call",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', '2026-11-15T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
          VALUES ('kin-default-owner', ${orgId}, 'asha', 'Asha', '2026-11-15T00:00:00.000Z', 'owner'),
            ('ravi', ${orgId}, 'ravi', 'Ravi', '2026-11-15T00:00:00.000Z', 'co_owner'),
            ('meera', ${orgId}, 'meera', 'Meera', '2026-11-15T00:00:00.000Z', 'member')`;
        const identity = {
          owner,
          resolve: (held: AuthenticatedSession) =>
            Effect.succeed([{ ...owner, personId: KinPersonId.make(held.subject) }]),
        } as unknown as KinIdentity["Service"];
        // The gate reads only the identity and the database.
        const services = Option.some(
          Context.make(KinIdentity, identity).pipe(
            Context.add(SqlClient.SqlClient, sql),
          ) as unknown as Context.Context<Services>,
        );
        const allowed = (person: string, method: string) =>
          admits(session(person), services, kinRpcAccess(method)).pipe(
            Effect.as(true),
            Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
          );
        const methods = KinRpcs.map((rpc) => rpc._tag).toSorted();
        const table = { owner: [] as string[], coOwner: [] as string[], member: [] as string[] };
        for (const method of methods) {
          if (yield* allowed("kin-default-owner", method)) table.owner.push(method);
          if (yield* allowed("ravi", method)) table.coOwner.push(method);
          if (yield* allowed("meera", method)) table.member.push(method);
        }
        assert.deepStrictEqual(table.owner, methods);
        assert.deepStrictEqual(
          methods.filter((method) => !table.coOwner.includes(method)),
          [
            "kin.people.setAccess",
            "kin.people.setOwnerName",
            // What Kin suggested to the owner, and his answers: his alone.
            "kin.recommendations.askAgain",
            "kin.recommendations.list",
            "kin.refreshes.announce",
            // Download everything is the owner's alone.
            "kin.work.exportLink",
          ],
        );
        assert.deepStrictEqual(table.member, MEMBER);
        // Every method is in the table, so a new one can't slip past the gate unlisted.
        assert.deepStrictEqual(
          methods.filter((method) => kinRpcAccess(method) === undefined),
          [],
        );

        // Kinds are stored data: a demotion holds from the very next call, a promotion likewise.
        yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'ravi'`;
        assert.isFalse(yield* allowed("ravi", "kin.work.recordPayment"));
        // Sending a mail with one's own edits is a Confirm: whoever may confirm, as they stand now.
        // Keeping them on the card unsent is for the same people.
        assert.isFalse(yield* allowed("ravi", "kin.connections.sendEdited"));
        assert.isFalse(yield* allowed("ravi", "kin.connections.saveEdited"));
        yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE person_id = 'meera'`;
        assert.isTrue(yield* allowed("meera", "kin.work.recordPayment"));
        assert.isTrue(yield* allowed("meera", "kin.connections.sendEdited"));
        assert.isTrue(yield* allowed("meera", "kin.connections.saveEdited"));
        // Someone the org doesn't know is refused, not admitted as a member of nothing.
        assert.isFalse(yield* allowed("stranger", "kin.work.recordPayment"));
        // Team memory is the owner's call: a co-owner (now Meera) may set it, a member never.
        assert.isTrue(yield* allowed("meera", "kin.memory.setTeamMemory"));
        assert.isFalse(yield* allowed("ravi", "kin.memory.setTeamMemory"));
        // Who may not message whom is set by owners and co-owners alone.
        for (const method of ["kin.reach.list", "kin.reach.set"]) {
          assert.isTrue(yield* allowed("meera", method));
          assert.isFalse(yield* allowed("ravi", method));
          assert.isFalse(yield* allowed("stranger", method));
        }

        // The country refusal reaches a person with no name in it (an older phone hides names),
        // worded for who may choose the country now; any other refusal is as it was.
        const said = (person: string, message: string) =>
          forPerson(
            session(person),
            services,
          )(new KinChatError({ reason: "invalid_state", message })).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        const named = countryFirstMessage("Jamie McKay");
        assert.deepStrictEqual(
          [
            yield* said("kin-default-owner", named),
            yield* said("meera", named),
            yield* said("ravi", named),
          ],
          [
            "Nothing was saved: choose your company's country first, in Settings, Company details.",
            "Nothing was saved: choose your company's country first, in Settings, Company details.",
            "Nothing was saved: an owner needs to choose the company's country first.",
          ],
        );
        assert.strictEqual(
          yield* said("ravi", "No entry INV-9 in Work."),
          "No entry INV-9 in Work.",
        );
      }),
  );
});

it.effect("a coding agent key reaches no RPC: every method T3 and Kin serve refuses it", () =>
  Effect.gen(function* () {
    const admitted: Array<string> = [];
    for (const method of WsRpcGroup.requests.keys()) {
      // A payload that doesn't decode is refused too: only a clean pass counts as reached.
      const result = yield* Effect.suspend(() =>
        authorizeRpc([AuthKinTasksScope], method, {}),
      ).pipe(Effect.exit);
      if (result._tag === "Success") admitted.push(method);
    }
    assert.isAbove(WsRpcGroup.requests.size, KinRpcs.length);
    assert.deepStrictEqual(admitted, []);
  }),
);
