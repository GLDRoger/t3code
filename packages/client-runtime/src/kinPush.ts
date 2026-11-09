import { KIN_PUSH_WS_METHODS, type KinChatId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { subscribe } from "./rpc/client.ts";

/**
 * Run while a Kin chat is on screen, and stop when it leaves the screen or the app the
 * foreground: until then the host skips this device's pushes for the chat.
 * @public MOB-11's chat screen, on the mobile stack, is its first caller.
 */
export const watchKinChatForPush = (chatId: KinChatId) =>
  subscribe(KIN_PUSH_WS_METHODS.watch, { chatId }).pipe(Stream.runDrain);
