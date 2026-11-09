/** Only web links open from Kin; anything else an agent wrote (`tel:`, `t3code://`) is dropped. */
export function kinSafeWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

// The first host the text names, with or without a scheme: "github.com/o/r", "https://t3.codes".
const TEXT_HOST = /(?:^|[\s(<])(?:[a-z][a-z0-9+.-]*:\/\/)?((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)/i;

/**
 * The author picks a link's text, so the label names the real host unless the text already names
 * it. Text that names no host ("PR 212") stays as written on a GitHub link, like task cards.
 */
export function kinLinkLabel(text: string, url: URL): string {
  const host = url.hostname.toLowerCase();
  const textHost = TEXT_HOST.exec(text)?.[1]?.toLowerCase();
  if (textHost === host || (textHost === undefined && host === "github.com")) return text;
  return `${text} · ${host}`;
}
