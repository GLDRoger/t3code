const { AndroidConfig, withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

// The types kinSharedFile.ts sends to an import screen (kinSharedFileInbox opens them).
const MIME_TYPES = [
  "application/pdf",
  "image/*",
  "text/csv",
  "text/comma-separated-values",
  "application/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const IOS_TYPES = [
  "com.adobe.pdf",
  "public.image",
  "public.comma-separated-values-text",
  "org.openxmlformats.spreadsheetml.sheet",
];

const filter = (action, data) => ({
  action: [{ $: { "android:name": `android.intent.action.${action}` } }],
  category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
  data: data.map((one) => ({ $: one })),
});

/**
 * Lists Kin under "Open in" (iOS, which hands over a copy, not the file in place) and under
 * Share and Open with (Android: SEND, read through expo-sharing's payloads, and VIEW) for the
 * files Kin's import screens read. No share extension.
 */
module.exports = function withKinOpensFiles(config) {
  const withIos = withInfoPlist(config, (next) => {
    next.modResults.CFBundleDocumentTypes = [
      // A second prebuild over the same Info.plist replaces Kin's entry, not repeats it.
      ...(next.modResults.CFBundleDocumentTypes ?? []).filter(
        (type) => type.CFBundleTypeName !== "Files Kin imports",
      ),
      {
        CFBundleTypeName: "Files Kin imports",
        CFBundleTypeRole: "Viewer",
        LSHandlerRank: "Alternate",
        LSItemContentTypes: IOS_TYPES,
      },
    ];
    next.modResults.LSSupportsOpeningDocumentsInPlace = false;
    return next;
  });
  return withAndroidManifest(withIos, (next) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(next.modResults);
    activity["intent-filter"] = [
      ...(activity["intent-filter"] ?? []),
      filter("SEND", MIME_TYPES.map((mimeType) => ({ "android:mimeType": mimeType }))),
      filter(
        "VIEW",
        MIME_TYPES.map((mimeType) => ({
          "android:scheme": "content",
          "android:mimeType": mimeType,
        })),
      ),
    ];
    return next;
  });
};
