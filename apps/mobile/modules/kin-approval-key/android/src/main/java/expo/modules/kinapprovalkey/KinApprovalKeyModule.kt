package expo.modules.kinapprovalkey

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.Signature
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class KinApprovalKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KinApprovalKey")

    AsyncFunction("createKey") { attestationChallenge: String ->
      val context = appContext.reactContext ?: throw ApprovalKeyException(E_NO_ACTIVITY, "The app is not active.")
      requireStrongBiometrics(BiometricManager.from(context))
      ApprovalKeyStore.create(context, decodeBase64Url(attestationChallenge))
    }

    // Runs on the modules queue, so parsing and Keystore work stay off the main thread.
    AsyncFunction("signDer") { signingInput: String, promise: Promise ->
      SignRequest.start(appContext.currentActivity, signingInput, promise)
    }

    AsyncFunction("hasKey") { ApprovalKeyStore.has() }

    AsyncFunction("deleteKey") { ApprovalKeyStore.delete() }
  }
}

/** One `sign` call. Only one may be in flight; every path settles its promise exactly once. */
private class SignRequest private constructor(private val promise: Promise) {
  private val settled = AtomicBoolean(false)

  @Volatile private var cleanup: (() -> Unit)? = null

  companion object {
    private val busy = AtomicBoolean(false)
    private val signer = Executors.newSingleThreadExecutor()

    fun start(activity: Activity?, signingInput: String, promise: Promise) {
      if (!busy.compareAndSet(false, true)) {
        promise.reject(ApprovalKeyException(E_BUSY, "Another approval is already waiting for the user."))
        return
      }
      SignRequest(promise).prepare(activity, signingInput)
    }
  }

  @Suppress("TooGenericExceptionCaught") // Every failure must settle the promise and free the gate.
  private fun prepare(activity: Activity?, signingInput: String) {
    try {
      val prompt = try {
        KinGrant.prompt(signingInput, System.currentTimeMillis() / MILLIS_PER_SECOND)
      } catch (error: KinGrant.NotAGrantException) {
        throw ApprovalKeyException(E_NOT_A_GRANT, "Only Kin grants can be signed: ${error.message}.", error)
      }
      val host = activity as? FragmentActivity
        ?: throw ApprovalKeyException(E_NO_ACTIVITY, "No foreground activity to show the prompt in.")
      requireStrongBiometrics(BiometricManager.from(host))
      val signature = ApprovalKeyStore.initSignature()
      // KinGrant accepted it, so it is two base64url segments: plain ASCII.
      val message = signingInput.toByteArray(Charsets.US_ASCII)
      ContextCompat.getMainExecutor(host).execute { show(host, prompt, signature, message) }
    } catch (error: Throwable) {
      reject(error)
    }
  }

