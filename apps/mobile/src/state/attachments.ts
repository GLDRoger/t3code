import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthKinChatScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { readEnvironmentScope } from "./session";

function requireAttachmentWriteAccess<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
  allowKinChat = false,
): AtomCommand<W, A, E | EnvironmentAuthorizationError> {
  return {
    ...command,
    run: async (registry, input) => {
      if (
        !readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope) &&
        !(allowKinChat && readEnvironmentScope(input.environmentId, AuthKinChatScope))
      ) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: m(msg("This connection cannot change attachments.")),
              requiredScope: AuthOrchestrationOperateScope,
            }),
          ),
        );
      }
      return command.run(registry, input);
    },
  };
}

const commands = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
export const attachmentEnvironment = {
  // A Kin teammate's chat-only session may upload; the host grants it upload URLs only.
  createUploadUrl: requireAttachmentWriteAccess(commands.createUploadUrl, true),
  remove: requireAttachmentWriteAccess(commands.remove),
};
