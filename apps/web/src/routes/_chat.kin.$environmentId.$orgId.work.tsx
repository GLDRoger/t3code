import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  KIN_PLACE_PATH,
  kinPlaceOfWork,
  validatedSearch,
  validateKinPlaceSearch,
} from "../kin/kinPlaces";

// Work was one page with a part per tab; its old addresses land on the place that took each part.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/work")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateKinPlaceSearch(raw),
    ...validatedSearch(raw, ["show"], typeof raw.show === "string" ? { show: raw.show } : {}),
  }),
  beforeLoad: ({ params, search }) => {
    const { place, search: kept } = kinPlaceOfWork(search);
    throw redirect({ to: KIN_PLACE_PATH[place], params, search: kept, replace: true });
  },
});
