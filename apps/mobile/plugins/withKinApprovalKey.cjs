const { withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

// No app name: source stays unbranded (KIN.md), and $(PRODUCT_NAME) would show the build target's name.
const FACE_ID_USAGE = "Face ID confirms the merges and other actions you approve.";
const APP_ATTEST_ENVIRONMENT = "com.apple.developer.devicecheck.appattest-environment";

// `appAttestEnvironment` is "development" or "production", or null where the signing team can't
// hold the App Attest capability (personal teams); keys made there are unattested.
module.exports = function withKinApprovalKey(config, { appAttestEnvironment = null } = {}) {
  if (![null, "development", "production"].includes(appAttestEnvironment)) {
    throw new Error(
      "withKinApprovalKey: appAttestEnvironment must be development, production or null.",
    );
  }
  // Set unconditionally so expo-secure-store's generic default never wins, whichever mod runs first.
  const withUsage = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.NSFaceIDUsageDescription = FACE_ID_USAGE;
    return nextConfig;
  });
  return withEntitlementsPlist(withUsage, (nextConfig) => {
    if (appAttestEnvironment) nextConfig.modResults[APP_ATTEST_ENVIRONMENT] = appAttestEnvironment;
    else delete nextConfig.modResults[APP_ATTEST_ENVIRONMENT];
    return nextConfig;
  });
};
