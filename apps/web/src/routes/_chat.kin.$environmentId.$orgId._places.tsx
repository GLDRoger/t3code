import { createFileRoute } from "@tanstack/react-router";

import { KinPlacesRoute } from "../kin/KinPlaceView";
import { validateKinPlaceSearch } from "../kin/kinPlaces";

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/_places")({
  // What is open rides in the address, so a record can be linked to and Back closes it.
  validateSearch: validateKinPlaceSearch,
  component: KinPlacesRoute,
});
