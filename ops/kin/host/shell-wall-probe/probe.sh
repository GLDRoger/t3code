#!/bin/sh
# Checks the Claude shell wall on this host without a source checkout, a model or a provider CLI.
# It runs policy.json (the owner seat's sandbox settings, pinned by
# apps/server/src/kin/claudeConfinement.test.ts) through Anthropic's sandbox runtime against
# stand-in files it makes in an empty scratch folder. It reads and removes nothing outside that
# folder and needs no sudo. It fetches the pinned runtime and checks the network allowlist.
# Usage, as the service user: sh probe.sh <empty scratch folder>
set -eu

usage() {
  echo "probe: $1" >&2
  echo "usage: sh probe.sh <empty scratch folder>" >&2
  exit 2
}
[ $# -eq 1 ] || usage "give one scratch folder"
[ -d "$1" ] || usage "$1 is not a folder"
[ -z "$(ls -A "$1")" ] || usage "$1 is not empty"
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(CDPATH='' cd -- "$1" && pwd -P)
case $root in *[!A-Za-z0-9/._-]*) usage "use a scratch path of letters, digits and / . _ -" ;; esac

missing=""
for tool in node npm curl gh; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
if [ "$(uname -s)" = Linux ]; then
  # The standalone runtime finds nested git folders with ripgrep; Claude Code bundles its own.
  for tool in bwrap socat rg; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
fi
if [ -n "$missing" ]; then
  echo "FAIL tools present: missing$missing"
  echo "PROBE FAIL"
  exit 1
fi

home=$root/home
state=$home/.t3/userdata
temp=$state/kin-session-tmp/session-own
runtime=$temp/runtime
mkdir -p "$root/npm-home" "$runtime"
: >"$root/npmrc"
: >"$root/npmrc-global"
cat >"$runtime/package.json" <<'JSON'
{"name":"kin-shell-wall-probe","private":true,"dependencies":{"@anthropic-ai/sandbox-runtime":"0.0.83"},"overrides":{"node-forge":"1.4.3"}}
JSON
# The same versions and integrity hashes as the repository's pnpm-lock.yaml.
cat >"$runtime/package-lock.json" <<'JSON'
{
  "name": "kin-shell-wall-probe",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "kin-shell-wall-probe",
      "dependencies": { "@anthropic-ai/sandbox-runtime": "0.0.83" }
    },
    "node_modules/@anthropic-ai/sandbox-runtime": {
      "version": "0.0.83",
      "resolved": "https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.83.tgz",
      "integrity": "sha512-yEusORnVJrNseF/9fvjVYyk6tr79/aFbIB3T/X8p2puLZdaaiGNeYN50v0CE+1DT70v7XuzKOAnTivh1f5cksA==",
      "dependencies": {
        "@pondwader/socks5-server": "^1.0.10",
        "commander": "^12.1.0",
        "node-forge": "^1.4.0",
        "zod": "^3.25.0"
      },
      "engines": { "node": ">=22.12.0" },
      "peerDependencies": { "@microsoft/mxc-sdk": "^1.0.1" },
      "peerDependenciesMeta": { "@microsoft/mxc-sdk": { "optional": true } }
    },
    "node_modules/@pondwader/socks5-server": {
      "version": "1.0.10",
      "resolved": "https://registry.npmjs.org/@pondwader/socks5-server/-/socks5-server-1.0.10.tgz",
      "integrity": "sha512-bQY06wzzR8D2+vVCUoBsr5QS2U6UgPUQRmErNwtsuI6vLcyRKkafjkr3KxbtGFf9aBBIV2mcvlsKD1UYaIV+sg=="
    },
    "node_modules/commander": {
      "version": "12.1.0",
      "resolved": "https://registry.npmjs.org/commander/-/commander-12.1.0.tgz",
      "integrity": "sha512-Vw8qHK3bZM9y/P10u3Vib8o/DdkvA2OtPtZvD871QKjy74Wj1WSKFILMPRPSdUSx5RFK1arlJzEtA4PkFgnbuA=="
    },
    "node_modules/node-forge": {
      "version": "1.4.3",
      "resolved": "https://registry.npmjs.org/node-forge/-/node-forge-1.4.3.tgz",
      "integrity": "sha512-P6wzfh6t70avmV8FrVEAd/36sOPJQ+hkaJVX1Laap9J/77m7M0eyozDvc8SwnDf4P7MP94gwbAAo0rg3YVXT+g=="
    },
    "node_modules/zod": {
      "version": "3.25.76",
      "resolved": "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz",
      "integrity": "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ=="
    }
  }
}
JSON
if ! (cd "$runtime" && HOME="$root/npm-home" TMPDIR="$temp" \
  npm_config_userconfig="$root/npmrc" npm_config_globalconfig="$root/npmrc-global" \
  npm_config_cache="$root/npm-cache" npm_config_update_notifier=false \
  npm ci --ignore-scripts --no-audit --no-fund >"$root/npm.log" 2>&1); then
  echo "FAIL pinned runtime installed: see $root/npm.log"
  echo "PROBE FAIL"
  exit 1
fi

