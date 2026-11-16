import { createFileRoute } from "@tanstack/react-router";

import { KinPage } from "../kin/KinPage";
import { validateKinAgentSearch } from "../kin/kinPlaces";

export const Route = createFileRoute("/_chat/kin")({
  validateSearch: validateKinAgentSearch,
  component: KinPage,
});
