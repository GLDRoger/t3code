/**
 * What the Kin host's SSH and git config may contain (spec section 12). Anything else fails the
 * identity probe closed: listing every place a credential can hide can't be finished, so the probe
 * proves the setup is minimal instead. Reasons name a directive or key, never its value.
 */

export interface SshDirective {
  /** Lower case: ssh reads directive names case-insensitively. */
  readonly keyword: string;
  readonly args: ReadonlyArray<string>;
}

const any = () => true;
const only = (value: string) => (args: ReadonlyArray<string>) =>
  args.length === 1 && args[0] === value;

/** Allowed directives, by lower-case name, with the arguments each may take. */
const SSH_ALLOWED: Record<string, (args: ReadonlyArray<string>) => boolean> = {
  // Which host and key: every IdentityFile under every Host is probed, so an alias hides nothing.
  host: any,
  hostname: any,
  user: any,
  port: any,
  identityfile: any,
  identitiesonly: any,
  // Host key checks decide whether ssh connects, not as whom.
  stricthostkeychecking: any,
  userknownhostsfile: any,
  // The probe reads each included file against this same list.
  include: any,
  // Agents and shared connections answer with keys the probe can't list.
  addkeystoagent: only("no"),
  identityagent: only("none"),
  controlmaster: only("no"),
  controlpath: only("none"),
  // Connection tuning.
  serveraliveinterval: any,
  serveralivecountmax: any,
  connecttimeout: any,
  compression: any,
};

/**
 * What distro system configs ship, allowed in `/etc/ssh` only. macOS: `SendEnv` and the crypto
 * policy's algorithm lists; Debian and Ubuntu: `HashKnownHosts` and `GSSAPIAuthentication`
 * (GitHub takes no GSSAPI login). Algorithm lists and forwarded locale variables add no identity.
 */
const SSH_SYSTEM_ALLOWED = new Set([
  "sendenv",
  "ciphers",
  "kexalgorithms",
  "macs",
  "hostkeyalgorithms",
  "pubkeyacceptedalgorithms",
  "casignaturealgorithms",
  "hostbasedacceptedalgorithms",
  "hashknownhosts",
  "gssapiauthentication",
]);

/** Spellings for reasons; any other directive is named only if it can't be a pasted secret. */
const SSH_NAMES = [
  "AddKeysToAgent",
  "CertificateFile",
  "ControlMaster",
  "ControlPath",
  "ControlPersist",
  "IdentityAgent",
  "KnownHostsCommand",
  "LocalCommand",
  "Match",
  "PermitLocalCommand",
  "PKCS11Provider",
  "ProxyCommand",
  "ProxyJump",
  "RemoteCommand",
  "SecurityKeyProvider",
];
const sshName = (keyword: string) =>
  SSH_NAMES.find((name) => name.toLowerCase() === keyword) ??
  (/^[a-z]{1,32}$/.test(keyword) ? keyword : "an unrecognised directive");

/**
 * Splits a config file as ssh's `readconf.c` does: `keyword args` or `keyword=args`, double quotes
 * group an argument, and a `#` token ends the line. Null when a line has no keyword.
 */
export const parseSshConfig = (text: string): ReadonlyArray<SshDirective> | null => {
  const directives: Array<SshDirective> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([^\s="]+)(?:\s*=\s*|\s+|$)(.*)$/.exec(line);
    if (match === null) return null;
    const args: Array<string> = [];
    for (const token of match[2]!.matchAll(/"([^"]*)"|(\S+)/g)) {
      if (token[2]?.startsWith("#") === true) break;
      args.push(token[1] ?? token[2]!);
    }
    directives.push({ keyword: match[1]!.toLowerCase(), args });
  }
  return directives;
};

/** Why `directive` fails the allowlist, or undefined when it's allowed. */
export const sshViolation = (directive: SshDirective, system: boolean): string | undefined => {
  const allowed = SSH_ALLOWED[directive.keyword];
  if (allowed?.(directive.args) === true) return undefined;
  if (allowed === undefined && system && SSH_SYSTEM_ALLOWED.has(directive.keyword))
    return undefined;
  const name = sshName(directive.keyword);
  return allowed === undefined
    ? `sets ${name}`
    : `sets ${name} to a value other than the allowed one`;
};

/**
 * Expands an `IdentityFile` as ssh would for the server's OS user. Only `~/`, `%d`, `%u`, `%i` and
 * `%%` are allowed: host tokens, `${VAR}` and `~user` depend on more than this user. Undefined when
 * the value uses anything else or stays relative, which ssh would resolve against the agent's cwd.
 */
