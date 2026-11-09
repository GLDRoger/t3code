import type { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { VcsProcess } from "../../vcs/VcsProcess.ts";

export interface PurgeRefUpdate {
  readonly ref: string;
  readonly old: string;
  readonly new: string | null;
}

export class KinPurgePushError extends Schema.TaggedError<KinPurgePushError>()(
  "KinPurgePushError",
  {
    reason: Schema.Literals([
      "credential_unavailable",
      "unsupported_remote",
      "lease_rejected",
      "remote_rejected",
      "rejected",
      "auth",
      "network",
      "timeout",
      "unknown",
    ]),
  },
) {}
export class KinPurgePush extends Context.Service<
  KinPurgePush,
  {
    readonly push: (input: {
      readonly orgId: KinOrgId;
      readonly repoUrl: string;
      readonly gitDir: string;
      readonly updates: ReadonlyArray<PurgeRefUpdate>;
    }) => Effect.Effect<void, KinPurgePushError>;
    /** Every ref the remote advertises, read with the same owner credential as `push`. */
    readonly listRefs: (input: {
      readonly orgId: KinOrgId;
      readonly repoUrl: string;
    }) => Effect.Effect<ReadonlyArray<string>, KinPurgePushError>;
  }
>()("t3/kin/memory/purgePush/KinPurgePush") {}

/** Inherited `GIT_*` variables can point git at another repository, config or object store. */
export const scrubbedGitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => /^GIT_/i.test(name))
      .map((name) => [name, undefined]),
  );
export const hardenedGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_ASKPASS: "",
};
const pushFailure = (stdout: string, stderr: string): KinPurgePushError["reason"] => {
  const rejected = stdout.split("\n").filter((line) => line.startsWith("!"));
  if (rejected.some((line) => line.includes("(stale info)"))) return "lease_rejected";
  if (rejected.some((line) => line.includes("[remote rejected]"))) return "remote_rejected";
  if (rejected.length > 0) return "rejected";
  if (
    /authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|returned error: 40[13]/i.test(
      stderr,
    )
  )
    return "auth";
  if (
    /could not resolve host|connection (refused|reset|timed out)|operation timed out|network is unreachable|unable to access|early eof/i.test(
      stderr,
    )
  )
    return "network";
  return "unknown";
};

// A helper name or absolute path, never an inline `!` script that could carry the secret itself.
export const isCredentialHelperReference = (helper: string) =>
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\/[A-Za-z0-9._/-]+)$/.test(helper);
// Options that run commands, load another config or weaken host checks win over the hardening below.
const sshOverride =
  /(?:^|\s)-(?:[FJSEWw]|o\s*(?:ProxyCommand|ProxyJump|ProxyUseFdpass|LocalCommand|PermitLocalCommand|KnownHostsCommand|Include|StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|IdentityAgent|ControlPath|ControlMaster|RemoteCommand|BatchMode)\b)/i;
/** `ssh` (or an absolute path to it) with plain arguments, so the command names a key, never holds one. */
export const isSshCommandReference = (command: string) =>
  /^[A-Za-z0-9 ._/=,:@+-]+$/.test(command) &&
  /^(?:ssh|\/[A-Za-z0-9._/-]*\/ssh)(?:\s|$)/.test(command) &&
  !sshOverride.test(command);
/** Appended to every owner SSH command: no host config, no prompts, no agent keys. */
export const SSH_HARDENING = "-F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none";
/** `file://` carries no credential; https needs the helper and SSH the owner's command. */
const remoteKind = (url: string) =>
  /^https:\/\//i.test(url)
    ? "https"
    : /^ssh:\/\//i.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)/.test(url)
      ? "ssh"
      : /^file:\/\//i.test(url)
        ? "file"
        : undefined;

/**
 * Pushes and lists refs with a reference to the owner's credential: a git credential helper or an SSH command naming
 * its key file. The secret never enters argv or env, and with neither configured the push fails closed.
 */
