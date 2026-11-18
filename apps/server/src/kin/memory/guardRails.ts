import { kinOnlyPaths } from "./lint.ts";

/**
 * The memory repo's guard rails, as this server ships them. `ops/kin/memory-repo` holds the same
 * files with placeholders (`node apps/server/src/kin/memory/guardRails.ts codeowners|memory-check`
 * prints them), and `MemoryLander` proposes them to a memory repo whose copies differ.
 */
export const CODEOWNERS_PATH = ".github/CODEOWNERS";
export const MEMORY_CHECK_PATH = ".github/workflows/memory-check.yml";
// Bump when the lint starts refusing or accepting something new, so every repo is re-pinned to it.
const VERSION = 2;
const OWNER_PLACEHOLDER = "@OWNER";
const PIN_PLACEHOLDER = "<t3code commit SHA>";
const pinLine = /^( {6}T3CODE_REF: )"([^"\n]*)"$/m;

export const codeownersFile = (owners: string) =>
  [
    "# Install as .github/CODEOWNERS in the memory repo and replace @OWNER with the owner's GitHub login.",
    "# Deny by default: the owner reviews every path, including rules.md, .github/ and a root CLAUDE.md,",
    "# AGENTS.md, .claude/, .mcp.json or .codex/ that the lead's read checkout would load. The last",
    "# matching line wins, so the owner-less lines below free only what Kin writes alone: every memory",
    "# item folder, the journal and the index. memory-check's lint enforces this shape.",
    `* ${owners}`,
    ...kinOnlyPaths,
    "",
  ].join("\n");

export const memoryCheckFile = (
  pin: string,
) => `# Install as .github/workflows/memory-check.yml in the memory repo; see README.md beside this file.
# Kin guard rails ${VERSION}: Kin proposes this file again whenever its version or shape changes.
# Memory files are only ever read as data. The lint code and gitleaks config come from a pinned
# GLDRoger/t3code commit, so a pull request cannot change what checks it.
name: memory-check

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: memory-check-\${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: true

jobs:
  memory-check:
    name: memory-check
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    env:
      # A GLDRoger/t3code commit on kin or main that contains ops/kin/memory-repo. Kin's upgrade PR sets
      # it to the commit its server runs; by hand, bump it deliberately.
      T3CODE_REF: "${pin}"
      GITLEAKS_VERSION: "8.30.1"
      GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
    steps:
      - name: Check pins
        run: |
          [[ "$T3CODE_REF" =~ ^[0-9a-f]{40}$ ]] || { echo "T3CODE_REF must be a full commit SHA"; exit 1; }

      - name: Checkout memory
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          path: memory
          fetch-depth: 0
          persist-credentials: false

      # Plain git, not actions/checkout: its cleanup walks t3code's .repos gitlinks, which have no
      # .gitmodules entry, and fails. Public repo, pinned SHA, no credentials.
      - name: Checkout t3code
        run: |
          set -euo pipefail
          git init -q t3code
          git -C t3code sparse-checkout set --no-cone '/*' '!/.repos/'
          git -C t3code fetch -q --depth 1 https://github.com/GLDRoger/t3code "$T3CODE_REF"
          git -C t3code checkout -q FETCH_HEAD
          [[ "$(git -C t3code rev-parse HEAD)" == "$T3CODE_REF" ]]

      - name: Setup Vite+
        uses: voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb # v1.15.0
        with:
          working-directory: t3code
          version-file: pnpm-workspace.yaml
          node-version-file: package.json
          cache: false
          run-install: false

      - name: Install lint dependencies
        working-directory: t3code
        run: vp install --frozen-lockfile --ignore-scripts --filter=t3...

      - name: Schema lint
        run: node t3code/apps/server/src/kin/memory/lintCli.ts memory

      - name: Gitleaks
        env:
          BASE: \${{ github.event.pull_request.base.sha || github.event.before }}
          HEAD: \${{ github.event.pull_request.head.sha || github.sha }}
        run: |
          set -euo pipefail
          # gitleaks honours a .gitleaksignore in the scanned tree whatever --gitleaks-ignore-path says.
          if [[ -n "$(find memory -name .gitleaksignore -not -path 'memory/.git/*')" ]]; then
            echo ".gitleaksignore is not allowed in the memory repo"; exit 1
          fi
          bin="$RUNNER_TEMP/gitleaks"
          mkdir -p "$bin"
          archive="gitleaks_\${GITLEAKS_VERSION}_linux_x64.tar.gz"
          curl -fsSL --retry 3 -o "$bin/$archive" \\
            "https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/\${archive}"
          echo "\${GITLEAKS_SHA256}  $bin/$archive" | sha256sum --check --strict
          tar -xzf "$bin/$archive" -C "$bin" gitleaks
          : > "$bin/no-ignores"
          flags=(--config t3code/ops/kin/memory-repo/gitleaks.toml --gitleaks-ignore-path "$bin/no-ignores"
            --ignore-gitleaks-allow --redact --no-banner --exit-code 1)
          "$bin/gitleaks" dir "\${flags[@]}" memory
          # New commits only; a missing or zero base (first push, rewritten history) scans everything.
          # -m diffs merges against each parent, so a token only a merge resolution held is seen too.
          if [[ "$BASE" =~ ^[0-9a-f]{40}$ && ! "$BASE" =~ ^0+$ ]] && git -C memory cat-file -e "$BASE^{commit}" 2>/dev/null; then
            "$bin/gitleaks" git "\${flags[@]}" --log-opts="-m $BASE..$HEAD" memory
          else
            "$bin/gitleaks" git "\${flags[@]}" --log-opts="-m --all" memory
          fi
`;

