# Kin signer

This helper probes whether App Attest can support future Kin approvals on macOS.
Kin runs Electron as Node, so local scripts can run under the desktop app's signature.
Electron's JIT and library-validation exceptions make it unsuitable for holding approval keys.
The native signer has its own identity and tightly scoped entitlements under the hardened runtime.

`--probe --out <file>` writes the same JSON to the file and stdout: signer version,
bundle ID, macOS version, and App Attest support. If supported, `--attest --nonce <hex>`
also reports an attestation or an error. The probe hashes the fixed prefix
`kin-signer-probe-v1` followed by the nonce's literal ASCII hex characters.

Nothing in the product calls the signer yet. It does not approve or sign grants.
