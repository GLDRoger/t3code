package expo.modules.kinapprovalkey

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.annotation.RequiresApi
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.atomic.AtomicBoolean

private const val KEYSTORE = "AndroidKeyStore"

// One approval key per install. It only ever signs Kin grants, never connections.
private const val ALIAS = "kin.approval-key.v1"
private const val MIN_CHALLENGE_BYTES = 16
private const val MAX_CHALLENGE_BYTES = 128

internal object ApprovalKeyStore {
  // Two concurrent creates would share one alias, binding the returned chain to the wrong challenge.
  private val creating = AtomicBoolean(false)

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  fun has(): Boolean = keyStore().containsAlias(ALIAS)

  fun delete() {
    val store = keyStore()
    if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
  }

  fun create(context: Context, attestationChallenge: ByteArray): Map<String, Any> {
    if (!creating.compareAndSet(false, true)) {
      throw ApprovalKeyException(E_BUSY, "Another approval key is already being created.")
    }
    try {
      return createUngated(context, attestationChallenge)
    } finally {
      creating.set(false)
    }
  }

  private fun createUngated(context: Context, attestationChallenge: ByteArray): Map<String, Any> {
    // setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG) is API 30+; older devices get no key.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      throw ApprovalKeyException(E_UNSUPPORTED_OS, "Approval keys need Android 11 or later.")
    }
    // The server's registration nonce. KeyMint refuses challenges over 128 bytes.
    if (attestationChallenge.size !in MIN_CHALLENGE_BYTES..MAX_CHALLENGE_BYTES) {
      throw ApprovalKeyException(E_INVALID_INPUT, "attestationChallenge must be 16 to 128 bytes.")
    }
    return createOnR(context, attestationChallenge)
  }

  @RequiresApi(Build.VERSION_CODES.R)
  @Suppress("TooGenericExceptionCaught") // Never leave behind a key that failed its checks.
  private fun createOnR(context: Context, challenge: ByteArray): Map<String, Any> {
    if (has()) {
      throw ApprovalKeyException(
        E_KEY_EXISTS,
        "An approval key already exists; delete it first."
      )
    }
    val hasStrongBox = context.packageManager.hasSystemFeature(
      PackageManager.FEATURE_STRONGBOX_KEYSTORE
    )
    // StrongBoxUnavailableException is a ProviderException, and some StrongBox chips throw the plain
    // one for keys they can't make. Only those fall back to the TEE; anything else fails closed.
    val inStrongBox = hasStrongBox && try {
      generate(challenge, strongBox = true)
      true
    } catch (_: ProviderException) {
      delete()
      false
    }
    if (!inStrongBox) generate(challenge, strongBox = false)
    try {
      return describe(inStrongBox)
    } catch (error: Throwable) {
      delete()
      throw error
    }
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun describe(inStrongBox: Boolean): Map<String, Any> {
    val store = keyStore()
    val hardware = hardwareLevel(store.getKey(ALIAS, null) as PrivateKey, inStrongBox)
    val chain = store.getCertificateChain(ALIAS)
      ?: throw ApprovalKeyException(E_KEYSTORE, "The approval key has no attestation chain.")
    return mapOf(
      "publicKey" to encodeBase64Url(chain.first().publicKey.encoded),
      "hardware" to hardware,
      "attestationChain" to chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
    )
  }

  fun initSignature(): Signature {
    val key = keyStore().getKey(ALIAS, null) as? PrivateKey
      ?: throw ApprovalKeyException(E_KEY_NOT_FOUND, "There is no approval key on this device.")
    return try {
      Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
    } catch (error: KeyPermanentlyInvalidatedException) {
      throw ApprovalKeyException(
        E_KEY_INVALIDATED,
        "Biometric enrolment changed, so the approval key no longer works. Delete it and register a new one.",
        error
      )
    }
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun generate(challenge: ByteArray, strongBox: Boolean) {
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
      .setInvalidatedByBiometricEnrollment(true)
      .setAttestationChallenge(challenge)
      .setIsStrongBoxBacked(strongBox)
      .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply {
      initialize(spec)
      generateKeyPair()
    }
  }

  // Refuses keys the OS reports as software-backed, or whose biometric gate isn't the per-use,
  // strong-biometric-only, hardware-enforced one generate() asked for.
  @RequiresApi(Build.VERSION_CODES.R)
  private fun hardwareLevel(key: PrivateKey, inStrongBox: Boolean): String {
    val info = KeyFactory.getInstance(key.algorithm, KEYSTORE).getKeySpec(key, KeyInfo::class.java)
    // KeyInfo documents -1 for "every use"; 0 is what was requested. Either means per-use.
    val gated = info.isUserAuthenticationRequired &&
      info.userAuthenticationType == KeyProperties.AUTH_BIOMETRIC_STRONG &&
      info.userAuthenticationValidityDurationSeconds <= 0 &&
      info.isInvalidatedByBiometricEnrollment
    if (!gated) {
      throw ApprovalKeyException(
        E_KEYSTORE,
        "The approval key's biometric gate isn't the one requested."
      )
    }
    val secure = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      info.securityLevel != KeyProperties.SECURITY_LEVEL_SOFTWARE &&
        info.securityLevel != KeyProperties.SECURITY_LEVEL_UNKNOWN
    } else {
      @Suppress("DEPRECATION")
      info.isInsideSecureHardware
    }
    if (!secure || !info.isUserAuthenticationRequirementEnforcedBySecureHardware) {
      throw ApprovalKeyException(
        E_NO_SECURE_HARDWARE,
        "This device can't keep the approval key in secure hardware."
      )
    }
    // Advisory only: the server takes `hardware` from the attestation (approvals spec, section 4).
    val strongBoxLevel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    } else {
      inStrongBox
    }
    return if (strongBoxLevel) "strongbox" else "tee"
  }
}

internal fun decodeBase64Url(value: String): ByteArray {
  val alphabet = value.all {
    it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_'
  }
  val decoded = if (value.isNotEmpty() && alphabet) {
    runCatching {
      Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }.getOrNull()
  } else {
    null
  }
  return decoded ?: throw ApprovalKeyException(E_INVALID_INPUT, "Input is not base64url.")
}

internal fun encodeBase64Url(bytes: ByteArray): String =
  Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
