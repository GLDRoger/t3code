import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Project, v2ShellSnapshot } from "../state/orchestrationV2TestFixtures.ts";
import { createEnvironmentProjectAtoms } from "../state/projectEntities.ts";

const environmentId = EnvironmentId.make("local");
const leadProjectId = ProjectId.make("kin:org-ambermill:agent-finance");

describe("a Kin lead's memory project", () => {
  it("is left out of the project list every coding view reads, and still opens by ref", () => {
    const projects = createEnvironmentProjectAtoms({
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([
          [
            environmentId,
            {
              target: new PrimaryConnectionTarget({
                environmentId,
                label: "local",
                httpBaseUrl: "https://local.example.test",
                wsBaseUrl: "wss://local.example.test",
              }),
              profile: Option.none(),
              enabled: true,
            },
          ],
        ]),
      }),
      snapshotAtom: () =>
        Atom.make({
          ...v2ShellSnapshot,
          projects: [
            { ...v2Project, id: ProjectId.make("ambermill-site"), workspaceRoot: "/repo" },
            { ...v2Project, id: leadProjectId, workspaceRoot: "/memory/finance" },
          ],
        }),
    });
    const registry = AtomRegistry.make();
    try {
      expect(registry.get(projects.projectsAtom).map((project) => project.id)).toEqual([
        "ambermill-site",
      ]);
      expect(
        registry.get(projects.projectAtom({ environmentId, projectId: leadProjectId }))?.id,
      ).toBe(leadProjectId);
    } finally {
      registry.dispose();
    }
  });
});