export const expandIdentityFile = (
  value: string,
  user: { readonly home: string; readonly username: string | null; readonly userId?: number },
): string | undefined => {
  if (value.includes("${")) return undefined;
  const tokens: Record<string, string | undefined> = {
    "%": "%",
    d: user.home,
    u: user.username ?? undefined,
    i: user.userId === undefined ? undefined : String(user.userId),
  };
  let known = true;
  const tilde = value === "~" || value.startsWith("~/") ? user.home + value.slice(1) : value;
  const expanded = tilde.replace(/%(.?)/g, (_, token: string) => {
    const replacement = tokens[token];
    if (replacement === undefined) known = false;
    return replacement ?? "";
  });
  return known && expanded.startsWith("/") ? expanded : undefined;
};

export interface GitConfigEntry {
  readonly origin: string;
  /** As `git config --list` prints it: section and name lower case, the subsection as written. */
  readonly key: string;
  /** Null for a bare boolean key such as `[core] bare`. */
  readonly value: string | null;
}

/** Reads `git config --list --show-origin -z`: `origin NUL key LF value NUL`, or `key NUL` alone. */
export const parseGitConfigList = (stdout: string): ReadonlyArray<GitConfigEntry> | null => {
  const fields = stdout.split("\0");
  if (fields.at(-1) !== "") return null;
  fields.pop();
  if (fields.length % 2 !== 0) return null;
  const entries: Array<GitConfigEntry> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const entry = fields[index + 1]!;
    const newline = entry.indexOf("\n");
    entries.push({
      origin: fields[index]!,
      key: newline === -1 ? entry : entry.slice(0, newline),
      value: newline === -1 ? null : entry.slice(newline + 1),
    });
  }
  return entries;
};

const HELPER_KEYS = new Set(["credential.helper", "credential.https://github.com.helper"]);
// Each runs a program for transport or on every repository command, outside what the probe sees.
const CORE_REFUSED = new Set([
  "core.askpass",
  "core.sshcommand",
  "core.gitproxy",
  "core.fsmonitor",
  "core.hookspath",
]);
/** Allowed keys, matched from the start of the key. */
const GIT_ALLOWED: ReadonlyArray<RegExp> = [
  // Commit identity.
  /^user\./,
  // Local repository behaviour; its transport and hook keys are refused above.
  /^core\./,
  // New repository and output defaults.
  /^init\./,
  /^color\./,
  // Shorthands for commands the agent could run anyway.
  /^alias\./,
  // How git integrates and pushes, not which credential it uses.
  /^(pull|push|fetch|merge|diff)\./,
  // What `git lfs install` writes.
  /^filter\.lfs\./,
];

const gitKeyName = (key: string) => {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  const section = key.slice(0, first);
  const name = key.slice(last + 1);
  // The subsection can hold a URL with a token in it, so it is never named.
  const shown = first === last ? `${section}.${name}` : `${section}.*.${name}`;
  return /^[a-z0-9-]{1,32}(\.\*)?\.[a-z0-9-]{1,32}$/.test(shown) ? shown : "an unrecognised key";
};

/**
 * Checks every entry git reads from `/`, in order: a forbidden key's reason, or how many credential
 * helpers git would call for `https://github.com` (an empty value resets the list, as in git).
 */
export const checkGitConfig = (
  entries: ReadonlyArray<GitConfigEntry>,
):
  | { readonly _tag: "refused"; readonly reason: string }
  | { readonly _tag: "allowed"; readonly helpers: number } => {
  let helpers = 0;
  for (const { origin, key, value } of entries) {
    if (origin === "command line:") {
      // `VcsProcess` sets this on every run; the check fails on any other `GIT_CONFIG_*` variable.
      if (key === "safe.barerepository" && value === "explicit") continue;
      return { _tag: "refused", reason: "git config is set from the environment" };
    }
    if (!origin.startsWith("file:")) {
      return { _tag: "refused", reason: "git config comes from an unexpected source" };
    }
    if (HELPER_KEYS.has(key)) {
      helpers = value === null || value.trim() === "" ? 0 : helpers + 1;
      continue;
    }
    if (CORE_REFUSED.has(key) || !GIT_ALLOWED.some((pattern) => pattern.test(key))) {
      return { _tag: "refused", reason: `git config sets ${gitKeyName(key)}` };
    }
  }
  return { _tag: "allowed", helpers };
};
