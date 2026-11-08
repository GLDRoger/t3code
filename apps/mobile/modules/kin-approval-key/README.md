# kin-approval-key

The owner's approval key: a P-256 key in the Secure Enclave (iOS) or Android Keystore that signs Kin grants (`docs/kin/specs/approvals.md`, sections 4 and 5). Every signature needs Face ID, Touch ID or a strong biometric. The private key never leaves the hardware, and there is no software fallback.

This key only signs grants. It is separate from the relay DPoP key in `src/features/cloud/dpop.ts`.

## API (`index.ts`)

| Call                              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createKey(attestationChallenge)` | `{ publicJwk, hardware, attestation? }`. `attestationChallenge` is the server's registration nonce, unpadded base64url of 16 to 128 bytes. On Android, `attestation` is `{ format: "android-key", certificateChain }`, the Keystore chain (leaf first, base64 DER) with the nonce bound in. On iOS it is `{ format: "apple-app-attest", keyId, attestationObject }` (both base64), an App Attest attestation over `sha256(challenge ‖ public key)`. No `attestation` means the device can't attest; the server won't activate that key. Fails with `E_KEY_EXISTS` if a key is already there. |
| `sign(signingInput)`              | `signingInput` is a grant's JWS signing input, `b64url(header).b64url(payload)`. The module refuses it unless it is a well-formed grant, shows the user what it approves, takes a biometric, and signs the ASCII bytes with ES256. Returns the 64-byte low-S `r‖s` as base64url, the JWS's third part.                                                                                                                                                                                                                                                                                       |
| `hasKey()`                        | Whether a key exists. This never prompts. See the device tests for what it returns after invalidation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `deleteKey()`                     | Removes the key. Does nothing if there isn't one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### What the user sees

The caller doesn't choose the approval text. `ios/KinGrant.swift` and `android/.../KinGrant.java` parse the signing input natively and accept only canonical `stableStringify` JSON with the exact `KinGrant` header and fields (spec section 5), `approver.kid` equal to the header `kid`, an `iat` within 300 seconds of the device clock, and a kind that has a template. The text comes from a fixed template per kind:

| Kind                    | Text                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `merge_pull_request`    | Merge GLDRoger/t3code #212 (a1b2c3d4e5f60718) into "main" by squashing, then delete its branch |
| `delete_branch`         | Delete branch "kin/fix-212" (a1b2c3d4e5f60718) in GLDRoger/t3code                              |
| `set_level`             | Set lead "tech-lead" to L2 in chat "chat_7" (or "in all chats")                                |
| `change_rules`          | Change rules to "rules.md" (sha256 9f86d081884c7d65)                                           |
| `memory_purge`          | Purge memory using "purge/item-4.json" (sha256 9f86d081884c7d65)                               |
| `register_approver_key` | Add approver key NzbLsXh8uDCcd-6M (Secure Enclave, attested)                                   |

Every hash shows its first 16 characters. A shown value is never cleaned or cut: the grant is refused (`E_NOT_A_GRANT`) unless each value is ASCII from its field's allowlist, so nothing invisible, look-alike or reordering reaches the prompt and no platform Unicode table is involved:

- Repo: GitHub's `owner/name` rules (owner: letters, digits, `-`, up to 39; name: letters, digits, `. _ -`, up to 100).
- Branches (`base`, `ref`) and `path`: letters, digits and `. _ - / +`. That is a subset of what git allows, so a merge into a branch with other characters (non-ASCII, `@`, `#` and so on) can't be approved from the phone.
- `agentId`, `chatId`: letters, digits and `. _ -`.

`register_approver_key` also needs `hardware` (`secure_enclave`, `strongbox` or `tee`) and `attested: true` in its target: the server never activates an unattested key, so there is nothing to approve for one.

None of these allow a space or a quote, so the quotes around a value in the template can't be faked. A prompt over 200 characters is refused, so the merge method and ", then delete its branch" always show.

A new action kind needs a template in both parsers and new rows in `fixtures/grant-vectors.json`. The two parsers must agree; `test/native/run.sh` checks both against the vectors on a Mac with the Xcode command line tools and a JDK (no simulator or Android SDK). `src/grantVectors.test.ts` checks in CI that the accepted vectors are exactly what `stableStringify` writes.

