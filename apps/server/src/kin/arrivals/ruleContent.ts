// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure digest of the exact stored rule.
import * as NodeCrypto from "node:crypto";

export const mailRuleContentHash = (matchJson: string, what: string) =>
  NodeCrypto.createHash("sha256")
    .update(matchJson + what)
    .digest("hex");
