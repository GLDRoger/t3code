import { createFileRoute } from "@tanstack/react-router";

import { KinNoChat } from "../kin/KinPage";

export const Route = createFileRoute("/_chat/kin/")({
  component: KinNoChat,
});
