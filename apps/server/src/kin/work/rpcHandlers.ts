import {
  KinChatError,
  KinDocsRpcs,
  KinFinanceRpcs,
  KinStatementRpcs,
  KinWorkRpcs,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import * as Clients from "./ownerClients.ts";
import * as Docs from "./ownerDocs.ts";
import * as Money from "./ownerMoney.ts";
import * as Statements from "./ownerStatements.ts";
import * as Work from "./ownerWork.ts";

const group = RpcGroup.make(...KinWorkRpcs, ...KinDocsRpcs);
const finance = RpcGroup.make(...KinFinanceRpcs);
const statements = RpcGroup.make(...KinStatementRpcs);
const disabled = new KinChatError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const defect = (cause: unknown) =>
  Effect.logWarning("Kin RPC defect.", cause).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

/** Thin transport: resolve the session's people, then one owner-checked Work or Docs call. */
export const makeKinWorkHandlers = Effect.fn("makeKinWorkHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const call = Effect.fn("KinWork.rpc.call")(function* <A, E, R>(
    run: (
      people: Effect.Success<ReturnType<KinIdentity["Service"]["resolve"]>>,
    ) => Effect.Effect<A, E, R>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(people).pipe(Effect.provideContext(services as Context.Context<R>));
  }, Effect.catchDefect(defect));
  const stream = <A, E, R>(
    run: (
      people: Effect.Success<ReturnType<KinIdentity["Service"]["resolve"]>>,
    ) => Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
        const services = kin.value.services.value;
        const people = yield* Context.get(services, KinIdentity).resolve(session);
        return run(people).pipe(Stream.provideContext(services as Context.Context<R>));
      }),
    );
  return {
    ...group.of({
      "kin.work.summary": Effect.fn("KinWork.rpc.summary")(function* (input) {
        return yield* call((people) => Work.summary(people, input));
      }),
      "kin.work.list": Effect.fn("KinWork.rpc.list")(function* (input) {
        return yield* call((people) => Work.list(people, input));
      }),
      "kin.work.get": Effect.fn("KinWork.rpc.get")(function* (input) {
        return yield* call((people) => Work.get(people, input));
      }),
      "kin.work.subscribe": (input) => stream((people) => Work.subscribe(people, input)),
      "kin.work.create": Effect.fn("KinWork.rpc.create")(function* (input) {
        return yield* call((people) => Work.create(people, input));
      }),
      "kin.work.assign": Effect.fn("KinWork.rpc.assign")(function* (input) {
        return yield* call((people) => Work.assign(people, input));
      }),
      "kin.work.update": Effect.fn("KinWork.rpc.update")(function* (input) {
        return yield* call((people) => Work.update(people, input));
      }),
      "kin.work.confirm": Effect.fn("KinWork.rpc.confirm")(function* (input) {
        return yield* call((people) => Work.confirm(people, input));
      }),
      "kin.work.decline": Effect.fn("KinWork.rpc.decline")(function* (input) {
        return yield* call((people) => Work.decline(people, input));
      }),
      "kin.work.parties": Effect.fn("KinWork.rpc.parties")(function* (input) {
        return yield* call((people) => Clients.parties(people, input));
      }),
      "kin.work.party": Effect.fn("KinWork.rpc.party")(function* (input) {
        return yield* call((people) => Clients.party(people, input));
      }),
      "kin.work.projects": Effect.fn("KinWork.rpc.projects")(function* (input) {
        return yield* call((people) => Clients.projects(people, input));
      }),
      "kin.work.project": Effect.fn("KinWork.rpc.project")(function* (input) {
        return yield* call((people) => Clients.project(people, input));
      }),
      "kin.work.history": Effect.fn("KinWork.rpc.history")(function* (input) {
        return yield* call((people) => Clients.history(people, input));
      }),
      "kin.work.createParty": Effect.fn("KinWork.rpc.createParty")(function* (input) {
        return yield* call((people) => Clients.createParty(people, input));
      }),
      "kin.work.updateParty": Effect.fn("KinWork.rpc.updateParty")(function* (input) {
        return yield* call((people) => Clients.updateParty(people, input));
      }),
      "kin.work.createContact": Effect.fn("KinWork.rpc.createContact")(function* (input) {
        return yield* call((people) => Clients.createContact(people, input));
      }),
      "kin.work.updateContact": Effect.fn("KinWork.rpc.updateContact")(function* (input) {
        return yield* call((people) => Clients.updateContact(people, input));
      }),
      "kin.work.createProject": Effect.fn("KinWork.rpc.createProject")(function* (input) {
        return yield* call((people) => Clients.createProject(people, input));
      }),
      "kin.work.updateProject": Effect.fn("KinWork.rpc.updateProject")(function* (input) {
        return yield* call((people) => Clients.updateProject(people, input));
      }),
      "kin.docs.list": Effect.fn("KinDocs.rpc.list")(function* (input) {
        return yield* call((people) => Docs.list(people, input));
      }),
      "kin.docs.get": Effect.fn("KinDocs.rpc.get")(function* (input) {
        return yield* call((people) => Docs.get(people, input));
      }),
      "kin.docs.history": Effect.fn("KinDocs.rpc.history")(function* (input) {
        return yield* call((people) => Docs.history(people, input));
      }),
      "kin.docs.diff": Effect.fn("KinDocs.rpc.diff")(function* (input) {
        return yield* call((people) => Docs.diff(people, input));
      }),
      "kin.docs.restore": Effect.fn("KinDocs.rpc.restore")(function* (input) {
        return yield* call((people) => Docs.restore(people, input));
      }),
      "kin.docs.subscribe": (input) => stream((people) => Docs.subscribe(people, input)),
      "kin.docs.recipes": Effect.fn("KinDocs.rpc.recipes")(function* (input) {
        return yield* call((people) => Docs.recipes(people, input));
      }),
      "kin.docs.render": Effect.fn("KinDocs.rpc.render")(function* (input) {
        return yield* call((people) => Docs.render(people, input));
      }),
      "kin.docs.undoRecipe": Effect.fn("KinDocs.rpc.undoRecipe")(function* (input) {
        return yield* call((people) => Docs.undoRecipe(people, input));
      }),
      "kin.docs.label": Effect.fn("KinDocs.rpc.label")(function* (input) {
        return yield* call((people) => Docs.label(people, input));
      }),
      "kin.docs.clearRecipeLabel": Effect.fn("KinDocs.rpc.clearRecipeLabel")(function* (input) {
        return yield* call((people) => Docs.labelRecipe(people, { ...input, sensitive: false }));
      }),
      "kin.docs.labelRecipe": Effect.fn("KinDocs.rpc.labelRecipe")(function* (input) {
        return yield* call((people) => Docs.labelRecipe(people, input));
      }),
      "kin.docs.setDefaultRecipe": Effect.fn("KinDocs.rpc.setDefaultRecipe")(function* (input) {
        return yield* call((people) => Docs.setDefaultRecipe(people, input));
      }),
      "kin.search": Effect.fn("KinDocs.rpc.search")(function* (input) {
        return yield* call((people) => Docs.search(people, input));
      }),
    }),
    ...finance.of({
      "kin.work.lists": Effect.fn("KinWork.rpc.lists")(function* (input) {
        return yield* call((people) => Money.lists(people, input));
      }),
      "kin.work.updateList": Effect.fn("KinWork.rpc.updateList")(function* (input) {
        return yield* call((people) => Money.updateList(people, input));
      }),
      "kin.work.dates": Effect.fn("KinWork.rpc.dates")(function* (input) {
        return yield* call((people) => Money.dates(people, input));
      }),
      "kin.work.money": Effect.fn("KinWork.rpc.money")(function* (input) {
        return yield* call((people) => Money.money(people, input));
      }),
      "kin.work.recordPayment": Effect.fn("KinWork.rpc.recordPayment")(function* (input) {
        return yield* call((people) => Money.recordPayment(people, input));
      }),
      "kin.work.voidPayment": Effect.fn("KinWork.rpc.voidPayment")(function* (input) {
        return yield* call((people) => Money.voidPayment(people, input));
      }),
      "kin.work.files": Effect.fn("KinWork.rpc.files")(function* (input) {
        return yield* call((people) => Money.files(people, input));
      }),
      "kin.work.companyProfile": Effect.fn("KinWork.rpc.companyProfile")(function* (input) {
        return yield* call((people) => Money.companyProfile(people, input));
      }),
      "kin.work.setCompanyProfile": Effect.fn("KinWork.rpc.setCompanyProfile")(function* (input) {
        return yield* call((people) => Money.setCompanyProfile(people, input));
      }),
      "kin.work.issue": Effect.fn("KinWork.rpc.issue")(function* (input) {
        return yield* call((people) => Money.issue(people, input));
      }),
      "kin.work.nextNumber": Effect.fn("KinWork.rpc.nextNumber")(function* (input) {
        return yield* call((people) => Money.nextNumber(people, input));
      }),
      "kin.work.void": Effect.fn("KinWork.rpc.void")(function* (input) {
        return yield* call((people) => Money.voidEntry(people, input));
      }),
      "kin.work.unvoid": Effect.fn("KinWork.rpc.unvoid")(function* (input) {
        return yield* call((people) => Money.unvoidEntry(people, input));
      }),
      "kin.work.receipts": Effect.fn("KinWork.rpc.receipts")(function* (input) {
        return yield* call((people) => Money.receipts(people, input));
      }),
      "kin.work.makeReceipt": Effect.fn("KinWork.rpc.makeReceipt")(function* (input) {
        return yield* call((people) => Money.makeReceipt(people, input));
      }),
    }),
    ...statements.of({
      "kin.work.statementUnlock": Effect.fn("KinWork.rpc.statementUnlock")(function* (input) {
        return yield* call((people) => Statements.unlock(people, input));
      }),
      "kin.work.statementForgetPassword": Effect.fn("KinWork.rpc.statementForgetPassword")(
        function* (input) {
          return yield* call((people) => Statements.forgetPassword(people, input));
        },
      ),
      "kin.work.statementApply": Effect.fn("KinWork.rpc.statementApply")(function* (input) {
        return yield* call((people) => Statements.apply(people, input));
      }),
      "kin.work.statementUndo": Effect.fn("KinWork.rpc.statementUndo")(function* (input) {
        return yield* call((people) => Statements.undo(people, input));
      }),
    }),
  };
});