const withoutPin = (workflow: string) => workflow.replace(pinLine, `$1"${PIN_PLACEHOLDER}"`);

/** The owners on an installed CODEOWNERS' `*` line, the one line Kin carries over as it was. */
const ownersOf = (codeowners: string) => {
  const rule = codeowners
    .split(/\r?\n/)
    .map((line) => line.split("#")[0]!.trim())
    .find((line) => line !== "");
  const [pattern, ...owners] = rule?.split(/\s+/) ?? [];
  return pattern === "*" &&
    owners.length > 0 &&
    owners.every((owner) => /^@[\w./-]+$/.test(owner) && owner.toUpperCase() !== OWNER_PLACEHOLDER)
    ? owners.join(" ")
    : undefined;
};

export interface GuardRails {
  readonly codeowners: string;
  readonly workflow: string;
}

/** The same guard rails, whatever commit each pins: re-pinning alone is never worth a PR. */
export const sameGuardRails = (a: GuardRails, b: GuardRails) =>
  a.codeowners === b.codeowners && withoutPin(a.workflow) === withoutPin(b.workflow);

/**
 * What the remote's guard rails should become: `current` when they already match, `unowned` when
 * its CODEOWNERS names no owner Kin could carry over (Kin never picks one), else the new files.
 */
export const guardRailsUpdate = (
  remote: { readonly codeowners: string | undefined; readonly workflow: string | undefined },
  pin: string,
) => {
  const owners = remote.codeowners === undefined ? undefined : ownersOf(remote.codeowners);
  if (owners === undefined) return { _tag: "unowned" } as const;
  const wanted = { codeowners: codeownersFile(owners), workflow: memoryCheckFile(pin) };
  const pinned = remote.workflow === undefined ? undefined : pinLine.exec(remote.workflow)?.[2];
  if (
    remote.workflow !== undefined &&
    pinned !== undefined &&
    /^[0-9a-f]{40}$/.test(pinned) &&
    sameGuardRails({ codeowners: remote.codeowners!, workflow: remote.workflow }, wanted)
  )
    return { _tag: "current" } as const;
  return { _tag: "update", files: wanted } as const;
};

if (import.meta.main) {
  const file = process.argv[2];
  if (file === "codeowners") process.stdout.write(codeownersFile(OWNER_PLACEHOLDER));
  else if (file === "memory-check") process.stdout.write(memoryCheckFile(PIN_PLACEHOLDER));
  else {
    process.stderr.write("usage: node guardRails.ts codeowners|memory-check\n");
    process.exitCode = 1;
  }
}
