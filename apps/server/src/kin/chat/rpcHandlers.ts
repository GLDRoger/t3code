import { sessionUploadOwner } from "../../assets/AttachmentUpload.ts";
import { KinChatAndBudgetRpcs, KinChatError, type KinLeadRetireInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinServer } from "../KinServer.ts";
import { KinBudget } from "../lead/KinBudget.ts";
import * as LeadProvision from "../lead/KinLeadProvision.ts";
import {
  ownerLevelAgentPage,
  ownerLevelSetCharacter,
  ownerLevelUndoChange,
} from "../lead/agentPage.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { seedCharacters } from "../lead/characters.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KinStop } from "../lead/KinStop.ts";
import { KinOwnerTimeZone } from "../triggers/ownerTimeZone.ts";
import { KinIdentity, type PersonIdentity } from "./KinIdentity.ts";
import { KinChatService } from "./KinChatService.ts";
import { KinGroups, companyChatOf } from "./KinGroups.ts";
import { KinVisualHosts } from "./KinVisualHosts.ts";

const rpcs = RpcGroup.make(...KinChatAndBudgetRpcs);
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const isKinChatError = Schema.is(KinChatError);
/** Open chats per connection: an owner keeps a few dozen open at most; this is several times that. */
export const KIN_OPEN_CHATS_PER_CONNECTION = 200;
const tooManyChats = new KinChatError({
  reason: "limit",
  message: "Too many chats are open on this device. Close some and try again.",
});
const leadRefusal = Schema.is(LeadProvision.KinLeadProvisionError);
const leadReasons = {
  not_owner: "not_allowed",
  unknown_project: "invalid_state",
  no_models: "no_models",
  not_claude: "invalid_state",
  not_found: "not_found",
  retired: "not_found",
  conflict: "conflict",
  last_agent: "invalid_state",
} as const satisfies Record<LeadProvision.KinLeadProvisionError["reason"], KinChatError["reason"]>;
export const toLeadError = (error: unknown) =>
  leadRefusal(error)
    ? new KinChatError({ reason: leadReasons[error.reason], message: error.message })
    : error;
const mapError = (error: unknown) => (isKinChatError(error) ? error : unavailable);
const logInfra = (error: unknown) =>
  isKinChatError(error) ? Effect.void : Effect.logWarning("Kin RPC failed.", error);
const defect = (cause: unknown) =>
  Effect.logWarning("Kin RPC defect.", cause).pipe(Effect.andThen(Effect.fail(unavailable)));

