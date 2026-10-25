// @effect-diagnostics nodeBuiltinImport:off - Issue 776 probes write temp Bend fixtures and invoke the binary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { compareSemver, runBend, type BendInvocation } from "./bend.ts";

/**
 * bendlang/bend#776: `bend PROOF.bend` exited 0 with an `@unsafe` def in the
 * import graph, or without importing LAWS.bend (fixed in 2.0.8). This probe
 * reruns both on the installed binary; only its result closes a loophole.
 */
export const MISSING_IMPORT_FIX_VERSION = "2.0.8";

const MISSING_LAWS = `import Base
law falso:
  {0n == 1n : Nat}
`;

const MISSING_PROOF = `import Base
def unused() -> Nat:
  0n
`;

const UNSAFE_PROOF = `import Base

def absurd(e: Empty) -> {0n == 1n : Nat}:
  match e:

law falso:
  {0n == 1n : Nat}

@unsafe def loop() -> Empty:
  loop()

def falso():
  absurd(loop())
`;

const UNSAFE_MAIN = `import Base
@unsafe def loop() -> Empty:
  loop()
`;

const UNSAFE_IMPORT_LAWS = `import Base
import ./main.bend as G
law falso:
  {0n == 1n : Nat}
`;

const UNSAFE_IMPORT_PROOF = `import Base
import ./main.bend as G
import ./LAWS.bend as Laws

def absurd(e: Empty) -> {0n == 1n : Nat}:
  match e:

def Laws.falso():
  absurd(G.loop())
`;

export interface LoopholeProbe {
  readonly name: string;
  readonly exitCode: number | null;
  readonly closed: boolean | null;
  readonly detail: string;
}

export interface LoopholeReport {
  readonly version: string | null;
  readonly documentedMissingImportFix: string;
  readonly versionClaimsMissingImportFix: boolean | null;
  readonly missingImport: LoopholeProbe;
  readonly unsafeProof: LoopholeProbe;
  readonly unsafeImport: LoopholeProbe;
  readonly summary: string;
}

function skipped(name: string): LoopholeProbe {
  return { name, exitCode: null, closed: null, detail: "not probed: bend not installed" };
}

function judge(name: string, result: BendInvocation): LoopholeProbe {
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  const closed = result.exitCode !== 0 && result.exitCode !== null;
  return { name, exitCode: result.exitCode, closed, detail };
}

function writeProbe(dir: string, files: Readonly<Record<string, string>>): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    NodeFS.writeFileSync(NodePath.join(dir, name), text);
  }
}

export function probeLoopholes(bin: string | null, version: string | null): LoopholeReport {
  const versionClaims =
    version === null ? null : compareSemver(version, MISSING_IMPORT_FIX_VERSION) >= 0;
  if (bin === null) {
    return {
      version,
      documentedMissingImportFix: MISSING_IMPORT_FIX_VERSION,
      versionClaimsMissingImportFix: versionClaims,
      missingImport: skipped("missing-import"),
      unsafeProof: skipped("unsafe-proof"),
      unsafeImport: skipped("unsafe-import"),
      summary: "issue 776 was not probed: bend not installed",
    };
  }
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-776-"));
  try {
    const missingDir = NodePath.join(root, "missing");
    writeProbe(missingDir, { "LAWS.bend": MISSING_LAWS, "PROOF.bend": MISSING_PROOF });
    const unsafeDir = NodePath.join(root, "unsafe");
    writeProbe(unsafeDir, { "PROOF.bend": UNSAFE_PROOF });
    const importDir = NodePath.join(root, "import");
    writeProbe(importDir, {
      "main.bend": UNSAFE_MAIN,
      "LAWS.bend": UNSAFE_IMPORT_LAWS,
      "PROOF.bend": UNSAFE_IMPORT_PROOF,
    });
    const missingImport = judge(
      "missing-import",
      runBend(bin, ["PROOF.bend", "--check-only"], missingDir),
    );
    const unsafeProof = judge(
      "unsafe-proof",
      runBend(bin, ["PROOF.bend", "--check-only"], unsafeDir),
    );
    const unsafeImport = judge(
      "unsafe-import",
      runBend(bin, ["PROOF.bend", "--check-only"], importDir),
    );
    const probes = [missingImport, unsafeProof, unsafeImport];
    const open = probes.filter((probe) => probe.closed === false).map((probe) => probe.name);
    const summary =
      open.length === 0
        ? `issue 776 loopholes are closed on bend ${version ?? "unknown"} (missing-import, @unsafe proof, @unsafe import all exit non-zero)`
        : `issue 776 still open on bend ${version ?? "unknown"}: ${open.join(", ")}`;
    return {
      version,
      documentedMissingImportFix: MISSING_IMPORT_FIX_VERSION,
      versionClaimsMissingImportFix: versionClaims,
      missingImport,
      unsafeProof,
      unsafeImport,
      summary,
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
