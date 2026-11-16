const withoutHash = (url: string) => url.split("#", 1)[0];

/**
 * Whether a message the visual's WebView received may be read as the page's own. iOS hands the
 * bridge to every frame but says which page sent it, so only the outer document, which holds no
 * agent content, may speak.
 */
export const fromVisualPage = (platform: string, messageUrl: string, pageUri: string) =>
  // Android reports only the sender's origin ("null" for this sandboxed page) and the library drops
  // whether it is the main frame, so there the message's shape and the touch window guard it.
  platform !== "ios" || withoutHash(messageUrl) === withoutHash(pageUri);
