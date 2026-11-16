import { createFileRoute } from "@tanstack/react-router";

// Opens Settings over the last Kin page; see the parent route.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings/")({});