export const makeKinChatHandlers = Effect.fn("makeKinChatHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  // The host's settings name each model's provider driver; Kin's own layers don't carry them.
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  // What checks or reads an agent's model: the host's settings, and its providers when known.
  const withHostModels = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isNone(settings)
      ? Effect.fail(unavailable)
      : effect.pipe(
          Effect.provideService(ServerSettingsService, settings.value),
          Option.isSome(providerRegistry)
            ? Effect.provideService(ProviderRegistry, providerRegistry.value)
            : (self) => self,
        );
  const services = Effect.gen(function* () {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    return {
      identity: Context.get(kin.value.services.value, KinIdentity),
      budget: Context.get(kin.value.services.value, KinBudget),
      stop: Context.get(kin.value.services.value, KinStop),
      timeZone: Context.get(kin.value.services.value, KinOwnerTimeZone),
      chat: Context.get(kin.value.services.value, KinChatService),
      groups: Context.get(kin.value.services.value, KinGroups),
      visualHosts: Context.get(kin.value.services.value, KinVisualHosts),
    };
  });
  // Every group method: who the session is, then the one service call that decides.
  const group = <A, E>(
    run: (
      groups: KinGroups["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, E>,
  ) =>
    services.pipe(
      Effect.flatMap(({ identity, groups }) =>
        identity.resolve(session).pipe(Effect.flatMap((people) => run(groups, people))),
      ),
      Effect.tapError(logInfra),
      Effect.mapError(mapError),
      Effect.catchDefect(defect),
    );
  const visualHosts = <A, E>(
    run: (
      hosts: KinVisualHosts["Service"],
      people: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<A, E>,
  ) =>
    services.pipe(
      Effect.flatMap(({ identity, visualHosts }) =>
        identity.resolve(session).pipe(Effect.flatMap((people) => run(visualHosts, people))),
      ),
      Effect.tapError(logInfra),
      Effect.mapError(mapError),
      Effect.catchDefect(defect),
    );
  const viewer = Effect.gen(function* () {
    const { identity, chat } = yield* services;
    return { chat, people: yield* identity.resolve(session) };
  });
  const setLeadPaused = (input: KinLeadRetireInput, paused: boolean) =>
    services.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
          return yield* LeadProvision.setPaused({
            ...input,
            paused,
            by: { _tag: "session", session },
          }).pipe(Effect.provideContext(kin.value.services.value));
        }),
      ),
      Effect.mapError(toLeadError),
      Effect.tapError(logInfra),
      Effect.mapError(mapError),
      Effect.catchDefect(defect),
    );
  let openChats = 0;
  return rpcs.of({
    "kin.budget.get": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, budget }) =>
          identity
            .resolve(session)
            .pipe(Effect.flatMap((people) => budget.view(people, input.orgId))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.budget.set": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, budget }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => budget.set(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.org.get": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity
            .resolve(session)
            .pipe(Effect.flatMap((people) => stop.view(people, input.orgId))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.org.pause": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => stop.pause(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.org.resume": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => stop.resume(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.triggers.getTimeZone": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, timeZone }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => timeZone.get(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.triggers.setTimeZone": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, timeZone }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => timeZone.set(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.visuals.hosts.list": (input) => visualHosts((hosts, people) => hosts.list(people, input)),
    "kin.visuals.hosts.allow": (input) =>
      visualHosts((hosts, people) => hosts.allow(people, input)),
    "kin.visuals.hosts.remove": (input) =>
      visualHosts((hosts, people) => hosts.remove(people, input)),
    "kin.orgs.list": () =>
      services.pipe(
        Effect.flatMap(({ identity, chat }) =>
          identity.resolve(session).pipe(Effect.flatMap(chat.orgs)),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chats.subscribe": (input) =>
      Stream.unwrap(
        services.pipe(
          Effect.flatMap(({ identity, chat }) =>
            identity
              .resolve(session)
              .pipe(Effect.map((people) => chat.subscribeChats(people, input))),
          ),
        ),
      ).pipe(
        Stream.tapError(logInfra),
        Stream.mapError(mapError),
        Stream.catchDefect((cause) => Stream.fromEffect(defect(cause))),
      ),
    "kin.chat.subscribe": (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Held for as long as the stream runs: `unwrap` scopes the effect to it.
          yield* Effect.acquireRelease(
            Effect.suspend(() =>
              openChats >= KIN_OPEN_CHATS_PER_CONNECTION
                ? Effect.fail(tooManyChats)
                : Effect.sync(() => void (openChats += 1)),
            ),
            () => Effect.sync(() => void (openChats -= 1)),
          );
          const { chat, people } = yield* viewer;
          return chat.subscribe(people, input);
        }),
      ).pipe(
        Stream.tapError(logInfra),
        Stream.mapError(mapError),
        Stream.catchDefect((cause) => Stream.fromEffect(defect(cause))),
      ),
    "kin.chats.createDirect": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.createDirect(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chats.mute": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.mute(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chats.pin": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.pin(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chats.clear": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.clear(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.chat.members": (input) => group((groups, people) => groups.members(people, input)),
    "kin.groups.create": (input) => group((groups, people) => groups.create(people, input)),
    "kin.chats.withPerson": (input) => group((groups, people) => groups.withPerson(people, input)),
    "kin.groups.addMember": (input) => group((groups, people) => groups.addMember(people, input)),
    "kin.groups.removeMember": (input) =>
      group((groups, people) => groups.removeMember(people, input).pipe(Effect.as({}))),
    "kin.groups.setLead": (input) => group((groups, people) => groups.setLead(people, input)),
    "kin.groups.rename": (input) => group((groups, people) => groups.rename(people, input)),
    "kin.groups.delete": (input) =>
      group((groups, people) => groups.remove(people, input).pipe(Effect.as({}))),
    "kin.groups.setCompany": (input) => group((groups, people) => groups.setCompany(people, input)),
    "kin.chat.history": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.history(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.messages.send": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) =>
          chat.send(people, { ...input, uploader: sessionUploadOwner(session) }),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.messages.markRead": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.markRead(people, input)),
        Effect.as({}),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.widgets.act": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.act(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.messages.react": (input) =>
      viewer.pipe(
        Effect.flatMap(({ chat, people }) => chat.react(people, input)),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.create": (input) =>
      services.pipe(
        Effect.flatMap(({ identity }) =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services) || Option.isNone(settings))
              return yield* unavailable;
            // Only an org the session's person belongs to; the service decides who may create.
            const people = yield* identity.resolve(session);
            if (!people.some((person) => person.orgId === input.orgId))
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Only the owner or a co-owner can create agents.",
              });
            const { _tag, lead } = yield* LeadProvision.create({
              creator: { _tag: "session", session },
              name: input.name,
              domain: input.domain,
              charter: input.charter,
              intro: input.intro,
              model: input.model,
              workerProjects: input.workerProjects ?? [],
            }).pipe(
              Effect.provideContext(kin.value.services.value),
              Effect.provideService(ServerSettingsService, settings.value),
            );
            // No agent goes without a character; a failure leaves the next start to write it.
            yield* seedCharacters(lead.orgId).pipe(
              Effect.provideContext(kin.value.services.value),
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin character not written", Cause.pretty(cause)),
              ),
            );
            return {
              outcome: _tag,
              orgId: lead.orgId,
              agentId: lead.agentId,
              name: lead.name,
              domain: lead.domain,
              level: lead.level,
              ownerChatId: lead.ownerChatId,
              createdByPersonId: lead.createdByPersonId ?? lead.ownerPersonId,
            };
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.leads.list": (input) =>
      services.pipe(
        Effect.flatMap(({ identity }) =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            const person = (yield* identity.resolve(session)).find(
              (entry) => entry.orgId === input.orgId,
            );
            // An org the session's person isn't in has no leads to show them.
            if (person === undefined)
              return {
                leads: [],
                contacts: [],
                messageable: [],
                teamAgentId: null,
                companyChat: null,
              };
            return yield* Effect.all({
              leads: LeadProvision.profiles(person, { includeRetired: input.includeRetired }),
              contacts: LeadProvision.contacts(person),
              messageable: LeadProvision.messageable(person),
              teamAgentId: LeadProvision.teamAgent(person.orgId),
              companyChat: companyChatOf(person.orgId),
            }).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.update": ({ orgId, agentId, ...fields }) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.update({
              editor: { _tag: "session", session },
              orgId,
              agentId,
              fields,
            }).pipe(withHostModels, Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.retire": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            const result = yield* LeadProvision.retire({
              ...input,
              by: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
            return result.profile;
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.restore": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            const result = yield* LeadProvision.restore({
              ...input,
              by: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
            return result.profile;
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.page": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* ownerLevelAgentPage({ ...input, by: { _tag: "session", session } }).pipe(
              withHostModels,
              Effect.provideContext(kin.value.services.value),
            );
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.undoChange": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* ownerLevelUndoChange({
              ...input,
              by: { _tag: "session", session },
            }).pipe(withHostModels, Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.character.set": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* ownerLevelSetCharacter({
              ...input,
              by: { _tag: "session", session },
            }).pipe(withHostModels, Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.pause": (input) => setLeadPaused(input, true),
    "kin.lead.resume": (input) => setLeadPaused(input, false),
    "kin.agents.defaults": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.agentDefaults(
              { _tag: "session", session },
              input.orgId,
            ).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.agents.defaults.set": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.setAgentDefaults(
              { _tag: "session", session },
              input.orgId,
              input.model,
            ).pipe(withHostModels, Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.access.list": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.access({
              ...input,
              editor: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.access.grant": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.allow({
              ...input,
              editor: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.access.revoke": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.disallow({
              ...input,
              editor: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.reach.list": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.reachList({
              ...input,
              editor: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.reach.set": (input) =>
      services.pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* unavailable;
            return yield* LeadProvision.reachSet({
              ...input,
              editor: { _tag: "session", session },
            }).pipe(Effect.provideContext(kin.value.services.value));
          }),
        ),
        Effect.mapError(toLeadError),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
    "kin.lead.interrupt": (input) =>
      services.pipe(
        Effect.flatMap(({ identity, stop }) =>
          identity.resolve(session).pipe(Effect.flatMap((people) => stop.interrupt(people, input))),
        ),
        Effect.tapError(logInfra),
        Effect.mapError(mapError),
        Effect.catchDefect(defect),
      ),
  });
});
