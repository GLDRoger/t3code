import CryptoKit
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security
import UIKit

// One approval key per install. It only ever signs Kin grants, never connections.
private let keyTag = Data("kin.approval-key.v1".utf8)
// The biometric enrolment the key was bound to, kept only to tell re-enrolment from a failed match.
private let biometryStateService = "kin.approval-key.v1.biometry-state"

public class KinApprovalKeyModule: Module {
  // Concurrent, so a second sign reaches the busy check while the first one waits on Face ID.
  private static let signQueue = DispatchQueue(label: "kin.approval-key", attributes: .concurrent)

  public func definition() -> ModuleDefinition {
    Name("KinApprovalKey")

    // iOS has no attestation in phase 1, so the challenge is unused here.
    AsyncFunction("createKey") { (_: String) throws -> [String: Any] in
      try createKey()
    }

    AsyncFunction("signDer") { (signingInput: String, promise: Promise) in
      SignRequest.start(signingInput: signingInput, promise: promise, queue: Self.signQueue)
    }.runOnQueue(Self.signQueue)

    AsyncFunction("hasKey") { () throws -> Bool in
      try loadPrivateKey(context: nil) != nil
    }

    AsyncFunction("deleteKey") { () throws in
      let status = SecItemDelete(privateKeyQuery() as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw ApprovalKeyException("E_KEYCHAIN", "Deleting the approval key failed (OSStatus \(status)).")
      }
      SecItemDelete(biometryStateQuery() as CFDictionary)
    }
  }
}

private func createKey() throws -> [String: Any] {
  guard SecureEnclave.isAvailable else {
    throw ApprovalKeyException("E_NO_SECURE_HARDWARE", "This device has no Secure Enclave.")
  }
  let context = LAContext()
  var policyError: NSError?
  guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
    throw ApprovalKeyException(
      "E_BIOMETRY_UNAVAILABLE",
      "Face ID or Touch ID must be set up, with a passcode, to create an approval key.",
      cause: policyError)
  }
  guard try loadPrivateKey(context: nil) == nil else {
    throw ApprovalKeyException("E_KEY_EXISTS", "An approval key already exists; delete it first.")
  }

  var error: Unmanaged<CFError>?
  // .biometryCurrentSet: every signature needs biometrics, and changing enrolment invalidates the key.
  guard let access = SecAccessControlCreateWithFlags(
    kCFAllocatorDefault,
    kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
    [.privateKeyUsage, .biometryCurrentSet],
    &error
  ) else {
    throw ApprovalKeyException("E_KEYCHAIN", "Creating the access control failed.", cause: error?.takeRetainedValue())
  }
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: keyTag,
      kSecAttrAccessControl as String: access,
    ] as [String: Any],
  ]
  guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
    throw ApprovalKeyException(
      "E_KEYCHAIN", "Creating the Secure Enclave key failed.", cause: error?.takeRetainedValue())
  }
  guard let publicKey = SecKeyCopyPublicKey(privateKey),
        let x963 = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
    SecItemDelete(privateKeyQuery() as CFDictionary)
    throw ApprovalKeyException(
      "E_KEYCHAIN", "Exporting the approval public key failed.", cause: error?.takeRetainedValue())
  }
  storeBiometryState(context.domainState.biometry.stateHash)
  return ["publicKey": base64UrlEncode(x963), "hardware": "secure_enclave"]
}

/// One `sign` call. Only one may be in flight; every path settles its promise exactly once.
private final class SignRequest: @unchecked Sendable {
  private static let gate = NSLock()
  nonisolated(unsafe) private static var busy = false

  private let promise: Promise
  private let queue: DispatchQueue
  private let lock = NSLock()
  private var settled = false
  @MainActor private var sheet: ConfirmationSheet?

  private init(promise: Promise, queue: DispatchQueue) {
    self.promise = promise
    self.queue = queue
  }

