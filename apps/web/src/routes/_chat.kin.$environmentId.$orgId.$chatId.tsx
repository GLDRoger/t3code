import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { KinChatView } from "../kin/KinChatView";

function KinChatRoute() {
  const { environmentId, orgId, chatId } = Route.useParams();
  return (
    <KinChatView
      // One mounted view per chat, so its feed state never carries over.
      key={`${environmentId}:${chatId}`}
      environmentId={environmentId as EnvironmentId}
      orgId={orgId}
      chatId={chatId}
    />
  );
}

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/$chatId")({
  component: KinChatRoute,
});
