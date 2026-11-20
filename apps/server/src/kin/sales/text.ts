/** What the sales seat's tools tell an agent: their descriptions and the lines their results carry. */

export const PIPELINE_READ_DESCRIPTION = "Read the pipeline. Read-only.";

export const WEB_PAGE_DESCRIPTION = "Read one public https page as text.";

/** `pipeline_read`'s line: whose view it is and what Kin counted in it. */
export const pipelineLine = (
  _who: ReadonlyArray<string>,
  open: number,
  stages: number,
  concerns: number,
) => `${open} open deals, ${stages} stages, ${concerns} concerns.`;
/** A shared turn's view mine with no one person behind it. */
export const PIPELINE_MINE_NOBODY =
  "This turn isn't for one person, so it has no deals of theirs: read view totals instead.";

/** `web_page`'s line for a page read. */
export const pageLine = (title: string, characters: number, cut: boolean) =>
  `${title}: ${characters}${cut ? "+" : ""} characters.`;
export const PAGE_REFUSED = "Refused: not a public internet address.";
export const PAGE_NOT_HTTPS = "Refused: Kin reads only https addresses.";
export const pageTooBig = (megabytes: number) =>
  `Not read: the page is larger than ${megabytes} MB, so Kin stopped. Try a more specific page.`;
export const pageTooSlow = (seconds: number) =>
  `Not read: the page took longer than ${seconds} seconds, so Kin stopped. Try again later or another page.`;
export const pageStatus = (status: number) => `Not read: the site answered ${status}.`;
export const PAGE_NOT_TEXT = "Not read: that address isn't a web page Kin can read as text.";
export const PAGE_TOO_MANY_REDIRECTS = "Not read: the page redirected too many times.";
export const PAGE_UNREACHABLE = "Not read: Kin couldn't reach that site.";
