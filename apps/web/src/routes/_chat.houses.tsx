import { createFileRoute } from "@tanstack/react-router";

import { HousesPage } from "../components/kin/HousesPage";

export const Route = createFileRoute("/_chat/houses")({
  component: HousesPage,
});