  @Suppress("TooGenericExceptionCaught")
  private fun show(activity: FragmentActivity, prompt: String, signature: Signature, message: ByteArray) {
    try {
      val foreground = activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
      // BiometricPrompt.authenticate silently does nothing once state is saved.
      if (!foreground || activity.supportFragmentManager.isStateSaved) {
        throw ApprovalKeyException(E_NO_ACTIVITY, "Approvals need the app in the foreground.")
      }
      val biometricPrompt =
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback(signature, message))
      // The system prompt can outlive the screen; an approval must not.
      val observer = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) {
          reject(ApprovalKeyException(E_USER_CANCELED, "The app left the foreground during approval."))
          biometricPrompt.cancelAuthentication()
        }
      }
      activity.lifecycle.addObserver(observer)
      // androidx.biometric keeps one callback per activity, so a later BiometricPrompt replaces ours
      // and we'd never hear back. The grant is stale to the server after 300 s anyway.
      val handler = Handler(Looper.getMainLooper())
      val timeout = Runnable {
        reject(ApprovalKeyException(E_USER_CANCELED, "The approval timed out."))
        biometricPrompt.cancelAuthentication()
      }
      handler.postDelayed(timeout, PROMPT_TIMEOUT_MILLIS)
      cleanup = {
        handler.removeCallbacks(timeout)
        ContextCompat.getMainExecutor(activity).execute { activity.lifecycle.removeObserver(observer) }
      }
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Confirm approval")
        .setDescription(prompt)
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .setNegativeButtonText(activity.getString(android.R.string.cancel))
        .setConfirmationRequired(true)
        .build()
      biometricPrompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
    } catch (error: Throwable) {
      reject(error)
    }
  }

  private fun callback(signature: Signature, message: ByteArray) = object : BiometricPrompt.AuthenticationCallback() {
    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
      // androidx.biometric keeps one callback and one CryptoObject per activity, so a prompt from
      // elsewhere could hand this callback an operation that isn't ours. Only sign our own.
      if (result.cryptoObject?.signature !== signature) {
        reject(ApprovalKeyException(E_AUTH_FAILED, "The prompt unlocked a different operation."))
        return
      }
      if (settled.get()) return
      signer.execute { signUnlocked(signature, message) }
    }

    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
      reject(authenticationError(errorCode, errString.toString()))
    }

    // A non-matching finger keeps the prompt open; only the terminal callbacks settle the promise.
    override fun onAuthenticationFailed() = Unit
  }

  @Suppress("TooGenericExceptionCaught")
  private fun signUnlocked(signature: Signature, message: ByteArray) {
    try {
      signature.update(message)
      resolve(encodeBase64Url(signature.sign()))
    } catch (error: Throwable) {
      reject(ApprovalKeyException(E_KEYSTORE, "Signing failed.", error))
    }
  }

  private fun resolve(value: String) {
    if (finish()) promise.resolve(value)
  }

  private fun reject(error: Throwable) {
    if (!finish()) return
    promise.reject(error as? CodedException ?: ApprovalKeyException(E_KEYSTORE, "Approval failed.", error))
  }

  private fun finish(): Boolean {
    if (!settled.compareAndSet(false, true)) return false
    busy.set(false)
    cleanup?.invoke()
    return true
  }
}

private const val MILLIS_PER_SECOND = 1000L
private const val PROMPT_TIMEOUT_MILLIS = 300_000L

private fun requireStrongBiometrics(manager: BiometricManager) {
  when (manager.canAuthenticate(BIOMETRIC_STRONG)) {
    BiometricManager.BIOMETRIC_SUCCESS -> Unit
    else -> throw ApprovalKeyException(
      E_BIOMETRY_UNAVAILABLE,
      "A strong biometric (fingerprint or face) must be enrolled to use the approval key."
    )
  }
}

private fun authenticationError(errorCode: Int, message: String): ApprovalKeyException {
  val code = when (errorCode) {
    BiometricPrompt.ERROR_USER_CANCELED,
    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
    BiometricPrompt.ERROR_CANCELED -> E_USER_CANCELED
    BiometricPrompt.ERROR_LOCKOUT,
    BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> E_BIOMETRY_LOCKOUT
    BiometricPrompt.ERROR_NO_BIOMETRICS,
    BiometricPrompt.ERROR_HW_NOT_PRESENT,
    BiometricPrompt.ERROR_HW_UNAVAILABLE -> E_BIOMETRY_UNAVAILABLE
    else -> E_AUTH_FAILED
  }
  return ApprovalKeyException(code, "Biometric prompt ended: $message ($errorCode).")
}

internal const val E_NO_SECURE_HARDWARE = "E_NO_SECURE_HARDWARE"
internal const val E_UNSUPPORTED_OS = "E_UNSUPPORTED_OS"
internal const val E_BIOMETRY_UNAVAILABLE = "E_BIOMETRY_UNAVAILABLE"
internal const val E_BIOMETRY_LOCKOUT = "E_BIOMETRY_LOCKOUT"
internal const val E_KEY_EXISTS = "E_KEY_EXISTS"
internal const val E_KEY_NOT_FOUND = "E_KEY_NOT_FOUND"
internal const val E_KEY_INVALIDATED = "E_KEY_INVALIDATED"
internal const val E_USER_CANCELED = "E_USER_CANCELED"
internal const val E_AUTH_FAILED = "E_AUTH_FAILED"
internal const val E_BUSY = "E_BUSY"
internal const val E_NOT_A_GRANT = "E_NOT_A_GRANT"
internal const val E_NO_ACTIVITY = "E_NO_ACTIVITY"
internal const val E_INVALID_INPUT = "E_INVALID_INPUT"
internal const val E_KEYSTORE = "E_KEYSTORE"

internal class ApprovalKeyException(code: String, message: String, cause: Throwable? = null) :
  CodedException(code, message, cause)
