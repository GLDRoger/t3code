import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { KinChatView } from "../kin/KinChatView";
import { validatedSearch } from "../kin/kinPlaces";

function KinChatRoute() {
  const { environmentId, orgId, chatId } = Route.useParams();
  const { message } = Route.useSearch();
  return (
    <KinChatView
      // One mounted view per chat, so its feed state never carries over.
      key={`${environmentId}:${chatId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={orgId}
      chatId={chatId}
      message={message}
    />
  );
}

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/$chatId")({
  // The message a notification opened the chat on.
  validateSearch: (raw: Record<string, unknown>): { readonly message?: string } =>
    validatedSearch(
      raw,
      ["message"],
      typeof raw.message === "string" && raw.message !== "" ? { message: raw.message } : {},
    ),
  component: KinChatRoute,
});