  static func start(signingInput: String, promise: Promise, queue: DispatchQueue) {
    gate.lock()
    let wasBusy = busy
    busy = true
    gate.unlock()
    guard !wasBusy else {
      promise.reject(ApprovalKeyException("E_BUSY", "Another approval is already waiting for the user."))
      return
    }
    SignRequest(promise: promise, queue: queue).prepare(signingInput: signingInput)
  }

  private func prepare(signingInput: String) {
    let prompt: String
    do {
      prompt = try KinGrant.prompt(signingInput: signingInput, now: Int64(Date().timeIntervalSince1970))
    } catch {
      return reject(ApprovalKeyException("E_NOT_A_GRANT", "Only Kin grants can be signed: \(error)."))
    }
    // A fresh context per signature, so no earlier match is ever reused.
    let context = LAContext()
    context.localizedFallbackTitle = ""
    context.localizedReason = prompt
    var policyError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError) else {
      let lockedOut = (policyError?.code == LAError.biometryLockout.rawValue)
      return reject(ApprovalKeyException(
        lockedOut ? "E_BIOMETRY_LOCKOUT" : "E_BIOMETRY_UNAVAILABLE",
        lockedOut ? "Biometrics are locked; unlock with the passcode first." : "Face ID or Touch ID isn't available.",
        cause: policyError))
    }
    let enrolmentChanged = biometryStateChanged(context.domainState.biometry.stateHash)
    let key: SecKey
    do {
      guard let found = try loadPrivateKey(context: context) else {
        return reject(enrolmentChanged ? invalidated() : ApprovalKeyException(
          "E_KEY_NOT_FOUND", "There is no approval key on this device."))
      }
      key = found
    } catch {
      return reject(error)
    }
    // Face ID and Optic ID mostly ignore localizedReason, so the grant is shown natively first.
    let needsSheet = context.biometryType != .touchID
    DispatchQueue.main.async {
      self.confirm(prompt: prompt, needsSheet: needsSheet) {
        self.queue.async {
          self.sign(Data(signingInput.utf8), with: key, context: context, enrolmentChanged: enrolmentChanged)
        }
      }
    }
  }

  @MainActor
  private func confirm(prompt: String, needsSheet: Bool, approved: @escaping () -> Void) {
    guard !isSettled else { return }
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
    guard UIApplication.shared.applicationState == .active, let scene else {
      return reject(ApprovalKeyException("E_NO_ACTIVITY", "Approvals need the app in the foreground."))
    }
    guard needsSheet else { return approved() }
    sheet = ConfirmationSheet(scene: scene, prompt: prompt) { outcome in
      switch outcome {
      case .approved:
        approved()
      case .obscured:
        self.reject(ApprovalKeyException("E_OBSCURED", "Something covered the confirmation sheet, so nothing was signed."))
      case .canceled(let reason):
        self.reject(ApprovalKeyException("E_USER_CANCELED", reason))
      }
    }
  }

  private func sign(_ message: Data, with key: SecKey, context: LAContext, enrolmentChanged: Bool) {
    guard !isSettled else { return }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
      key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error
    ) as Data? else {
      return reject(signingException(error?.takeRetainedValue(), enrolmentChanged: enrolmentChanged))
    }
    // The key still signs, so the current enrolment is the one it's bound to (e.g. after an OS update).
    if enrolmentChanged { storeBiometryState(context.domainState.biometry.stateHash) }
    settle { $0.resolve(base64UrlEncode(signature)) }
  }

  private var isSettled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return settled
  }

  private func reject(_ error: Error) {
    settle { $0.reject(error) }
  }

  private func settle(_ body: (Promise) -> Void) {
    lock.lock()
    let first = !settled
    settled = true
    lock.unlock()
    guard first else { return }
    Self.gate.lock()
    Self.busy = false
    Self.gate.unlock()
    DispatchQueue.main.async {
      self.sheet?.close()
      self.sheet = nil
    }
    body(promise)
  }
}

private func invalidated() -> ApprovalKeyException {
  ApprovalKeyException(
    "E_KEY_INVALIDATED",
    "Biometric enrolment changed, so the approval key no longer works. Delete it and register a new one.")
}

