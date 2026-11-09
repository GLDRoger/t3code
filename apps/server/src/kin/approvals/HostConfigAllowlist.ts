/**
 * What the Kin host's SSH config, git config and environment may contain (spec section 12).
 * Anything else fails the identity probe closed: listing every place a credential can hide can't
 * be finished, so the probe proves the setup is minimal instead. Reasons name a directive, key or
 * variable, never its value.
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
 * What distro system configs ship, allowed in system files only. macOS: `SendEnv` and the crypto
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

/** ssh_config's keywords, for naming one in a reason. Anything else could be a pasted secret. */
const SSH_KEYWORDS = `
  AddKeysToAgent AddressFamily BatchMode BindAddress BindInterface CASignatureAlgorithms
  CanonicalDomains CanonicalizeFallbackLocal CanonicalizeHostname CanonicalizeMaxDots
  CanonicalizePermittedCNAMEs CertificateFile ChannelTimeout CheckHostIP Ciphers
  ClearAllForwardings Compression ConnectTimeout ConnectionAttempts ControlMaster ControlPath
  ControlPersist DynamicForward EnableEscapeCommandline EnableSSHKeysign EscapeChar
  ExitOnForwardFailure FingerprintHash ForkAfterAuthentication ForwardAgent ForwardX11
  ForwardX11Timeout ForwardX11Trusted GSSAPIAuthentication GSSAPIDelegateCredentials
  GatewayPorts GlobalKnownHostsFile HashKnownHosts Host HostKeyAlgorithms HostKeyAlias HostName
  HostbasedAcceptedAlgorithms HostbasedAuthentication IPQoS IdentitiesOnly IdentityAgent
  IdentityFile IgnoreUnknown Include KbdInteractiveAuthentication KbdInteractiveDevices
  KexAlgorithms KnownHostsCommand LocalCommand LocalForward LogLevel LogVerbose MACs Match
  NoHostAuthenticationForLocalhost NoHostAuthenticationForProxyCommand NumberOfPasswordPrompts
  ObscureKeystrokeTiming PKCS11Provider PasswordAuthentication PermitLocalCommand
  PermitRemoteOpen Port PreferredAuthentications ProxyCommand ProxyJump ProxyUseFdpass
  PubkeyAcceptedAlgorithms PubkeyAuthentication RefuseConnection RekeyLimit RemoteCommand
  RemoteForward RequestTTY RequiredRSASize RevokedHostKeys SecurityKeyProvider SendEnv
  ServerAliveCountMax ServerAliveInterval SessionType SetEnv StdinNull StreamLocalBindMask
  StreamLocalBindUnlink StrictHostKeyChecking SyslogFacility TCPKeepAlive Tag Tunnel
  TunnelDevice UpdateHostKeys UseKeychain User UserKnownHostsFile VerifyHostKeyDNS
  VersionAddendum VisualHostKey WarnWeakCrypto XAuthLocation
`
  .split(/\s+/)
  .filter((name) => name !== "");
const sshName = (keyword: string) =>
  SSH_KEYWORDS.find((name) => name.toLowerCase() === keyword) ?? "an unrecognised directive";

/**
 * A line's arguments: whitespace splits them, a double-quoted argument may hold spaces, and a `#`
 * argument ends the line. Null on single quotes, backslashes, or a quote or `#` inside an
 * argument, which ssh's `argv_split` reads in ways this doesn't follow.
 */
