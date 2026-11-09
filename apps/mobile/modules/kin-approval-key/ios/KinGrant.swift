import Foundation

// Parses a KinGrant JWS signing input (docs/kin/specs/approvals.md, section 5) and builds the
// approval prompt from it. Foundation only, so test/native/run.sh can compile it on a Mac; it must
// accept and reject exactly what android/.../KinGrant.java does (fixtures/grant-vectors.json).
enum KinGrant {
  struct NotAGrant: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
  }

  /// A JSON string or key as its UTF-8 bytes. Swift's `String` compares and hashes by canonical
  /// equivalence ("\u{212A}" == "K"), which Java doesn't, so every comparison here is on bytes.
  struct Bytes: Hashable, ExpressibleByStringLiteral, CustomStringConvertible {
    let utf8: [UInt8]
    init(_ utf8: [UInt8]) { self.utf8 = utf8 }
    init(stringLiteral value: String) { utf8 = Array(value.utf8) }
    // Lossy is fine: shown values are checked against ASCII allowlists before they reach a prompt.
    // swiftlint:disable:next optional_data_string_conversion
    var description: String { String(decoding: utf8, as: UTF8.self) }
  }

  private static let maxSigningInput = 8192
  private static let maxDepth = 3
  private static let maxPromptBytes = 200
  private static let maxSafeInteger: Int64 = 9_007_199_254_740_991
  private static let maxLifetimeSeconds: Int64 = 900
  private static let maxClockSkewSeconds: Int64 = 300
  private static let payloadRequired: Set<Bytes> = [
    "v", "orgId", "actionId", "revision", "nonce", "jti", "kind", "targetDigest", "target",
    "approver", "decision", "iat", "exp",
  ]
  private static let payloadOptional: Set<Bytes> = ["headSha", "base", "mergeMethod"]

  /// Returns the prompt text for a valid grant signing input, or throws `NotAGrant`.
  static func prompt(signingInput: String, now: Int64) throws -> String {
    guard !signingInput.isEmpty, signingInput.utf8.count <= maxSigningInput else {
      throw NotAGrant("signing input is empty or too long")
    }
    let segments = signingInput.utf8.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
    guard segments.count == 2 else { throw NotAGrant("signing input is not header.payload") }
    let header = try object(Array(segments[0]), "header")
    let payload = try object(Array(segments[1]), "payload")
    try checkHeader(header)
    return try promptFor(payload, kid: try string(header, "kid"), now: now)
  }

  private static func object(_ segment: [UInt8], _ label: String) throws -> [Bytes: Value] {
    let bytes = try base64UrlDecode(segment, label)
    guard String(validating: bytes, as: UTF8.self) != nil else { throw NotAGrant("\(label) is not UTF-8") }
    var parser = Parser(bytes: bytes)
    guard case .object(let map) = try parser.parseDocument() else { throw NotAGrant("\(label) is not an object") }
    return map
  }

  private static func checkHeader(_ header: [Bytes: Value]) throws {
    try exactKeys(header, ["alg", "kid", "typ"], [], "header")
    guard try string(header, "alg") == "ES256" else { throw NotAGrant("alg is not ES256") }
    guard try string(header, "typ") == "kin-grant+jws" else { throw NotAGrant("typ is not kin-grant+jws") }
    try nonEmpty(header, "kid")
  }

  // swiftlint:disable:next cyclomatic_complexity - one branch per kind, mirroring KinGrant.java.
  private static func promptFor(_ p: [Bytes: Value], kid: Bytes, now: Int64) throws -> String {
    try exactKeys(p, payloadRequired, payloadOptional, "payload")
    guard try integer(p, "v") == 1 else { throw NotAGrant("v is not 1") }
    guard try string(p, "decision") == "approve" else { throw NotAGrant("decision is not approve") }
    for key: Bytes in ["orgId", "actionId"] { try nonEmpty(p, key) }
    // Spec section 5: a jti is 16+ random bytes, a nonce exactly 32, as unpadded base64url.
    try base64Url(p, "jti", length: 22...Int.max)
    try base64Url(p, "nonce", length: 43...43)
    guard try integer(p, "revision") >= 0 else { throw NotAGrant("revision is negative") }
    _ = try hex(p, "targetDigest", length: 64)
    let approver = try child(p, "approver")
    try exactKeys(approver, ["humanId", "kid"], [], "approver")
    try nonEmpty(approver, "humanId")
    guard try string(approver, "kid") == kid else { throw NotAGrant("approver.kid is not the header kid") }

    let iat = try integer(p, "iat")
    let exp = try integer(p, "exp")
    guard exp > iat, exp - iat <= maxLifetimeSeconds else { throw NotAGrant("exp is outside iat + 900") }
    guard abs(now - iat) <= maxClockSkewSeconds else { throw NotAGrant("iat is not now") }

    let target = try child(p, "target")
    let kind = try string(p, "kind")
    let text: String
    switch kind {
    case "merge_pull_request":
      try only(p, ["headSha", "base", "mergeMethod"])
      try exactKeys(target, ["_tag", "host", "repo", "number", "mergeMethod", "deleteBranchAfter"], [], "target")
      try tag(target, "pull_request")
      let repo = try githubRepo(target)
      let number = try integer(target, "number")
      guard number >= 1 else { throw NotAGrant("number is not positive") }
      guard case .bool(let deleteAfter) = target["deleteBranchAfter"] else {
        throw NotAGrant("deleteBranchAfter is not a boolean")
      }
      let method = try string(p, "mergeMethod")
      guard try string(target, "mergeMethod") == method else { throw NotAGrant("mergeMethod differs from target") }
      text = "Merge \(repo) #\(number) (\(try headSha(p))) into \"\(try shown(p, "base", .name))\" "
        + (try methodWords(method))
        + (deleteAfter ? ", then delete its branch" : "")
    case "delete_branch":
      try only(p, ["headSha"])
      try exactKeys(target, ["_tag", "host", "repo", "ref"], [], "target")
      try tag(target, "branch")
      let repo = try githubRepo(target)
      text = "Delete branch \"\(try shown(target, "ref", .name))\" (\(try headSha(p))) in \(repo)"
    case "set_level":
      try only(p, [])
      try exactKeys(target, ["_tag", "agentId", "level"], ["chatId"], "target")
      try tag(target, "level")
      let level = try string(target, "level")
      guard ["L0", "L1", "L2", "L3"].contains(level) else { throw NotAGrant("level is not L0-L3") }
      let chat = target["chatId"] == nil ? " in all chats" : " in chat \"\(try shown(target, "chatId", .id))\""
      text = "Set lead \"\(try shown(target, "agentId", .id))\" to \(level)\(chat)"
    case "change_rules", "memory_purge":
      try only(p, [])
      try exactKeys(target, ["_tag", "path", "sha256"], [], "target")
      try tag(target, "content")
      let hash = try hex(target, "sha256", length: 64)
      let path = try shown(target, "path", .name)
      text = kind == "change_rules"
        ? "Change rules to \"\(path)\" (sha256 \(hash))"
        : "Purge memory using \"\(path)\" (sha256 \(hash))"
    case "register_approver_key":
      try only(p, [])
      try exactKeys(target, ["_tag", "thumbprint", "hardware", "attested"], [], "target")
      try tag(target, "device_key")
      let thumbprint = try string(target, "thumbprint").utf8
      guard thumbprint.count == 43, thumbprint.allSatisfy(isBase64UrlByte) else {
        throw NotAGrant("thumbprint is malformed")
      }
      // The server never activates an unattested key, so there is nothing to approve for one.
      guard case .bool(true) = target["attested"] else { throw NotAGrant("the key is not attested") }
      text = "Add approver key \(Bytes(Array(thumbprint))) "
        + "(\(try hardwareWords(try string(target, "hardware"))), attested)"
    default:
      throw NotAGrant("kind has no prompt template")
    }
    // Refused rather than cut, so the fixed words after a long value always show.
    guard text.utf8.count <= maxPromptBytes else { throw NotAGrant("the prompt is over 200 characters") }
    return text
  }

  private static func githubRepo(_ target: [Bytes: Value]) throws -> String {
    guard try string(target, "host") == "github.com" else { throw NotAGrant("host is not github.com") }
    let repo = try string(target, "repo")
    let parts = repo.utf8.split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false)
    let ownerOK = parts.count == 2 && (1...39).contains(parts[0].count)
      && parts[0].allSatisfy { isAlphanumeric($0) || $0 == UInt8(ascii: "-") }
    let nameOK = parts.count == 2 && (1...100).contains(parts[1].count)
      && parts[1].allSatisfy(ShownField.id.allows)
    guard ownerOK, nameOK else { throw NotAGrant("repo is malformed") }
    return repo.description
  }

  private static func methodWords(_ method: Bytes) throws -> String {
    switch method {
    case "merge": return "with a merge commit"
    case "squash": return "by squashing"
    case "rebase": return "by rebasing"
    default: throw NotAGrant("mergeMethod is unknown")
    }
  }

  private static func hardwareWords(_ hardware: Bytes) throws -> String {
    switch hardware {
    case "secure_enclave": return "Secure Enclave"
    case "strongbox": return "StrongBox"
    case "tee": return "TEE"
    default: throw NotAGrant("hardware is not secure_enclave, strongbox or tee")
    }
  }

  private static func headSha(_ p: [Bytes: Value]) throws -> String {
    try hex(p, "headSha", length: 40)
  }

  /// The optional payload fields allowed for this kind, all required; any other is refused.
  private static func only(_ p: [Bytes: Value], _ allowed: Set<Bytes>) throws {
    for key in payloadOptional where p[key] != nil && !allowed.contains(key) {
      throw NotAGrant("\(key) is not allowed here")
    }
    for key in allowed where p[key] == nil { throw NotAGrant("\(key) is required") }
  }

  private static func tag(_ target: [Bytes: Value], _ expected: Bytes) throws {
    guard case .string(expected) = target["_tag"] else { throw NotAGrant("target is not \(expected)") }
  }

  private static func exactKeys(
    _ map: [Bytes: Value], _ required: Set<Bytes>, _ optional: Set<Bytes>, _ label: String
  ) throws {
    for key in required where map[key] == nil { throw NotAGrant("\(label).\(key) is missing") }
    for key in map.keys where !required.contains(key) && !optional.contains(key) {
      throw NotAGrant("\(label).\(key) is not allowed")
    }
  }

  private static func string(_ map: [Bytes: Value], _ key: Bytes) throws -> Bytes {
    guard case .string(let value) = map[key] else { throw NotAGrant("\(key) is not a string") }
    return value
  }

  private static func nonEmpty(_ map: [Bytes: Value], _ key: Bytes) throws {
    guard try !string(map, key).utf8.isEmpty else { throw NotAGrant("\(key) is empty") }
  }

  private static func base64Url(_ map: [Bytes: Value], _ key: Bytes, length: ClosedRange<Int>) throws {
    let value = try string(map, key).utf8
    guard length.contains(value.count), value.allSatisfy(isBase64UrlByte) else {
      throw NotAGrant("\(key) is malformed")
    }
  }

  private static func hex(_ map: [Bytes: Value], _ key: Bytes, length: Int) throws -> String {
    let value = try string(map, key).utf8
    let lowerHex = value.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    guard value.count == length, lowerHex else { throw NotAGrant("\(key) is malformed") }
    // swiftlint:disable:next optional_data_string_conversion
    return String(decoding: value, as: UTF8.self)
  }

  private static func integer(_ map: [Bytes: Value], _ key: Bytes) throws -> Int64 {
    guard case .integer(let value) = map[key] else { throw NotAGrant("\(key) is not an integer") }
    return value
  }

  private static func child(_ map: [Bytes: Value], _ key: Bytes) throws -> [Bytes: Value] {
    guard case .object(let value) = map[key] else { throw NotAGrant("\(key) is not an object") }
    return value
  }

  /// What a shown value may contain. ASCII only, so no platform Unicode table is consulted and
  /// nothing invisible, confusable or reordering can reach the prompt; a quote can't occur.
  enum ShownField {
    /// Branch names and paths: letters, digits and `. _ - / +` (a subset of what git allows).
    case name
    /// Lead and chat ids: letters, digits and `. _ -`.
    case id

    func allows(_ byte: UInt8) -> Bool {
      if KinGrant.isAlphanumeric(byte) { return true }
      switch self {
      case .name: return Array("._-/+".utf8).contains(byte)
      case .id: return Array("._-".utf8).contains(byte)
      }
    }
  }

  /// A shown value, refused (never cleaned) if it is empty or has a byte outside its allowlist.
  private static func shown(_ map: [Bytes: Value], _ key: Bytes, _ field: ShownField) throws -> String {
    let value = try string(map, key)
    guard !value.utf8.isEmpty, value.utf8.allSatisfy(field.allows) else {
      throw NotAGrant("\(key) has a character that can't be shown")
    }
    return value.description
  }

  private static func isAlphanumeric(_ byte: UInt8) -> Bool {
    (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
  }

  private static func isBase64UrlByte(_ byte: UInt8) -> Bool {
    isAlphanumeric(byte) || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "_")
  }

  /// Unpadded base64url with zero trailing bits, so every byte string has exactly one encoding.
  static func base64UrlDecode(_ input: [UInt8], _ label: String) throws -> [UInt8] {
    guard !input.isEmpty, input.count % 4 != 1 else { throw NotAGrant("\(label) is not base64url") }
    var out: [UInt8] = []
    out.reserveCapacity(input.count * 3 / 4)
    var buffer: UInt32 = 0
    var bits = 0
    for byte in input {
      let digit: UInt32
      switch byte {
      case 65...90: digit = UInt32(byte - 65)
      case 97...122: digit = UInt32(byte - 97 + 26)
      case 48...57: digit = UInt32(byte - 48 + 52)
      case UInt8(ascii: "-"): digit = 62
      case UInt8(ascii: "_"): digit = 63
      default: throw NotAGrant("\(label) is not base64url")
      }
      buffer = (buffer << 6) | digit
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8(truncatingIfNeeded: buffer >> UInt32(bits)))
        buffer &= (1 << UInt32(bits)) - 1
      }
    }
    guard buffer == 0 else { throw NotAGrant("\(label) has non-zero trailing bits") }
    return out
  }

  enum Value {
    case object([Bytes: Value])
    case string(Bytes)
    case integer(Int64)
    case bool(Bool)
  }

  // Accepts only the canonical form stableStringify (packages/shared/src/relaySigning.ts) writes:
  // no whitespace, keys in strictly increasing UTF-16 order (so no duplicates), JSON.stringify's
  // string escapes, safe integers. Only objects, strings, integers and booleans occur in a grant.
  private struct Parser {
    let bytes: [UInt8]
    var at = 0

    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func parseDocument() throws -> Value {
      let value = try parseValue(depth: 0)
      guard at == bytes.count else { throw fail("trailing characters") }
      return value
    }

    private mutating func parseValue(depth: Int) throws -> Value {
      guard at < bytes.count else { throw fail("unexpected end") }
      switch bytes[at] {
      case UInt8(ascii: "{"): return .object(try parseObject(depth: depth))
      case UInt8(ascii: "\""): return .string(try parseString())
      case UInt8(ascii: "-"), 48...57: return .integer(try parseInteger())
      default:
        if literal("true") { return .bool(true) }
        if literal("false") { return .bool(false) }
        throw fail("unsupported value")
      }
    }

    private mutating func literal(_ word: String) -> Bool {
      let utf8 = Array(word.utf8)
      guard bytes.count - at >= utf8.count, Array(bytes[at..<at + utf8.count]) == utf8 else { return false }
      at += utf8.count
      return true
    }

    private mutating func parseObject(depth: Int) throws -> [Bytes: Value] {
      guard depth < KinGrant.maxDepth else { throw fail("nested too deep") }
      at += 1
      var map: [Bytes: Value] = [:]
      if peek("}") {
        at += 1
        return map
      }
      var previous: Bytes?
      while true {
        guard peek("\"") else { throw fail("expected a key") }
        let key = try parseString()
        // UTF-16 code-unit order, as JavaScript sorts; String's utf16 view never normalizes.
        if let previous, !previous.description.utf16.lexicographicallyPrecedes(key.description.utf16) {
          throw fail("keys are not in canonical order")
        }
        previous = key
        try expect(":")
        map[key] = try parseValue(depth: depth + 1)
        if peek(",") {
          at += 1
          continue
        }
        try expect("}")
        return map
      }
    }

    // swiftlint:disable:next cyclomatic_complexity - one branch per escape, mirroring KinGrant.java.
    private mutating func parseString() throws -> Bytes {
      at += 1
      var out: [UInt8] = []
      while true {
        guard at < bytes.count else { throw fail("unterminated string") }
        let byte = bytes[at]
        at += 1
        if byte == UInt8(ascii: "\"") {
          guard String(validating: out, as: UTF8.self) != nil else { throw fail("string is not UTF-8") }
          return Bytes(out)
        }
        guard byte >= 0x20 else { throw fail("raw control character") }
        guard byte == UInt8(ascii: "\\") else {
          out.append(byte)
          continue
        }
        guard at < bytes.count else { throw fail("unterminated escape") }
        let escape = bytes[at]
        at += 1
        switch escape {
        case UInt8(ascii: "\""): out.append(UInt8(ascii: "\""))
        case UInt8(ascii: "\\"): out.append(UInt8(ascii: "\\"))
        case UInt8(ascii: "b"): out.append(0x08)
        case UInt8(ascii: "f"): out.append(0x0C)
        case UInt8(ascii: "n"): out.append(0x0A)
        case UInt8(ascii: "r"): out.append(0x0D)
        case UInt8(ascii: "t"): out.append(0x09)
        case UInt8(ascii: "u"): out.append(try parseControlEscape())
        default: throw fail("non-canonical escape")
        }
      }
    }

    // JSON.stringify only writes \u for control characters without a short escape (and lone
    // surrogates, which a grant never contains), always as lowercase \u00xx.
    private mutating func parseControlEscape() throws -> UInt8 {
      guard bytes.count - at >= 4, bytes[at] == 48, bytes[at + 1] == 48 else {
        throw fail("non-canonical \\u escape")
      }
      let high = bytes[at + 2]
      let low = bytes[at + 3]
      guard high == 48 || high == 49 else { throw fail("non-canonical \\u escape") }
      let lowValue: UInt8
      switch low {
      case 48...57: lowValue = low - 48
      case 97...102: lowValue = low - 97 + 10
      default: throw fail("non-canonical \\u escape")
      }
      let value = (high - 48) * 16 + lowValue
      guard ![0x08, 0x09, 0x0A, 0x0C, 0x0D].contains(value) else { throw fail("non-canonical \\u escape") }
      at += 4
      return value
    }

    private mutating func parseInteger() throws -> Int64 {
      let start = at
      if peek("-") { at += 1 }
      if peek("0") {
        at += 1
      } else {
        guard at < bytes.count, (49...57).contains(bytes[at]) else { throw fail("bad number") }
        while at < bytes.count, (48...57).contains(bytes[at]) { at += 1 }
      }
      if at < bytes.count, [UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E")].contains(bytes[at]) {
        throw fail("not an integer")
      }
      // swiftlint:disable:next optional_data_string_conversion
      let digits = String(decoding: bytes[start..<at], as: UTF8.self)
      guard digits != "-0" else { throw fail("negative zero") }
      guard digits.utf8.count <= 17, let value = Int64(digits), abs(value) <= KinGrant.maxSafeInteger else {
        throw fail("integer out of range")
      }
      return value
    }

    private func peek(_ char: Unicode.Scalar) -> Bool {
      at < bytes.count && bytes[at] == UInt8(ascii: char)
    }

    private mutating func expect(_ char: Unicode.Scalar) throws {
      guard peek(char) else { throw fail("expected \(char)") }
      at += 1
    }

    private func fail(_ reason: String) -> NotAGrant {
      NotAGrant("not canonical JSON: \(reason)")
    }
  }
}