private func privateKeyQuery() -> [String: Any] {
  [
    kSecClass as String: kSecClassKey,
    kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecAttrApplicationTag as String: keyTag,
  ]
}

private func loadPrivateKey(context: LAContext?) throws -> SecKey? {
  var query = privateKeyQuery()
  query[kSecReturnRef as String] = true
  if let context {
    query[kSecUseAuthenticationContext as String] = context
  } else {
    // Looking the key up must never show UI; only signing authenticates.
    let silent = LAContext()
    silent.interactionNotAllowed = true
    query[kSecUseAuthenticationContext as String] = silent
  }
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  switch status {
  case errSecSuccess:
    guard let item, CFGetTypeID(item) == SecKeyGetTypeID() else {
      throw ApprovalKeyException("E_KEYCHAIN", "The approval key lookup returned something other than a key.")
    }
    return unsafeDowncast(item, to: SecKey.self)
  case errSecItemNotFound:
    return nil
  default:
    throw ApprovalKeyException("E_KEYCHAIN", "Reading the approval key failed (OSStatus \(status)).")
  }
}

private func biometryStateQuery() -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: biometryStateService,
    kSecAttrAccount as String: "state",
  ]
}

// Best effort: the state only classifies errors. Apple warns it can change across major OS
// versions with no enrolment change, so a mismatch alone never blocks signing.
private func storeBiometryState(_ state: Data?) {
  SecItemDelete(biometryStateQuery() as CFDictionary)
  guard let state else { return }
  var item = biometryStateQuery()
  item[kSecValueData as String] = state
  item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
  SecItemAdd(item as CFDictionary, nil)
}

private func biometryStateChanged(_ current: Data?) -> Bool {
  var query = biometryStateQuery()
  query[kSecReturnData as String] = true
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let stored = item as? Data else {
    return false
  }
  return stored != current
}

private func signingException(_ error: CFError?, enrolmentChanged: Bool) -> ApprovalKeyException {
  guard let error else {
    return ApprovalKeyException("E_AUTH_FAILED", "Signing failed without an error.")
  }
  let nsError = error as Error as NSError
  let la = nsError.domain == LAErrorDomain
  let status = nsError.domain == NSOSStatusErrorDomain ? OSStatus(nsError.code) : nil
  let canceled: Set<Int> = [
    LAError.userCancel.rawValue, LAError.appCancel.rawValue, LAError.systemCancel.rawValue,
    LAError.userFallback.rawValue,
  ]
  let unavailable: Set<Int> = [
    LAError.biometryNotEnrolled.rawValue, LAError.biometryNotAvailable.rawValue, LAError.passcodeNotSet.rawValue,
  ]
  if (la && canceled.contains(nsError.code)) || status == errSecUserCanceled {
    return ApprovalKeyException("E_USER_CANCELED", "Approval was canceled.", cause: nsError)
  }
  if la && nsError.code == LAError.biometryLockout.rawValue {
    return ApprovalKeyException("E_BIOMETRY_LOCKOUT", "Biometrics are locked; unlock with the passcode first.", cause: nsError)
  }
  if la && unavailable.contains(nsError.code) {
    return ApprovalKeyException("E_BIOMETRY_UNAVAILABLE", "Face ID or Touch ID isn't available.", cause: nsError)
  }
  if (la && nsError.code == LAError.notInteractive.rawValue) || status == errSecInteractionNotAllowed {
    return ApprovalKeyException("E_NO_ACTIVITY", "Approvals need the app in the foreground.", cause: nsError)
  }
  if enrolmentChanged { return invalidated() }
  // A failed match, or a re-enrolment made before this install recorded its enrolment state.
  return ApprovalKeyException(
    "E_AUTH_FAILED", "Signing failed (\(nsError.domain) \(nsError.code)).", cause: nsError)
}

private func base64UrlEncode(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private final class ApprovalKeyException: Exception, @unchecked Sendable {
  init(_ code: String, _ description: String, cause: Error? = nil) {
    super.init(name: "ApprovalKeyException", description: description, code: code)
    self.cause = cause
  }
}