const splitSshArgs = (text: string): Array<string> | null => {
  const args: Array<string> = [];
  for (let index = 0; index < text.length;) {
    if (/\s/.test(text[index]!)) {
      index += 1;
      continue;
    }
    if (text[index] === "#") break;
    const quoted = text[index] === '"';
    const end = quoted ? text.indexOf('"', index + 1) : text.slice(index).search(/\s|$/) + index;
    if (end === -1) return null;
    const arg = quoted ? text.slice(index + 1, end) : text.slice(index, end);
    if (/['\\]/.test(arg) || (!quoted && /["#]/.test(arg))) return null;
    index = quoted ? end + 1 : end;
    if (quoted && index < text.length && !/\s/.test(text[index]!)) return null;
    args.push(arg);
  }
  return args;
};

/**
 * Splits a config file as ssh's `readconf.c` does: `keyword args` or `keyword=args`, with
 * `splitSshArgs` for the arguments. Null when a line can't be read that way.
 */
export const parseSshConfig = (text: string): ReadonlyArray<SshDirective> | null => {
  const directives: Array<SshDirective> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([^\s="]+)(?:\s*=\s*|\s+|$)(.*)$/.exec(line);
    if (match === null) return null;
    const args = splitSshArgs(match[2]!);
    if (args === null) return null;
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

/** Pulls the files ssh read from `ssh -v -G` output, using only its `Reading configuration data` lines. */
export const sshConfigPaths = (output: string): ReadonlyArray<string> =>
  [...output.matchAll(/^debug1: Reading configuration data (\/.*)$/gm)].map((match) => match[1]!);

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
/**
 * Refused because each decides how git authenticates or reaches a server (`askPass`, `sshCommand`,
 * `gitProxy`) or runs a program on ordinary commands the agent didn't ask for (`fsmonitor`,
 * `hooksPath`), so a credential could be picked without the agent choosing one.
 */
const CORE_REFUSED = new Set([
  "core.askpass",
  "core.sshcommand",
  "core.gitproxy",
  "core.fsmonitor",
  "core.hookspath",
]);
/**
 * Allowed keys in every scope git reads from `/`, matched from the start of the key. None picks a
 * credential. Some run a program the agent asks for (`core.pager`, `diff.external`,
 * `merge.*.driver`, `!` aliases, the LFS filter); they're allowed because the agent could run that
 * program anyway, not because they run nothing.
 */
const GIT_ALLOWED: ReadonlyArray<RegExp> = [
  // Commit identity.
  /^user\./,
  // Local repository behaviour; the keys above are refused.
  /^core\./,
  // `init.templateDir` would copy its config and hooks into every new repository.
  /^init\.defaultbranch$/,
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

type GitConfigVerdict<Allowed> =
  | { readonly _tag: "refused"; readonly reason: string }
  | ({ readonly _tag: "allowed" } & Allowed);

/** The origin check every scope shares: files only, plus what `VcsProcess` sets on every run. */
const originRefusal = ({ origin, key, value }: GitConfigEntry): string | null | undefined => {
  if (origin === "command line:") {
    // The check fails on any other `GIT_CONFIG_*` variable, so only `VcsProcess` sets these.
    return key === "safe.barerepository" && value === "explicit"
      ? null
      : "git config is set from the environment";
  }
  return origin.startsWith("file:") ? undefined : "git config comes from an unexpected source";
};

/**
 * Checks every entry git reads from `/`, in order: a forbidden key's reason, or how many credential
 * helpers git would call for `https://github.com` (an empty value resets the list, as in git).
 */
export const checkGitConfig = (
  entries: ReadonlyArray<GitConfigEntry>,
): GitConfigVerdict<{ readonly helpers: number }> => {
  let helpers = 0;
  for (const entry of entries) {
    const refusal = originRefusal(entry);
    if (refusal === null) continue;
    if (refusal !== undefined) return { _tag: "refused", reason: refusal };
    const { key, value } = entry;
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

/**
 * Whether a remote or submodule URL could carry a credential: any `<transport>::` remote helper
 * (`ext::` runs a command, `fd::` uses an open socket), or userinfo on an HTTP or FTP URL, or a
 * password on any other. `git@github.com:o/r` and `ssh://git@github.com/o/r` name only the ssh user.
 */
const urlCarriesCredential = (value: string | null) => {
  if (value === null) return true;
  const url = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return true;
  const parsed = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (parsed === null) return false;
  const at = parsed[2]!.lastIndexOf("@");
  if (at === -1) return false;
  return /^(https?|ftps?)$/i.test(parsed[1]!) || parsed[2]!.slice(0, at).includes(":");
};

/** `remote.<name>.*` keys that only shape fetch and push: no program, helper or proxy. */
const REMOTE_PLAIN = new Set([
  "fetch",
  "push",
  "mirror",
  "skipdefaultupdate",
  "skipfetchall",
  "tagopt",
  "prune",
  "prunetags",
  "promisor",
  "partialclonefilter",
]);
const GIT_TRUE = /^(true|yes|on|1)$/i;

/**
 * Checks a repository's own config (`--local`, or `--worktree`) against the stricter repository
 * allowlist: whether git reads a `config.worktree` too, or the first forbidden key's reason.
 */
export const checkRepoGitConfig = (
  entries: ReadonlyArray<GitConfigEntry>,
): GitConfigVerdict<{ readonly worktreeConfig: boolean }> => {
  let worktreeConfig = false;
  for (const entry of entries) {
    const refusal = originRefusal(entry);
    if (refusal === null) continue;
    if (refusal !== undefined) return { _tag: "refused", reason: refusal };
    const { key, value } = entry;
    const refused = {
      _tag: "refused",
      reason: `repository config sets ${gitKeyName(key)}`,
    } as const;
    const section = key.slice(0, key.indexOf("."));
    const name = key.slice(key.lastIndexOf(".") + 1);
    const subsection = key.indexOf(".") !== key.lastIndexOf(".");
    if (section === "core") {
      if (CORE_REFUSED.has(key)) return refused;
    } else if (key === "extensions.worktreeconfig") {
      worktreeConfig = value === null || GIT_TRUE.test(value.trim());
    } else if (section === "remote") {
      // `remote.pushDefault` names a remote and has no subsection.
      const url = name === "url" || name === "pushurl";
      if (subsection && (url ? urlCarriesCredential(value) : !REMOTE_PLAIN.has(name)))
        return refused;
    } else if (section === "submodule" && subsection) {
      if (name === "url" ? urlCarriesCredential(value) : name !== "active") return refused;
    } else if (
      // A repository's own commit identity and storage format pick no credential.
      section !== "branch" &&
      section !== "user" &&
      key !== "extensions.objectformat" &&
      key !== "extensions.refstorage" &&
      key !== "lfs.repositoryformatversion"
    ) {
      return refused;
    }
  }
  return { _tag: "allowed", worktreeConfig };
};

// Variables git, gh and ssh read, and tokens for anything: each can pick a credential.
const ENV_REFUSED = /^(GH|GITHUB|GIT|SSH)_|_TOKEN$/i;
/**
 * Allowed despite the pattern. `GIT_TERMINAL_PROMPT` only turns git's prompt on or off. T3 sets the
 * other two itself: they authenticate to T3, never to GitHub.
 */
const ENV_EXCEPTIONS = new Set([
  "GIT_TERMINAL_PROMPT",
  "T3_MCP_BEARER_TOKEN",
  "T3CODE_DEV_AUTH_TOKEN",
]);

/** The forbidden variables `env` sets to something, by name, sorted. Values are never read out. */
export const forbiddenEnvNames = (env: Readonly<Record<string, string | undefined>>) =>
  Object.entries(env)
    .filter(
      ([name, value]) =>
        (value?.trim() ?? "") !== "" &&
        ENV_REFUSED.test(name) &&
        !ENV_EXCEPTIONS.has(name.toUpperCase()),
    )
    .map(([name]) => (/^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "a variable with an unusual name"))
    .toSorted();
