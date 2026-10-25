import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as AgentProfileService from "./AgentProfileService.ts";
import { serializeProfileDocument } from "./profileDocument.ts";

const withProfiles = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(AgentProfileService.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

describe("AgentProfileService", () => {
  it.effect("lets a project profile replace the user and shipped copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const project = yield* fs.makeTempDirectoryScoped();
      const profiles = yield* withProfiles(home, AgentProfileService.AgentProfileService);
      const shipped = yield* profiles.resolve({ name: "reviewer" });
      assert.equal(shipped.source, "default");
      assert.equal(shipped.crownable, false);

      yield* profiles.writeSource({
        scope: "user",
        text: serializeProfileDocument({
          ...shipped,
          body: "User reviewer.",
        }),
      });
      const user = yield* profiles.resolve({ name: "reviewer", projectRoot: project });
      assert.equal(user.source, "user");
      assert.equal(user.body, "User reviewer.");

      yield* profiles.writeSource({
        scope: "project",
        projectRoot: project,
        text: serializeProfileDocument({
          ...shipped,
          body: "Project reviewer.",
        }),
      });
      const projectProfile = yield* profiles.resolve({ name: "reviewer", projectRoot: project });
      assert.equal(projectProfile.source, "project");
      assert.equal(projectProfile.body, "Project reviewer.");
      assert.equal((yield* profiles.resolve({ name: "reviewer" })).body, "User reviewer.");

      const saved = yield* profiles.saveAdhoc({
        projectRoot: project,
        inline: { prompt: "Check this one failure." },
      });
      const again = yield* profiles.saveAdhoc({
        projectRoot: project,
        inline: { prompt: "Check this one failure." },
      });
      assert.equal(saved.name, again.name);
      assert.isTrue(
        yield* fs.exists(path.join(project, ".kin", "agents", "_adhoc", `${saved.name}.md`)),
      );
      const listed = yield* profiles.list({ projectRoot: project });
      assert.isTrue(
        listed.some((profile) => profile.name === saved.name && profile.source === "adhoc"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes a profile write to subscribers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const profiles = yield* withProfiles(home, AgentProfileService.AgentProfileService);
      const seen = yield* Deferred.make<string>();
      yield* profiles.changes().pipe(
        Stream.take(1),
        Stream.runForEach((name) => Deferred.succeed(seen, name).pipe(Effect.ignore)),
        Effect.forkScoped,
      );
      const directory = path.join(home, ".kin", "agents");
      yield* fs.exists(directory).pipe(Effect.repeat({ until: (exists) => exists }));
      yield* Effect.yieldNow;
      const shipped = yield* profiles.resolve({ name: "main" });
      yield* profiles.writeSource({
        scope: "user",
        text: serializeProfileDocument({ ...shipped, body: "Main, rewritten." }),
      });
      assert.equal(yield* Deferred.await(seen).pipe(Effect.timeout("2 seconds")), "main");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