The Android parser is Java rather than Kotlin so it compiles and runs with a plain JDK.

### Errors

The native side returns DER signatures. `src/derSignature.ts` converts them to compact low-S form and rejects anything that isn't canonical DER.

Error codes on rejected promises:

- `E_NOT_A_GRANT`: the signing input isn't a well-formed grant the module can describe.
- `E_BUSY`: another `sign` call hasn't settled yet. One signature at a time, on both platforms.
- `E_NO_SECURE_HARDWARE`: no Secure Enclave, or the Keystore says the key or its auth gate isn't in secure hardware.
- `E_UNSUPPORTED_OS`: Android before 11. Per-use `AUTH_BIOMETRIC_STRONG` keys need API 30.
- `E_BIOMETRY_UNAVAILABLE`: no strong biometric enrolled, or no passcode.
- `E_BIOMETRY_LOCKOUT`: too many failed attempts.
- `E_KEY_EXISTS`, `E_KEY_NOT_FOUND`.
- `E_KEY_INVALIDATED`: biometric enrolment changed since the key was made. See iOS below.
- `E_USER_CANCELED`: the user canceled, chose the fallback, or the app left the foreground mid-approval.
- `E_AUTH_FAILED`: the biometric didn't unlock the key.
- `E_NO_ACTIVITY`: the app isn't in the foreground or the device is locked, so nothing can be shown.
- `E_OBSCURED` (Face ID): Approve was tapped while something covered the confirmation sheet, after it had been clear for the arming delay. Nothing is signed. See the confirmation sheet below for what counts.
- `E_ATTESTATION_FAILED` (iOS): App Attest returned an error other than "unsupported", for example while offline. The new key is deleted, so `createKey` can be called again.
- `E_INVALID_INPUT`, `E_KEYCHAIN`, `E_KEYSTORE`.

## Platform notes

