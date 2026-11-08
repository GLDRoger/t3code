const { withInfoPlist } = require("expo/config-plugins");

// No app name: source stays unbranded (KIN.md), and $(PRODUCT_NAME) would show the build target's name.
const FACE_ID_USAGE = "Face ID confirms the merges and other actions you approve.";

// Set unconditionally so expo-secure-store's generic default never wins, whichever mod runs first.
module.exports = function withKinApprovalKey(config) {
  return withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.NSFaceIDUsageDescription = FACE_ID_USAGE;
    return nextConfig;
  });
};
