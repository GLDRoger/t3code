import { createMemoryHistory } from "@tanstack/react-router";

/** Spread into `createRouter` for a memory router in Node tests that navigate. */
export function testMemoryRouterOptions(initialEntry: string) {
  return {
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    // Without a document the router runs as SSR, where navigate is a no-op.
    isServer: false,
    origin: "http://localhost",
  } as const;
}
