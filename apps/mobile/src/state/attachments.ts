import { mayUploadAttachments } from "@t3tools/client-runtime/kin/kinAttachmentAccess";
import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";

import { connectionAtomRuntime } from "../connection/runtime";
import { readEnvironmentScope } from "./session";

function requireAttachmentWriteAccess<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  allowKinChat = false,
): AtomCommand<W, A, E | EnvironmentAuthorizationError> {
  return {
    ...command,
    run: (registry, input) =>
      Effect.suspend((): Effect.Effect<A, E | EnvironmentAuthorizationError> => {
        const hasScope = (scope: AuthEnvironmentScope) =>
          readEnvironmentScope(input.environmentId, scope);
        return (
          allowKinChat ? mayUploadAttachments(hasScope) : hasScope(AuthOrchestrationOperateScope)
        )
          ? command.run(registry, input)
          : Effect.fail(
              new EnvironmentAuthorizationError({
                message: m(msg("This connection cannot change attachments.")),
                requiredScope: AuthOrchestrationOperateScope,
              }),
            );
      }),
  };
}

const commands = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
export const attachmentEnvironment = {
  // A Kin teammate's chat-only session may upload; the host grants it upload URLs only.
  createUploadUrl: requireAttachmentWriteAccess(commands.createUploadUrl, true),
  remove: requireAttachmentWriteAccess(commands.remove),
};
