import {
  AssetAttachmentNotFoundError,
  AuthKinChatScope,
  type AssetResource,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { normalizeAttachmentRelativePath } from "../../attachmentPaths.ts";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { KinServer } from "../KinServer.ts";
import { KIN_ATTACHMENT_ID_PREFIX } from "./KinAttachmentStore.ts";
import { KinChatService } from "./KinChatService.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { KinVisualHosts } from "./KinVisualHosts.ts";

type AttachmentResource = Extract<AssetResource, { readonly _tag: "attachment" }>;

/**
 * Who may be handed a URL for a stored attachment. A file on a Kin message goes only to people
 * in that message's chat, whatever else their session may do; a session that holds nothing but
 * chat access gets no other file. A refusal reads as a missing file, so an id tells nothing.
 */
export const authorizeAttachmentRead = Effect.fn("Kin.authorizeAttachmentRead")(function* (
  session: AuthenticatedSession,
  resource: AttachmentResource,
  kin: Option.Option<Context.Context<KinIdentity | KinChatService>>,
) {
  const refused = new AssetAttachmentNotFoundError({ resource });
  // The file is found by the normalised id, on disks that ignore case: check the same name.
  // Stored ids are ASCII, so anything else is refused before a disk can fold it into one.
  const attachmentId = normalizeAttachmentRelativePath(resource.attachmentId)?.toLowerCase();
  if (attachmentId === undefined || !/^[\x21-\x7e]+$/.test(attachmentId)) return yield* refused;
  if (!attachmentId.startsWith(KIN_ATTACHMENT_ID_PREFIX)) {
    return session.scopes.every((scope) => scope === AuthKinChatScope) ? yield* refused : undefined;
  }
  if (Option.isNone(kin)) return yield* refused;
  const readable = yield* Context.get(kin.value, KinIdentity)
    .resolve(session)
    .pipe(
      Effect.flatMap((people) =>
        Context.get(kin.value, KinChatService).attachmentReadable(people, attachmentId),
      ),
      // A failed lookup is refused like a stranger: reading is denied by default.
      Effect.orElseSucceed(() => false),
    );
  if (!readable) return yield* refused;
});

/** `authorizeAttachmentRead` against this host's Kin, for the transport that serves the URL. */
export const authorizeAttachmentReadOnHost = Effect.fn("Kin.authorizeAttachmentReadOnHost")(
  function* (session: AuthenticatedSession, resource: AttachmentResource) {
    const kin = yield* Effect.serviceOption(KinServer);
    yield* authorizeAttachmentRead(
      session,
      resource,
      Option.flatMap(kin, (server) => server.services),
    );
  },
);

/**
 * Whether a Kin file's URL may still be served: the session it was minted for is still in force
 * and its person is still an active member of the chat of a message that still holds the file.
 * Checked on every request, since the URL itself is the only credential image views send.
 */
export const authorizeAttachmentServe = Effect.fn("Kin.authorizeAttachmentServe")(function* (
  reader: AuthSessionId | undefined,
  attachmentId: string,
) {
  if (reader === undefined) return false;
  const sessions = yield* SessionStore.SessionStore;
  const session = yield* sessions.getActive(reader).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Kin could not read the reader's session.", cause),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(session)) return false;
  return yield* authorizeAttachmentReadOnHost(session.value, {
    _tag: "attachment",
    attachmentId,
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

export interface KinVisualSources {
  /** Outside hosts the org's owner allowed; the served policy lists exactly these. */
  readonly hosts: ReadonlyArray<string>;
  /** The chat's other files, which the page may show by id. */
  readonly files: ReadonlyArray<{
    readonly attachmentId: string;
    readonly mimeType: string | null;
  }>;
}

const NO_SOURCES: KinVisualSources = { hosts: [], files: [] };

/**
 * What a chat's page may load besides itself. A failed lookup yields nothing, so the page is
 * then served with no outside host and no chat file.
 */
export const kinVisualSources = Effect.fn("Kin.visualSources")(function* (attachmentId: string) {
  const kin = yield* Effect.serviceOption(KinServer);
  const services = Option.flatMap(kin, (server) => server.services);
  if (Option.isNone(services)) return NO_SOURCES;
  return yield* Context.get(services.value, KinChatService)
    .visualSources(attachmentId.toLowerCase())
    .pipe(
      Effect.flatMap((sources) =>
        Option.isNone(sources)
          ? Effect.succeed(NO_SOURCES)
          : Context.get(services.value, KinVisualHosts)
              .served(sources.value.orgId)
              .pipe(Effect.map((hosts) => ({ hosts, files: sources.value.files }))),
      ),
      Effect.tapError((cause) =>
        Effect.logWarning("Kin could not read a visual's sources.", cause),
      ),
      Effect.orElseSucceed(() => NO_SOURCES),
    );
});
