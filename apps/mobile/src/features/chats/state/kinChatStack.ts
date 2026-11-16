type RouteLike = { readonly name: string; readonly key?: string; readonly params?: object };

const CHAT_SCREENS = new Set(["KinChat", "KinGroup", "KinGroupForm"]);

const showsChat = (route: RouteLike, chatId: string) =>
  CHAT_SCREENS.has(route.name) &&
  route.params !== undefined &&
  "chatId" in route.params &&
  route.params.chatId === chatId;

/**
 * The root stack once a chat is gone: its chat, details and form screens leave, and the stack ends
 * on the Kin list, added when a notification or link opened the chat without it.
 */
export function kinStackWithoutChat<State extends { readonly routes: readonly RouteLike[] }>(
  state: State,
  chatId: string,
  listRoute: "Home" | "KinChats",
) {
  const kept = state.routes.filter((route) => !showsChat(route, chatId));
  const list = kept.findLastIndex((route) => route.name === listRoute);
  const routes = list < 0 ? [...kept, { name: listRoute }] : kept.slice(0, list + 1);
  return { ...state, index: routes.length - 1, routes };
}
