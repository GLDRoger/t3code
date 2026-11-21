import {
  KinChatError,
  KinDealRpcs,
  KinDocsRpcs,
  KinFinanceRpcs,
  KinImportRpcs,
  KinMoneyAnswerRpcs,
  KinMoneyLiveRpcs,
  KinOpenRpcs,
  KinPulseRpcs,
  KinRefreshRpcs,
  KinStatementRpcs,
  KinWorkRpcs,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import { sessionUploadOwner } from "../../assets/AttachmentUpload.ts";
import { AssetSigner } from "../../assets/AssetSigner.ts";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { announceRefreshes, subscribeRefreshes } from "../chat/refreshes.ts";
import { KinServer } from "../KinServer.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as CheckIns from "../pulse/checkIns.ts";
import * as Pulse from "../pulse/people.ts";
import * as Open from "../open/people.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import * as Goals from "./goals.ts";
import * as Clients from "./ownerClients.ts";
import * as Deals from "./deals.ts";
import * as Docs from "./ownerDocs.ts";
import * as ImportFile from "./importFile.ts";
import * as Export from "./exportBundle.ts";
import * as Marketing from "./ownerMarketing.ts";
import * as Money from "./ownerMoney.ts";
import * as MoneyAnswers from "./ownerMoneyAnswers.ts";
import * as MoneyStream from "./moneyStream.ts";
import * as Statements from "./ownerStatements.ts";
import * as Work from "./ownerWork.ts";
import * as Comments from "./workComments.ts";
import * as WorkStream from "./workStream.ts";

const group = RpcGroup.make(...KinWorkRpcs, ...KinDealRpcs, ...KinImportRpcs, ...KinDocsRpcs);
const finance = RpcGroup.make(...KinFinanceRpcs);
const answers = RpcGroup.make(...KinMoneyAnswerRpcs);
const moneyLive = RpcGroup.make(...KinMoneyLiveRpcs);
const statements = RpcGroup.make(...KinStatementRpcs);
const refreshes = RpcGroup.make(...KinRefreshRpcs);
const pulse = RpcGroup.make(...KinPulseRpcs);
const open = RpcGroup.make(...KinOpenRpcs);
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

/** Thin transport: resolve the session's people, then one Work, Docs or refresh call. */
export const makeKinWorkHandlers = Effect.fn("makeKinWorkHandlers")(function* (
  session: AuthenticatedSession,
) {
  const kin = yield* Effect.serviceOption(KinServer);
  const signer = yield* Effect.serviceOption(AssetSigner);
  // Saving a check-in writes its native task; the socket's own services do that.
  const scheduling = Option.all({
    tasks: yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService),
    launcher: yield* Effect.serviceOption(ThreadLaunchService.ThreadLaunchService),
    threads: yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService),
  });
  const call = Effect.fn("KinWork.rpc.call")(function* <A, E, R>(
    run: (
      people: Effect.Success<ReturnType<KinIdentity["Service"]["resolve"]>>,
    ) => Effect.Effect<A, E, R>,
  ) {
    if (Option.isNone(kin) || Option.isNone(kin.value.services)) return yield* disabled;
    const services = kin.value.services.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    return yield* run(people).pipe(Effect.provideContext(services));
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
        return run(people).pipe(Stream.provideContext(services));
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
      // Rows only for a client that asks: an older phone keeps getting `changed`.
      "kin.work.subscribe": (input) =>
        stream((people) =>
          input.acceptRows === true
            ? WorkStream.subscribeRows(people, input)
            : WorkStream.subscribeChanged(people, input),
        ),
      "kin.work.create": Effect.fn("KinWork.rpc.create")(function* (input) {
        return yield* call((people) => Work.create(people, input));
      }),
      "kin.work.assign": Effect.fn("KinWork.rpc.assign")(function* (input) {
        return yield* call((people) => Work.assign(people, input));
      }),
      "kin.work.handBack": Effect.fn("KinWork.rpc.handBack")(function* (input) {
        return yield* call((people) => Work.handBack(people, input));
      }),
      "kin.work.nudge": Effect.fn("KinWork.rpc.nudge")(function* (input) {
        return yield* call((people) => Work.nudge(people, input));
      }),
      "kin.work.comment": Effect.fn("KinWork.rpc.comment")(function* (input) {
        return yield* call((people) =>
          Comments.comment(people, input, sessionUploadOwner(session)),
        );
      }),
      "kin.work.commentRemove": Effect.fn("KinWork.rpc.commentRemove")(function* (input) {
        return yield* call((people) => Comments.removeOne(people, input));
      }),
      "kin.work.comments": Effect.fn("KinWork.rpc.comments")(function* (input) {
        return yield* call((people) => Comments.page(people, input));
      }),
      "kin.work.linkAdd": Effect.fn("KinWork.rpc.linkAdd")(function* (input) {
        return yield* call((people) => Work.addLink(people, input));
      }),
      "kin.work.linkRemove": Effect.fn("KinWork.rpc.linkRemove")(function* (input) {
        return yield* call((people) => Work.removeLink(people, input));
      }),
      "kin.work.projectNote": Effect.fn("KinWork.rpc.projectNote")(function* (input) {
        return yield* call((people) => Comments.projectNote(people, input));
      }),
      "kin.work.handOver": Effect.fn("KinWork.rpc.handOver")(function* (input) {
        return yield* call((people) => Work.handOver(people, input));
      }),
      "kin.work.update": Effect.fn("KinWork.rpc.update")(function* (input) {
        return yield* call((people) => Work.update(people, input));
      }),
      "kin.work.tickStep": Effect.fn("KinWork.rpc.tickStep")(function* (input) {
        return yield* call((people) => Work.tickStep(people, input));
      }),
      "kin.work.confirm": Effect.fn("KinWork.rpc.confirm")(function* (input) {
        return yield* call((people) => Work.confirm(people, input));
      }),
      "kin.work.decline": Effect.fn("KinWork.rpc.decline")(function* (input) {
        return yield* call((people) => Work.decline(people, input));
      }),
      "kin.work.share": Effect.fn("KinWork.rpc.share")(function* (input) {
        return yield* call((people) => Work.share(people, input));
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
      "kin.work.deals": Effect.fn("KinWork.rpc.deals")(function* (input) {
        return yield* call((people) => Deals.deals(people, input));
      }),
      "kin.work.deal": Effect.fn("KinWork.rpc.deal")(function* (input) {
        return yield* call((people) => Deals.page(people, input));
      }),
      "kin.work.createDeal": Effect.fn("KinWork.rpc.createDeal")(function* (input) {
        return yield* call((people) => Deals.create(people, input));
      }),
      "kin.work.createPartyWithDeal": Effect.fn("KinWork.rpc.createPartyWithDeal")(
        function* (input) {
          return yield* call((people) => Clients.createPartyWithDeal(people, input));
        },
      ),
      "kin.work.updateDeal": Effect.fn("KinWork.rpc.updateDeal")(function* (input) {
        return yield* call((people) => Deals.update(people, input));
      }),
      "kin.work.moveDeal": Effect.fn("KinWork.rpc.moveDeal")(function* (input) {
        return yield* call((people) => Deals.move(people, input));
      }),
      "kin.work.dealStep": Effect.fn("KinWork.rpc.dealStep")(function* (input) {
        return yield* call((people) => Deals.step(people, input));
      }),
      "kin.work.dealStages": Effect.fn("KinWork.rpc.dealStages")(function* (input) {
        return yield* call((people) => Deals.stages(people, input));
      }),
      "kin.work.setDealStages": Effect.fn("KinWork.rpc.setDealStages")(function* (input) {
        return yield* call((people) => Deals.setStages(people, input));
      }),
      "kin.work.setDealQuietDays": Effect.fn("KinWork.rpc.setDealQuietDays")(function* (input) {
        return yield* call((people) => Deals.setQuietDays(people, input));
      }),
      "kin.import.check": Effect.fn("KinWork.rpc.importCheck")(function* (input) {
        return yield* call((people) => ImportFile.check(people, input));
      }),
      "kin.import.apply": Effect.fn("KinWork.rpc.importApply")(function* (input) {
        return yield* call((people) => ImportFile.apply(people, input));
      }),
      "kin.import.undo": Effect.fn("KinWork.rpc.importUndo")(function* (input) {
        return yield* call((people) => ImportFile.undo(people, input));
      }),
      "kin.import.runs": Effect.fn("KinWork.rpc.importRuns")(function* (input) {
        return yield* call((people) => ImportFile.runs(people, input));
      }),
      "kin.work.logTouch": Effect.fn("KinWork.rpc.logTouch")(function* (input) {
        return yield* call((people) => Clients.logTouch(people, input));
      }),
      "kin.work.removeTouch": Effect.fn("KinWork.rpc.removeTouch")(function* (input) {
        return yield* call((people) => Clients.removeTouch(people, input));
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
      "kin.work.projectPeople": Effect.fn("KinWork.rpc.projectPeople")(function* (input) {
        return yield* call((people) => Clients.projectPeople(people, input));
      }),
      "kin.work.marketing": Effect.fn("KinWork.rpc.marketing")(function* (input) {
        return yield* call((people) => Marketing.marketing(people, input));
      }),
      "kin.work.contactList": Effect.fn("KinWork.rpc.contactList")(function* (input) {
        return yield* call((people) => Marketing.contactList(people, input));
      }),
      "kin.work.exportContacts": Effect.fn("KinWork.rpc.exportContacts")(function* (input) {
        return yield* call((people) => Marketing.exportContacts(people, input));
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
      "kin.docs.editSection": Effect.fn("KinDocs.rpc.editSection")(function* (input) {
        return yield* call((people) => Docs.editSection(people, input));
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
      "kin.docs.file": Effect.fn("KinDocs.rpc.file")(function* (input) {
        return yield* call((people) => Docs.file(people, input));
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
      "kin.docs.startWhatWeSell": Effect.fn("KinDocs.rpc.startWhatWeSell")(function* (input) {
        return yield* call((people) => Docs.startWhatWeSell(people, input));
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
      "kin.work.exportLink": Effect.fn("KinWork.rpc.exportLink")(function* (input) {
        if (Option.isNone(signer)) return yield* disabled;
        return yield* call((people) =>
          Export.exportLink(people, session.sessionId, signer.value, input),
        );
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
    ...answers.of({
      "kin.work.cash": Effect.fn("KinWork.rpc.cash")(function* (input) {
        return yield* call((people) => MoneyAnswers.cash(people, input));
      }),
      "kin.work.outlook": Effect.fn("KinWork.rpc.outlook")(function* (input) {
        return yield* call((people) => MoneyAnswers.outlook(people, input));
      }),
      "kin.work.budgets": Effect.fn("KinWork.rpc.budgets")(function* (input) {
        return yield* call((people) => MoneyAnswers.budgets(people, input));
      }),
      "kin.work.setBudget": Effect.fn("KinWork.rpc.setBudget")(function* (input) {
        return yield* call((people) => MoneyAnswers.setBudget(people, input));
      }),
      "kin.work.entryLines": Effect.fn("KinWork.rpc.entryLines")(function* (input) {
        return yield* call((people) => MoneyAnswers.entryLines(people, input));
      }),
      "kin.work.invoiceFromQuote": Effect.fn("KinWork.rpc.invoiceFromQuote")(function* (input) {
        return yield* call((people) => MoneyAnswers.invoiceFromQuote(people, input));
      }),
      "kin.work.newInvoice": Effect.fn("KinWork.rpc.newInvoice")(function* (input) {
        return yield* call((people) => MoneyAnswers.newInvoice(people, input));
      }),
      "kin.work.newExpense": Effect.fn("KinWork.rpc.newExpense")(function* (input) {
        return yield* call((people) => MoneyAnswers.newExpense(people, input));
      }),
    }),
    ...moneyLive.of({
      "kin.money.subscribe": (input) => stream((people) => MoneyStream.subscribe(people, input)),
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
      "kin.work.statementReread": Effect.fn("KinWork.rpc.statementReread")(function* (input) {
        return yield* call((people) => Statements.reread(people, input));
      }),
      "kin.work.statementSelect": Effect.fn("KinWork.rpc.statementSelect")(function* (input) {
        return yield* call((people) => Statements.select(people, input));
      }),
      "kin.work.statementRows": Effect.fn("KinWork.rpc.statementRows")(function* (input) {
        return yield* call((people) => Statements.rows(people, input));
      }),
      "kin.work.statementPasswords": Effect.fn("KinWork.rpc.statementPasswords")(function* (input) {
        return yield* call((people) => Statements.passwords(people, input));
      }),
      "kin.work.statementForgetAccount": Effect.fn("KinWork.rpc.statementForgetAccount")(
        function* (input) {
          return yield* call((people) => Statements.forgetAccount(people, input));
        },
      ),
    }),
    ...refreshes.of({
      "kin.refreshes.subscribe": (input) => stream((people) => subscribeRefreshes(people, input)),
      "kin.refreshes.announce": Effect.fn("KinWork.rpc.announceRefreshes")(function* (input) {
        return yield* call((people) => announceRefreshes(people, input));
      }),
    }),
    ...open.of({
      "kin.open.read": Effect.fn("KinOpen.rpc.read")(function* (input) {
        return yield* call((people) => Open.read(people, input));
      }),
      "kin.open.subscribe": (input) => stream((people) => Open.subscribe(people, input)),
    }),
    ...pulse.of({
      "kin.pulse.read": Effect.fn("KinPulse.rpc.read")(function* (input) {
        return yield* call((people) => Pulse.read(people, input));
      }),
      "kin.pulse.subscribe": (input) => stream((people) => Pulse.subscribe(people, input)),
      "kin.pulse.handle": Effect.fn("KinPulse.rpc.handle")(function* (input) {
        return yield* call((people) => Pulse.handle(people, input));
      }),
      "kin.pulse.aside": Effect.fn("KinPulse.rpc.aside")(function* (input) {
        return yield* call((people) => Pulse.aside(people, input));
      }),
      "kin.goals.list": Effect.fn("KinGoals.rpc.list")(function* (input) {
        return yield* call((people) => Goals.list(people, input.orgId));
      }),
      "kin.goals.save": Effect.fn("KinGoals.rpc.save")(function* (input) {
        return yield* call((people) => Goals.save(people, input));
      }),
      "kin.checkIns.list": Effect.fn("KinCheckIns.rpc.list")(function* (input) {
        return yield* call((people) => CheckIns.list(people, input.orgId));
      }),
      "kin.checkIns.save": Effect.fn("KinCheckIns.rpc.save")(function* (input) {
        if (Option.isNone(scheduling)) return yield* disabled;
        const { tasks, launcher, threads } = scheduling.value;
        return yield* call((people) =>
          CheckIns.save(people, input).pipe(
            Effect.provide(KinSchedules.layer),
            Effect.provideService(ScheduledTaskService.ScheduledTaskService, tasks),
            Effect.provideService(ThreadLaunchService.ThreadLaunchService, launcher),
            Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          ),
        );
      }),
      "kin.checkIns.act": Effect.fn("KinCheckIns.rpc.act")(function* (input) {
        return yield* call((people) => CheckIns.act(people, input));
      }),
      "kin.briefs.list": Effect.fn("KinBriefs.rpc.list")(function* (input) {
        return yield* call((people) => CheckIns.briefs(people, input.orgId));
      }),
      "kin.briefs.save": Effect.fn("KinBriefs.rpc.save")(function* (input) {
        if (Option.isNone(scheduling)) return yield* disabled;
        const { tasks, launcher, threads } = scheduling.value;
        return yield* call((people) =>
          CheckIns.saveBrief(people, input).pipe(
            Effect.provide(KinSchedules.layer),
            Effect.provideService(ScheduledTaskService.ScheduledTaskService, tasks),
            Effect.provideService(ThreadLaunchService.ThreadLaunchService, launcher),
            Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          ),
        );
      }),
    }),
  };
});
