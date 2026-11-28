import CryptoKit
import DeviceCheck
import Foundation

private struct Arguments {
    let output: String
    let nonce: String?

    init?(_ arguments: [String]) {
        guard arguments.first == "--probe" else { return nil }
        var rest = arguments.dropFirst()
        var output: String?
        var nonce: String?
        var attest = false
        while let flag = rest.popFirst() {
            switch flag {
            case "--out" where output == nil:
                guard let value = rest.popFirst(), !value.isEmpty, !value.hasPrefix("--") else { return nil }
                output = value
            case "--attest" where !attest:
                attest = true
            case "--nonce" where nonce == nil:
                guard let value = rest.popFirst(), (32...128).contains(value.utf8.count),
                      value.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) })
                else { return nil }
                nonce = value
            default:
                return nil
            }
        }
        guard let output, attest == (nonce != nil) else { return nil }
        self.output = output
        self.nonce = nonce
    }
}

@main
private struct KinSigner {
    static func main() async {
        guard let arguments = Arguments(Array(CommandLine.arguments.dropFirst())) else {
            FileHandle.standardError.write(Data("""
            Usage: kin-signer --probe --out <file>
                   kin-signer --probe --out <file> --attest --nonce <hex>
            The nonce must contain 32 to 128 hexadecimal characters.

            """.utf8))
            exit(64)
        }

        let bundle = Bundle.main
        let service = DCAppAttestService.shared
        let supported = service.isSupported
        var result: [String: Any] = [
            "signerVersion": (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String).map { $0 as Any } ?? NSNull(),
            "bundleIdentifier": bundle.bundleIdentifier.map { $0 as Any } ?? NSNull(),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "appAttestSupported": supported,
        ]
        if supported, let nonce = arguments.nonce {
            let clientDataHash = Data(SHA256.hash(data: Data(("kin-signer-probe-v1" + nonce).utf8)))
            do {
                let keyId = try await service.generateKey()
                let attestation = try await service.attestKey(keyId, clientDataHash: clientDataHash)
                result["keyId"] = keyId
                result["attestation"] = attestation.base64EncodedString()
            } catch {
                let failure = error as NSError
                result["attestError"] = [
                    "domain": failure.domain,
                    "code": failure.code,
                    "localizedDescription": failure.localizedDescription,
                ]
            }
        }

        do {
            var json = try JSONSerialization.data(withJSONObject: result, options: .sortedKeys)
            json.append(0x0a)
            try json.write(to: URL(fileURLWithPath: arguments.output), options: .atomic)
            FileHandle.standardOutput.write(json)
        } catch {
            FileHandle.standardError.write(Data("Could not write probe JSON.\n".utf8))
            exit(1)
        }
    }
}
