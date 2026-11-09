import { createFileRoute } from "@tanstack/react-router";

import { KinPage } from "../kin/KinPage";

export const Route = createFileRoute("/_chat/kin")({
  component: KinPage,
});
