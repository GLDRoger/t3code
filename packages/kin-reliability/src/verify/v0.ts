// @effect-diagnostics nodeBuiltinImport:off - Gate integrity hashes LAWS.bend and asks git whether it is clean.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const UNSAFE_PATTERN = /@unsafe\b|@foreign\b|^\s*def\s+[A-Za-z0-9_]+\?/mu;

export interface GateIntegrity {
  readonly ok: boolean;
  readonly lawsApproved: boolean;
  readonly reasons: readonly string[];
  readonly lawsHash: string | null;
  readonly approvedHash: string | null;
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
}

function hashFile(file: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}

function localImportSpecs(text: string): readonly string[] {
  const specs: string[] = [];
  for (const match of text.matchAll(/import\s+(\.\/\S+)/gu)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

function walk(
  dir: string,
  entry: string,
): { readonly files: readonly string[]; readonly unsafe: readonly string[] } {
  const seen = new Set<string>();
  const unsafe: string[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const fileName = current.endsWith(".bend") ? current : `${current}.bend`;
    const full = NodePath.join(dir, NodePath.basename(fileName));
    if (!NodeFS.existsSync(full)) {
      unsafe.push(`missing import ${current}`);
      continue;
    }
    const text = NodeFS.readFileSync(full, "utf8");
    if (UNSAFE_PATTERN.test(text)) unsafe.push(NodePath.basename(full));
    for (const spec of localImportSpecs(text)) pending.push(spec);
  }
  return { files: [...seen], unsafe };
}

export function checkGateIntegrity(bendDir: string): GateIntegrity {
  const reasons: string[] = [];
  const lawsFile = NodePath.join(bendDir, "LAWS.bend");
  const proofFile = NodePath.join(bendDir, "PROOF.bend");
  const approvedFile = NodePath.join(bendDir, "laws.approved.sha256");
  let lawsHash: string | null = null;
  let approvedHash: string | null = null;
  if (!NodeFS.existsSync(lawsFile) || !NodeFS.existsSync(proofFile)) {
    return {
      ok: false,
      lawsApproved: false,
      reasons: ["LAWS.bend and PROOF.bend must both be present"],
      lawsHash,
      approvedHash,
      proves: [],
      doesNotProve: ["No law file, so nothing is gated."],
    };
  }
  lawsHash = hashFile(lawsFile);
  approvedHash = NodeFS.existsSync(approvedFile)
    ? NodeFS.readFileSync(approvedFile, "utf8").trim()
    : null;
  let lawsApproved = approvedHash === lawsHash;
  if (!lawsApproved) {
    reasons.push(
      "LAWS.bend hash does not match laws.approved.sha256; an owner or reviewer has to approve the law change",
    );
  }
  const status = NodeChildProcess.spawnSync(
    "git",
    ["status", "--porcelain", "--", "LAWS.bend", "laws.approved.sha256"],
    { cwd: bendDir, encoding: "utf8" },
  );
  if (status.status !== 0) {
    reasons.push("git status failed; a matching hash is not owner identity");
    lawsApproved = false;
  } else if (status.stdout.trim().length > 0) {
    reasons.push(
      "LAWS.bend or laws.approved.sha256 is uncommitted; Kin does not treat that as approval",
    );
    lawsApproved = false;
  }
  const proof = NodeFS.readFileSync(proofFile, "utf8");
  if (!proof.includes("import ./LAWS.bend as Laws")) {
    reasons.push("PROOF.bend does not import ./LAWS.bend as Laws");
  }
  const graph = walk(bendDir, "./PROOF.bend");
  if (graph.unsafe.length > 0) {
    reasons.push(`@unsafe or foreign code is reachable from proofs: ${graph.unsafe.join(", ")}`);
  }
  return {
    ok: reasons.length === 0 && lawsApproved,
    lawsApproved,
    reasons,
    lawsHash,
    approvedHash,
    proves: [
      "The harness checked that PROOF.bend imports LAWS.bend, that no @unsafe or foreign def is reachable, and that the law hash matches a clean committed approved hash.",
    ],
    doesNotProve: [
      "A committed edit of LAWS.bend together with laws.approved.sha256 looks approved. The hash is not bound to a person.",
      "This check does not prove the laws are the right laws, and it does not prove the Bend checker itself.",
    ],
  };
}