# The stand-ins, laid out as policy.json names them under __ROOT__.
put() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
checkout=$state/kin/acme/read
put "$checkout/notes.md" "probe checkout file"
put "$checkout/.git/HEAD" "ref: refs/heads/main"
put "$checkout/.git/config" "[core]"
put "$state/secrets/server-signing-key.bin" "PROBE-STAND-IN"
put "$state/statev2.sqlite" "PROBE-STAND-IN"
put "$state/attachments/kin-chat-given.txt" "given"
put "$state/kin/gh-app/agent-posts.log" ""
put "$state/kin/gh-app/owner-uses.log" ""
put "$home/.ssh/id_ed25519" "PROBE-STAND-IN"
put "$home/ordinary-private-file" "PROBE-STAND-IN"
put "$state/kin-session-tmp/session-other/note" "PROBE-STAND-IN"
put "$state/kin-session-tmp/session-own/note" "own temporary file"
mkdir -p "$root/tools" "$home/.local/share/mise/installs/node/fixture/bin"
cp "$(command -v gh)" "$root/tools/gh"
cp "$(node -p 'process.execPath')" "$home/.local/share/mise/installs/node/fixture/bin/node"

cat >"$root/runner.mjs" <<'JS'
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const [root, policyFile] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyFile, "utf8").replaceAll("__ROOT__", root));
const home = path.join(root, "home");
const state = path.join(home, ".t3", "userdata");
const checkout = path.join(state, "kin", "acme", "read");
const outside = path.join(home, "probe-write");
const socket = path.join(checkout, "probe.sock");
const temp = path.join(state, "kin-session-tmp", "session-own");
const { SandboxManager, SandboxRuntimeConfigSchema } = await import(
  path.join(temp, "runtime/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js")
);
const toolPath = path.join(home, ".local", "share", "mise", "installs", "node", "fixture", "bin");
const env = {
  HOME: home,
  PATH: [toolPath, path.join(root, "tools"), ...process.env.PATH.split(path.delimiter)].join(path.delimiter),
  TMPDIR: temp,
  ANTHROPIC_API_KEY: "PROBE-STAND-IN",
  GITHUB_TOKEN: "PROBE-STAND-IN",
};
const server = net.createServer((client) => client.end("PROBE-STAND-IN\n"));
await new Promise((resolve) => server.listen(socket, resolve));

let failed = 0;
const line = (ok, name, why) => {
  if (!ok) failed++;
  console.log(ok ? `PASS ${name}` : `FAIL ${name}${why ? `: ${why}` : ""}`);
};
const run = async (command) => {
  const wrapped = await SandboxManager.wrapWithSandbox(command);
  // Asynchronous: the runtime's filtering proxy runs in this process.
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", wrapped], { cwd: checkout, env });
    let out = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (out += data));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out: out.trim() });
    });
  });
};
const refused = async (name, command) => {
  const { status, out } = await run(command);
  line(status !== 0 && !out.includes("PROBE-STAND-IN"), name, `exit ${status}`);
};

try {
  process.chdir(checkout);
  await SandboxManager.initialize(
    SandboxRuntimeConfigSchema.parse({
      ...policy,
      network: { deniedDomains: [], ...policy.network },
      filesystem: { denyWrite: [], ...policy.filesystem },
    }),
  );
  const own = await run("cat notes.md");
  line(own.status === 0 && own.out === "probe checkout file", "read the checkout file", own.out);
  await refused("refuse the stand-in secrets file", `cat '${state}/secrets/server-signing-key.bin'`);
  await refused("refuse the stand-in database", `cat '${state}/statev2.sqlite'`);
  await refused("refuse the stand-in credential file", `cat '${home}/.ssh/id_ed25519'`);
  await refused("refuse other files in the service user's home", `cat '${home}/ordinary-private-file'`);
  await refused("refuse another session's temp file", `cat '${path.dirname(temp)}/session-other/note'`);
  const ownTemp = await run('cat "$TMPDIR/note"');
  line(ownTemp.status === 0 && ownTemp.out === "own temporary file", "read this session's temp file", ownTemp.out);
  const node = await run(`'${path.join(toolPath, "node")}' --version`);
  line(node.status === 0 && /^v\d+\./.test(node.out), "run Node from the allowed toolchain", node.out);
  const gh = await run(`'${path.join(root, "tools", "gh")}' --version`);
  line(gh.status === 0 && /^gh version \d+\./.test(gh.out), "run the allowed GitHub CLI", gh.out.split("\n")[0]);
  const write = await run(`printf x > '${outside}'`);
  // The denied home is an empty throwaway folder inside the sandbox: a write there may succeed and vanish.
  line(!fs.existsSync(outside), "keep a write outside the checkout off the host", `exit ${write.status}`);
  const allowed = await run("curl -sS -m 20 -o /dev/null -w '%{http_code}' https://github.com/");
  line(allowed.status === 0 && /^[23]\d\d$/.test(allowed.out), "fetch an allowed host (github.com)", allowed.out);
  const other = await run("curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com/");
  line(other.status !== 0 && !/^[23]\d\d$/.test(other.out), "refuse a host not on the list (example.com)", other.out);
  await refused(
    "refuse a Unix socket in a readable folder",
    `'${process.execPath}' -e "require('net').connect('${socket}').on('data',(d)=>process.stdout.write(d)).on('error',()=>process.exit(1))"`,
  );
  await refused("refuse writing the checkout's .git/config", "printf x >> .git/config");
  const scrubbed = await run('test -z "$ANTHROPIC_API_KEY$GITHUB_TOKEN"');
  line(scrubbed.status === 0, "drop credential variables");
} catch (error) {
  line(false, "sandbox started", String(error?.message ?? error).split("\n")[0]);
} finally {
  await SandboxManager.reset().catch(() => {});
  server.close();
}
console.log(failed === 0 ? "PROBE PASS" : "PROBE FAIL");
process.exit(failed === 0 ? 0 : 1);
JS

cd "$root"
# Kin gives Claude Code the session temp as both; the sandbox hands its commands CLAUDE_CODE_TMPDIR.
HOME="$home" TMPDIR="$temp" CLAUDE_CODE_TMPDIR="$temp" node "$root/runner.mjs" "$root" "$here/policy.json"
