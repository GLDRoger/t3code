import { createFileRoute, redirect } from "@tanstack/react-router";

import { KinPlacesRoute } from "../kin/KinPlaceView";
import { KIN_PLACE_PATH, validateKinPlaceSearch, type KinPlace } from "../kin/kinPlaces";

export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/_places")({
  // What is open rides in the address, so a record can be linked to and Back closes it.
  validateSearch: validateKinPlaceSearch,
  beforeLoad: ({ location, params, search }) => {
    if (search.invalidLink === undefined) return;
    const segment = location.pathname.split("/").at(-1);
    const place: KinPlace =
      segment === "money" || segment === "clients" || segment === "docs" ? segment : "tasks";
    const { invalidLink, ...rest } = search;
    throw redirect({
      to: KIN_PLACE_PATH[place],
      params,
      search: rest,
      state: { ...location.state, kinInvalidLink: invalidLink },
      replace: true,
    });
  },
  component: KinPlacesRoute,
});