export const gitPushLayer = (owner: {
  readonly credentialHelper?: string;
  readonly sshCommand?: string;
}) =>
  Layer.effect(
    KinPurgePush,
    Effect.gen(function* () {
      const vcs = yield* VcsProcess;
      const fs = yield* FileSystem.FileSystem;
      /** Runs git against the remote with only the owner's credential reference, in a scratch HOME. */
      const run = Effect.fn("KinPurgePush.run")(function* (
        repoUrl: string,
        args: ReadonlyArray<string>,
        cwd?: string,
      ) {
        const { credentialHelper, sshCommand } = owner;
        if (
          (credentialHelper === undefined && sshCommand === undefined) ||
          (credentialHelper !== undefined && !isCredentialHelperReference(credentialHelper)) ||
          (sshCommand !== undefined && !isSshCommandReference(sshCommand))
        )
          return yield* new KinPurgePushError({ reason: "credential_unavailable" });
        const kind = remoteKind(repoUrl);
        if (kind === undefined)
          return yield* new KinPurgePushError({ reason: "unsupported_remote" });
        if (
          (kind === "https" && credentialHelper === undefined) ||
          (kind === "ssh" && sshCommand === undefined)
        )
          return yield* new KinPurgePushError({ reason: "credential_unavailable" });
        // An empty HOME keeps curl's `.netrc` out; `-F none` keeps `~/.ssh/config` out.
        const home = yield* fs
          .makeTempDirectoryScoped({ prefix: "kin-push-home-" })
          .pipe(Effect.mapError(() => new KinPurgePushError({ reason: "unknown" })));
        const result = yield* vcs
          .run({
            operation: "KinPurgePush.git",
            command: "git",
            cwd: cwd ?? home,
            args: [
              "--no-replace-objects",
              ...(cwd ? [`--git-dir=${cwd}/.git`] : []),
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.attributesFile=/dev/null",
              "-c",
              "protocol.file.allow=user",
              "-c",
              "credential.helper=",
              ...(credentialHelper ? ["-c", `credential.helper=${credentialHelper}`] : []),
              ...args,
            ],
            env: {
              ...scrubbedGitEnv(),
              ...hardenedGitEnv,
              HOME: home,
              XDG_CONFIG_HOME: home,
              GIT_ASKPASS: "false",
              SSH_ASKPASS: "false",
              SSH_ASKPASS_REQUIRE: "never",
              SSH_AUTH_SOCK: undefined,
              GCM_INTERACTIVE: "never",
              // Without an owner SSH command, refuse SSH instead of using the host's keys or agent.
              GIT_SSH_COMMAND: sshCommand ? `${sshCommand} ${SSH_HARDENING}` : "false",
            },
            allowNonZeroExit: true,
            maxOutputBytes: 16 * 1024 * 1024,
            timeoutMs: 600_000,
          })
          .pipe(
            // The cause can echo the remote URL or helper output; keep both out of errors and logs.
            Effect.mapError(
              (error) =>
                new KinPurgePushError({
                  reason: error._tag === "VcsProcessTimeoutError" ? "timeout" : "unknown",
                }),
            ),
          );
        if (Number(result.exitCode) !== 0)
          return yield* new KinPurgePushError({
            reason: pushFailure(result.stdout, result.stderr),
          });
        return result.stdout;
      });
      return KinPurgePush.of({
        push: Effect.fn("KinPurgePush.git")(function* ({ repoUrl, gitDir, updates }) {
          yield* run(
            repoUrl,
            [
              "push",
              "--atomic",
              "--porcelain",
              ...updates.map((update) => `--force-with-lease=${update.ref}:${update.old}`),
              "--",
              repoUrl,
              ...updates.map((update) => `${update.new ?? ""}:${update.ref}`),
            ],
            gitDir,
          );
        }, Effect.scoped),
        listRefs: Effect.fn("KinPurgePush.listRefs")(function* ({ repoUrl }) {
          const stdout = yield* run(repoUrl, ["ls-remote", "--", repoUrl]);
          return stdout.split("\n").flatMap((line) => {
            const ref = line.split("\t")[1];
            return ref ? [ref] : [];
          });
        }, Effect.scoped),
      });
    }),
  );