- **iOS:** the key is created with `SecKeyCreateRandomKey` and `kSecAttrTokenIDSecureEnclave`, gated by `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` with `[.privateKeyUsage, .biometryCurrentSet]`. It signs with `.ecdsaSignatureMessageX962SHA256` on the module's own `kin.approval-key` queue, so an open prompt never blocks Expo's shared queue. The queue is concurrent on purpose: `SecKeyCreateSignature` blocks its thread while Face ID is up, and a serial queue would hold a second call until the first finished and then show a second prompt, instead of rejecting it with `E_BUSY`. Each signature uses a fresh `LAContext` with `localizedFallbackTitle = ""`, so no earlier match is reused and there is no "Enter Password" button. `NSFaceIDUsageDescription` comes from `plugins/withKinApprovalKey.cjs`.
- **iOS confirmation sheet (Face ID, Optic ID):** `ios/ConfirmationSheet.swift` shows the grant text in a window the module owns, at `windowLevel = .alert + 1` in the foreground scene, so views the app's JS can add to its own window (a `FullWindowOverlay`, a modal) sit below it. It ends editing first, since a keyboard's input accessory view would sit above every app window.
  - **Arming.** A `CADisplayLink` checks coverage on every frame for as long as the sheet is up. Approve shows disabled and ignores taps until every frame for 0.7 s has found the sheet key and uncovered; any frame that isn't clear starts the 0.7 s over, so a cover hidden just before a check can't arm Approve early. Once Approve is enabled, the first frame that isn't key and clear disables it again and arming starts over, so a cover mounted after Approve arms and hidden on the first tap can't leave the second tap live. Arming also starts over when the sheet appears, when its window becomes or stops being key, when the scene activates or deactivates, and when the keyboard shows or hides. So JS can't draw a button where Approve will appear and catch the second tap of a double tap, or hide a cover just after the first tap. Coverage is checked once more at the tap.
  - **Picture in picture.** Before it shows, and about every 10 frames while it is up, the sheet calls `closeAllMediaPresentations` on every `WKWebView` in the app's windows, which ends picture in picture (and fullscreen video) the app's web views start, such as the browser preview's stream of JS-drawn frames or one tampered JS starts with `injectJavaScript`. The module can't see or end other picture-in-picture windows (another app's, one from `expo-video`, or one started by a web view that isn't in a window, such as on a screen under a pushed screen), which the system draws above every app window and which take taps inside their own frame; see the approvals spec's threat model.
  - **Covered** means: the keyboard is up (tracked by `keyboardWillShow` and `keyboardDidHide`), a controller is presented over the sheet (RN's `Alert`), another window in the scene at its level or above is visible, or a view of the app's own classes sits over the card in the sheet's window. Windows that are hidden, have alpha 0 or have no subviews are skipped: they aren't drawn or hit-tested, and JS draws only with views. The keyboard's host windows (`UIRemoteKeyboardWindow`, `UITextEffectsWindow`) outlive the keyboard, so they count only while they hold app views (an `InputAccessoryView` or an `OverKeyboardView` left behind). UIKit's own views in the sheet's window, such as the iPad pointer-hover container, are skipped the same way.
  - **Not key** (RN's `Alert.hide()` leaves no key window): the sheet calls `makeKey()` once per arming and the delay starts over, instead of failing.
  - A tap that reaches an armed Approve while the sheet is covered rejects with `E_OBSCURED`. The window is removed on every outcome. Cancel, the sheet disappearing without a choice, or the scene going to the background reject with `E_USER_CANCELED`.
- **iOS App Attest:** after making the Secure Enclave key, `createKey` makes a fresh App Attest key with `DCAppAttestService` and attests it over the client data hash `sha256(challenge ‖ 0x04 ‖ x ‖ y)` of the key it just made. JS passes only the server's challenge, so it can't get an attestation over a key or data of its own. Where App Attest isn't supported (simulator, older devices, or `DCError.featureUnsupported`), there is no `attestation`. The entitlement `com.apple.developer.devicecheck.appattest-environment` comes from `plugins/withKinApprovalKey.cjs`: `development` for development builds, `production` otherwise, and none for personal-team builds.
- **iOS re-enrolment:** `createKey` stores `LAContext.domainState.biometry.stateHash` in the keychain (this device only, never exported). A failed signature reports `E_KEY_INVALIDATED` rather than `E_AUTH_FAILED` when the stored hash differs from the current one. A mismatch alone never blocks signing, because Apple warns the hash can change across major OS versions with no enrolment change; after a successful signature, the stored hash is refreshed.
- **Android:** an EC `secp256r1` key with `PURPOSE_SIGN` and `DIGEST_SHA256`, `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` and `setInvalidatedByBiometricEnrollment(true)`. It tries StrongBox first and falls back to the TEE only on a `ProviderException` (which includes `StrongBoxUnavailableException`). After creation it checks `KeyInfo`: secure hardware, strong-biometric-only, per-use, invalidated by enrolment. Parsing and `Signature.initSign` run off the main thread; `BiometricPrompt` runs on it with a `CryptoObject(Signature)`, and the callback signs only if it gets back that exact `Signature`. The prompt is canceled if the activity stops, and after 300 seconds (the grant would be stale to the server by then).
- **Android limitation:** `androidx.biometric` keeps one callback per activity, so a second `BiometricPrompt` made on the same activity while ours is open (by other code in the app) replaces our callback, and there's no public API to notice. Our call then settles only when the activity stops or the 300-second timeout fires, and until then `sign` returns `E_BUSY`. It can never sign the other prompt's operation, because the callback signs only its own `Signature`. Canceling on timeout can close the other prompt too. The module depends on `androidx.biometric:biometric:1.1.0`, the latest stable release.

## Device tests (security test 22)

These can't run in a simulator or emulator, because neither has a Secure Enclave or a real biometric sensor. Run them on one iPhone with Face ID, one with Touch ID if available, and one Pixel with StrongBox, each on a development build of this checkout (`vp run mobile:install <ios|android> <device-id>`). Drive the calls from a debug screen or the Metro console with `import * as ApprovalKey from "../modules/kin-approval-key"`. Before each run, call `deleteKey()` and set up biometrics.

Build signing inputs with the server's encoder, from `packages/shared`:

```sh
node --experimental-strip-types --input-type=module -e '
import { stableStringify } from "./src/relaySigning.ts";
const b = (o) => Buffer.from(stableStringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "ES256", kid: "test", typ: "kin-grant+jws" };
const payload = { v: 1, orgId: "org", actionId: "act_test", revision: 0, nonce: "n", jti: crypto.randomUUID(),
  kind: "merge_pull_request", targetDigest: "0".repeat(64), headSha: "a1b2c3d".padEnd(40, "0"), base: "main",
  mergeMethod: "squash", target: { _tag: "pull_request", host: "github.com", repo: "GLDRoger/t3code", number: 212,
  mergeMethod: "squash", deleteBranchAfter: false }, approver: { humanId: "h", kid: "test" }, decision: "approve",
  iat: now, exp: now + 600 };
console.log(`${b(header)}.${b(payload)}`);
'
```

`iat` must be within 300 seconds of the phone's clock, so make a fresh input for each run.

### 1. Signing without biometrics fails

1. Call `createKey(<base64url of 32 random bytes>)`. Check that `hardware` is `secure_enclave` on iOS and `strongbox` on the Pixel (`tee` if StrongBox is unavailable). On iOS, it must not reject with `E_KEYCHAIN` "Exporting the approval public key failed": that means `SecKeyCopyAttributes` returned no `klbl` (`kSecAttrApplicationLabel`) for the Secure Enclave key, which the attestation-failure cleanup relies on. On Android, check that `attestation.certificateChain` has at least 2 entries; on iOS, that `attestation.format` is `apple-app-attest`. In airplane mode, iOS rejects with `E_ATTESTATION_FAILED` and `hasKey()` is then `false`.
2. Call `sign(<input>)`. **The prompt shows `Merge GLDRoger/t3code #212 (a1b2c3d000000000) into "main" by squashing`**: in the confirmation sheet on Face ID, in the system prompt on Touch ID and Android. Pass the biometric check. It resolves to an 86-character base64url string (64 bytes).
3. Call `sign` again and **cancel** the prompt (and, on Face ID, the sheet). It rejects with `E_USER_CANCELED`.
4. Call `sign` again and fail the biometric 5 times (cover the camera, or use an unenrolled finger). It rejects with `E_AUTH_FAILED` or `E_BIOMETRY_LOCKOUT`, and never resolves.
5. While locked out, unlock the phone with the passcode or PIN, then call `sign` and fail the biometric once more. The passcode or PIN never produces a signature: there is no "Enter Password" or "Use PIN" option on the prompt.
6. Call `sign` twice in a row. **Each call shows a prompt.** A match from the first call is never reused.
7. With biometrics turned off for the app (iOS: Settings → Face ID & Passcode → Other Apps; Android: remove all fingerprints), `sign` rejects with `E_BIOMETRY_UNAVAILABLE` or `E_AUTH_FAILED`.
8. On an Android phone whose only biometric is face unlock that isn't Class 3, `createKey` and `sign` reject with `E_BIOMETRY_UNAVAILABLE`.
9. Call `sign` with any other bytes, for example `b64url("test").b64url("{}")`, and with the input from step 2 with `typ` changed, a field added, or `base` set to `"ma\u00a0in"`. Each rejects with `E_NOT_A_GRANT` before any prompt.
10. Make an input whose prompt is exactly 200 characters (step 2 with `mergeMethod: "merge"`, `deleteBranchAfter: true` and `base` of 103 `x`). The whole text, ending ", then delete its branch", shows without truncation in the sheet, the Touch ID prompt and `BiometricPrompt`. With 104 `x`, it rejects with `E_NOT_A_GRANT`.

### 2. One signature at a time

1. Call `sign(inputA)` and, while its prompt is up, `sign(inputB)` with a different `number`. The second rejects at once with `E_BUSY`, and only one prompt is ever shown. Approve it: the first resolves, and its signature verifies for `inputA` only (section 4 below), never for `inputB`.
2. Call `sign` and send the app to the background while the prompt (or the Face ID sheet) is up. It rejects with `E_USER_CANCELED`. Bring the app back: no prompt is left, the promise never resolves later, and the next `sign` works (it doesn't get `E_BUSY`).
3. Call `sign` from a timer while the app is in the background, and again while the phone is locked. Both reject (`E_NO_ACTIVITY` expected) without showing a prompt or signing.
4. Android, on a phone with an in-display fingerprint sensor: rest a finger on the sensor, then call `sign` from a timer. The prompt shows the grant text and doesn't sign from the finger that was already there; it signs only after you lift and touch again (record what happens).
5. Android: call `sign` and, while its prompt is up, start a second `BiometricPrompt` on the activity (for example `expo-local-authentication`'s `authenticateAsync`). Pass that one. Our call doesn't resolve; it rejects with `E_USER_CANCELED` when the app goes to the background or 300 seconds after the prompt opened, and the next `sign` works.

### 2a. An overlay over the sheet can't approve (Face ID)

1. Render a `FullWindowOverlay` (react-native-screens) with `pointerEvents="none"` and an opaque box over the middle of the screen, then call `sign`. The sheet shows above the box, its text readable. Approve signs.
2. Mount the same overlay from a timer 2 seconds after calling `sign`, while the sheet is up. It still appears below the sheet. Approve signs.
3. While the sheet is up, focus a `TextInput` that has an `InputAccessoryView` with an opaque box, from a timer. While the keyboard or its accessory is up, Approve shows disabled and taps do nothing. Dismiss it: Approve enables 0.7 s later and signs.
4. While the sheet is up, call `Alert.alert` from a timer. Dismiss that alert, then tap Approve: it signs, and only the grant's text was ever on the sheet.
5. Type in a `TextInput` and leave the keyboard open, then call `sign`. The keyboard closes, the sheet shows, and Approve signs (no `E_OBSCURED`). Repeat after the keyboard has been dismissed.
6. **Double tap.** Draw a JS button where Approve will appear whose `onPressIn` calls `sign`. Double-tap it quickly. The sheet shows with Approve disabled, the second tap does nothing, and nothing is signed until Approve enables and is tapped again. Repeat with a triple tap.
7. **Cover, then uncover.** While the sheet is up, put an opaque box over Approve two ways: an `OverKeyboardView` (react-native-keyboard-controller), and an `InputAccessoryView` on a `TextInput` focused from a timer. Hide each from its own `onPressIn`. Tap the box: nothing is signed, and Approve enables only 0.7 s after the box is gone. Then open the keyboard, mount the `OverKeyboardView` and call `sign`: the keyboard closes, the view is left in the keyboard's window, and Approve stays disabled until the view is removed. **Randomised hide:** about 50 times, mount the `OverKeyboardView` over Approve while the sheet is up and hide it from a timer with a random delay of 0 to 1.5 s, logging when it hid (`performance.now()`) and when Approve enabled (watch `isEnabled`, or record the screen at 120 fps). Approve must never enable less than 0.7 s after the box is gone. **Cover after arming:** wait until Approve enables, then mount the `OverKeyboardView` over it and hide it from its own `onPressIn`. Approve disables within a frame of the box appearing. Tap twice quickly: the first tap lands on the box, the second does nothing, and Approve enables again only 0.7 s after the box is gone.
8. **Alert, then no key window.** Call `Alert.alert` from a timer while the sheet is up, then dismiss it. Approve enables within about a second and signs (the sheet takes key back), with no `E_OBSCURED`.
9. **iPad pointer.** With a trackpad or mouse, hover over Approve until the pointer highlights it, then click. It signs (no `E_OBSCURED`, Approve not stuck disabled).
10. **VoiceOver.** Turn VoiceOver on and call `sign`. The grant text is read, Approve is announced dimmed until it arms, and double-tapping it then signs. **Full Keyboard Access:** on an iPad with a hardware keyboard, Tab to Approve and press Space; the same.
11. **Stage Manager and Split View (iPad).** Call `sign` with Kin in Split View, then in Stage Manager overlapped by another app's window. Tap the other app, then back into Kin's sheet: Approve is disabled for 0.7 s after Kin's window becomes key again, then signs. Record whether the other app's window can cover the sheet while Approve is armed.
12. **Picture in picture.** Start the browser preview's picture in picture, then call `sign`: the PiP window closes as the sheet shows. With the sheet up, start web-view picture in picture from a timer (`injectJavaScript` calling `requestPictureInPicture()` on a playing `<video>`): it closes within a fraction of a second. Then start a video in picture in picture from Safari, drag it over the sheet's text and tap Approve: it signs, because the module can't see or end another app's PiP window (accepted in the approvals spec's threat model). Record both, and whether the PiP window could take the tap.

### 3. Re-enrolling biometrics invalidates the key

1. Call `createKey`, then `sign` once to confirm it works.
2. iOS: add an alternate appearance (Face ID) or another finger (Touch ID). Android: add another fingerprint.
3. Call `hasKey()` and record the result. Then call `sign`. It **must reject**: `E_KEY_INVALIDATED` on both platforms. Record whether iOS showed Face ID first, and the exact error.
4. Remove the added enrolment and call `sign` again. It must still fail, because invalidation is permanent.
5. `deleteKey()`, then `createKey`, then `sign` works again.
6. Remove the device passcode (iOS) or screen lock (Android). iOS deletes the key: record what `hasKey()` and `sign` return. Android: `sign` rejects with `E_KEY_INVALIDATED`. Restore the lock, `deleteKey()`, `createKey`.

### 4. DER signatures convert to compact and verify on the server

1. Call `createKey` and copy `publicJwk`.
2. Make a signing input as above, call `sign(signingInput)` and copy the result.
3. On a computer, from `packages/shared` (it has both `@noble` packages):

   ```sh
   node -e '
   const { p256 } = require("@noble/curves/nist");
   const { sha256 } = require("@noble/hashes/sha2");
   const [jwk, input, sig] = [JSON.parse(process.argv[1]), process.argv[2], process.argv[3]];
   const b = (s) => Buffer.from(s, "base64url");
   const key = Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]);
   console.log(p256.verify(b(sig), sha256(Buffer.from(input)), key, { prehash: false, format: "compact", lowS: true }));
   ' '<publicJwk JSON>' '<signingInput>' '<signature>'
   ```

   It prints `true`. Change one character of the signing input and it prints `false`.

4. Repeat steps 2 and 3 twenty times on each device. Roughly half the raw signatures have a high-bit `r` or `s` (a 33-byte DER INTEGER) and half have a high `s`, so this covers the sign-byte and low-S paths on real hardware.

### 5. Attestation

1. Call `createKey(<nonce>)` with a recorded 32-byte nonce and save `attestation.certificateChain`.
2. Android: check it offline: the root is a Google hardware attestation root; the leaf's public key equals `publicJwk`; the KeyDescription's `attestationChallenge` is the nonce; the attestation and KeyMint security levels are `StrongBox` on the Pixel (`TrustedEnvironment` on TEE devices); `hardwareEnforced` has purpose `SIGN`, EC P-256, SHA-256, a biometric `userAuthType`, and no `authTimeout` or `noAuthRequired`. Record the tool and its output.
3. iOS: save `attestation.keyId` and `attestation.attestationObject` and check them offline per Apple's steps (approvals spec, section 4): the `x5c` chain verifies to the Apple App Attest root; the nonce extension equals `sha256(authData ‖ sha256(nonce ‖ 0x04 ‖ x ‖ y))` from `publicJwk`; the RP ID hash is `sha256("<teamId>.<bundleId>")`; the counter is 0; the aaguid is `appattestdevelop` on a development build. Record the tool and its output.

### 6. Reinstall and restore

1. iOS: with a key present, delete the app and reinstall it. Record what `hasKey()` returns and whether `createKey` fails with `E_KEY_EXISTS` (the keychain can outlive the app), and whether `sign` still works.
2. Restore a backup of a phone with a key onto a new device. `hasKey()` is `false` on both platforms (`ThisDeviceOnly`; Keystore keys aren't backed up), and `createKey` works.

Record the date, device, OS version and result of each step in the APPR-6 PR.
