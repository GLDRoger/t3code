import { ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { resolveProject, type Checkout, type HostProject } from "./workerProjects.ts";

const hostT3code = ProjectId.make("8a06d589-4c93-4710-be8b-7fe7ec417742");
const t3code: Checkout = {
  projectId: ProjectId.make("there-t3code"),
  title: "t3code",
  repositoryKey: "github.com/gldroger/t3code",
  slug: "GLDRoger/t3code",
};
const app: Checkout = {
  projectId: ProjectId.make("there-app"),
  title: "app",
  repositoryKey: "github.com/acme/app",
  slug: "acme/app",
};
const fork: Checkout = { ...app, projectId: ProjectId.make("there-fork"), slug: "fork/app" };
const checkouts = [t3code, app, { ...fork, repositoryKey: "github.com/fork/app" }];
const hostProjects: ReadonlyArray<HostProject> = [
  { projectId: hostT3code, title: "t3code", repositoryKey: "github.com/gldroger/t3code" },
  { projectId: ProjectId.make("home"), title: "kin", repositoryKey: undefined },
  {
    projectId: ProjectId.make("site"),
    title: "Marketing site",
    repositoryKey: "github.com/acme/site",
  },
];
const connectedRepos = ["GLDRoger/t3code", "acme/docs"];
const resolve = (named: string, allowed?: ReadonlyArray<ProjectId>) =>
  resolveProject({ named, checkouts, hostProjects, connectedRepos, allowed });

describe("resolveProject", () => {
  // The first two are what the host's Tech lead and Chief of staff passed on 9-10 Nov 2026.
  it.each([
    "t3code",
    "GLDRoger/t3code",
    "gldroger/T3Code",
    "https://github.com/GLDRoger/t3code.git",
    "git@github.com:GLDRoger/t3code.git",
    "github.com/GLDRoger/t3code/",
    hostT3code,
    "there-t3code",
  ])("%s names the t3code checkout", (named) => {
    assert.deepStrictEqual(resolve(named), {
      _tag: "resolved",
      checkout: t3code,
      hostProjectId: hostT3code,
    });
  });

  it("a full owner/name outranks a bare name that fits several checkouts", () => {
    assert.deepStrictEqual(resolve("app"), { _tag: "ambiguous", labels: ["acme/app", "fork/app"] });
    assert.deepStrictEqual(resolve("acme/app"), {
      _tag: "resolved",
      checkout: app,
      hostProjectId: null,
    });
  });

  it("a repo or project this host knows, with no checkout for workers, says so", () => {
    assert.deepStrictEqual(resolve("acme/docs"), { _tag: "no_checkout", label: "acme/docs" });
    assert.deepStrictEqual(resolve("marketing site"), {
      _tag: "no_checkout",
      label: "Marketing site",
    });
    assert.deepStrictEqual(resolve("nope"), {
      _tag: "unknown",
      labels: ["GLDRoger/t3code", "acme/app", "fork/app"],
    });
  });

  it("a request held to a list reaches only its projects and learns nothing of the rest", () => {
    assert.deepInclude(resolve("GLDRoger/t3code", [hostT3code]), {
      _tag: "resolved",
      hostProjectId: hostT3code,
    });
    for (const named of ["acme/app", "there-app", "acme/docs", "nope"])
      assert.deepStrictEqual(resolve(named, [hostT3code]), { _tag: "outside" });
    assert.deepStrictEqual(resolve("t3code", []), { _tag: "outside" });
  });
});
