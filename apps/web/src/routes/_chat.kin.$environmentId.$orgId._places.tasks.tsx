import { createFileRoute } from "@tanstack/react-router";

// The places share one view in their layout, so a filter set in one survives a visit to another.
export const Route = createFileRoute("/_chat/kin/$environmentId/$orgId/_places/tasks")({});
