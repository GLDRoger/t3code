import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { redirectCodingToKin } from "./kinNoCode";

const HELPER = "thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Ab2";

function appRouter(path: string, kinOnly: boolean) {
  const root = createRootRoute({
    beforeLoad: ({ location }) => redirectCodingToKin(location.pathname, kinOnly),
  });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/kin" }),
    createRoute({ getParentRoute: () => root, path: "/settings/providers" }),
    createRoute({ getParentRoute: () => root, path: "/settings/worktrees" }),
    createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" }),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

describe("redirectCodingToKin", () => {
  it("lands a Kin web app restored on a helper's thread on Kin's home, naming the thread", async () => {
    const router = appRouter(`/env-1/${encodeURIComponent(HELPER)}`, true);
    await router.load();
    expect(router.state.location.pathname).toBe("/kin");
    expect(router.state.location.state.kinStrayThread).toEqual({
      environmentId: "env-1",
      threadId: HELPER,
    });
  });

  it("keeps the app's settings in the Kin web app", async () => {
    const router = appRouter("/settings/providers", true);
    await router.load();
    expect(router.state.location.pathname).toBe("/settings/providers");
  });

  it("opens Kin's Settings for a coding settings page in the Kin web app", async () => {
    const router = appRouter("/settings/worktrees", true);
    await router.load();
    expect(router.state.location.pathname).toBe("/kin");
    expect(router.state.location.search).toEqual({ settings: "" });
  });

  it("leaves every route as it was in T3 Code's own build", async () => {
    const path = `/env-1/${encodeURIComponent(HELPER)}`;
    const router = appRouter(path, false);
    await router.load();
    expect(router.state.location.pathname).toBe(path);
    expect(router.state.location.state.kinStrayThread).toBeUndefined();
    const settings = appRouter("/settings/worktrees", false);
    await settings.load();
    expect(settings.state.location.pathname).toBe("/settings/worktrees");
  });
});
