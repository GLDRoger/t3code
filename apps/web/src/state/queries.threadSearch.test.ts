import {
  AuthKinChatScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: [] as ReadonlyArray<string>,
  refused: false,
  searchRequests: [] as Array<unknown>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => {},
  useState: <A>(value: A) => [value, vi.fn()],
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const registry = (await import("effect/reactivity")).AtomRegistry.make();
  return {
    ...(await importOriginal<typeof import("@effect/atom-react")>()),
    useAtomValue: (atom: Atom.Atom<unknown>) => registry.get(atom),
  };
});
vi.mock("./session", () => ({
  environmentSession: {},
  useEnvironmentsWithScope: (
    environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
    scope: AuthEnvironmentScope,
  ) => new Set(state.scopes.includes(scope) ? environments.map((e) => e.environmentId) : []),
}));
vi.mock("./orchestration", () => ({
  orchestrationEnvironment: {
    threadSearch: (target: unknown) => {
      state.searchRequests.push(target);
      return Atom.make(
        state.refused
          ? AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  message: "Refused",
                  requiredScope: "orchestration:read",
                }),
              ),
            )
          : AsyncResult.success({ matches: [] }),
      );
    },
  },
}));
vi.mock("./threads", () => ({
  olderSettledThreads: { olderSettledAtom: () => Atom.make(null) },
  threadFamilies: {},
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("./projects", () => ({ projectEnvironment: {}, projectContentSearch: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({ useEnvironmentQuery: vi.fn() }));

import { useThreadSearch } from "./queries";

const environmentId = EnvironmentId.make("test-environment");

it.each([
  { who: "a teammate", scopes: [AuthKinChatScope], refused: true, asked: 0, failed: false },
  {
    who: "the owner",
    scopes: [AuthOrchestrationReadScope],
    refused: false,
    asked: 1,
    failed: false,
  },
  {
    who: "the owner, refused",
    scopes: [AuthOrchestrationReadScope],
    refused: true,
    asked: 1,
    failed: true,
  },
])(
  "searches thread messages only where the session may read threads: $who",
  ({ who, scopes, refused, asked, failed }) => {
    state.scopes = scopes;
    state.refused = refused;
    state.searchRequests = [];
    const result = useThreadSearch([environmentId], `invoice for ${who}`);

    expect(state.searchRequests).toHaveLength(asked);
    expect(result.failed).toBe(failed);
    expect(result.isPending).toBe(false);
  },
);
