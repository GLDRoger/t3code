import { createFileRoute } from "@tanstack/react-router";

// A link to one section ("Open Connections") opens Settings on it; see the parent route.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/settings/$page")({});
