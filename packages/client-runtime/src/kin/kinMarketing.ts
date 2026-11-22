import {
  KIN_CAMPAIGN_SOURCE,
  KIN_TAGS_MAX,
  type KinCameFrom,
  type KinCampaignResults,
  type KinContactList,
  type KinContactListInput,
  type KinOrgId,
  type KinPartiesInput,
} from "@t3tools/contracts";

import { KIN_LISTS, kinMoneyText } from "./kinLists.ts";
import { kinCount } from "./kinCount.ts";

/** Marketing's words and rules, the same on web and phone: campaigns, tags, lists and exports. */
export const KIN_MARKETING = {
  campaign: "Campaign",
  campaignHint: "Counts the prospects and clients that came from it, and their deals.",
  audience: "Audience",
  audienceHint: "A tag. Its list is every contact carrying it.",
  audiencePlaceholder: "harbour",
  tags: "Tags",
  tagPlaceholder: "Add a tag",
  addTag: "Add",
  removeTag: (tag: string) => `Remove tag ${tag}`,
  tagsHint:
    "Tags are the company's own words. A list is every contact with a tag, saved as a filter; export it to your mail tool from the list.",
  tagsFull: `A contact takes at most ${KIN_TAGS_MAX} tags.`,
  cameFrom: "Came from",
  cameFromAnywhere: "Anywhere",
  cameFromCampaigns: "Campaigns",
  cameFromOwnWords: "Or type where they came from",
  tag: "Tag",
  anyTag: "Any tag",
  results: "Results so far",
  resultsNone: "nothing yet",
  prospects: "Prospects from it",
  clients: "Clients from it",
  deals: "Deals from them",
  won: "Won",
  onList: "People on its list",
  noAudience: "Choose an audience tag to make its list.",
  resultsNote:
    'Counted by Kin from the prospects and clients whose "came from" is this campaign, as far as you can see them.',
  exportList: "Export list",
  exporting: "Exporting…",
  exportFailed: "Couldn't export the list.",
  list: "List",
  listEmpty: "No one on this list yet.",
  listEmptyDetail: "Add the tag to contacts on their client's page to put them on it.",
  cameFromEmpty: "No prospects or clients came from here yet.",
  cameFromEmptyDetail: 'Choose this campaign in "Came from" on a prospect or client.',
  dealsEmpty: "No deals counted here yet.",
  listFailed: KIN_LISTS.entriesFailed,
  namesOnly: "You see names only. Emails and phone numbers stay with Clients.",
  contacts: (n: number) => `${n} ${n === 1 ? "contact" : "contacts"}`,
  listMore: (shown: number, total: number) =>
    `Showing ${shown} of ${total}. Export the list to get everyone.`,
};

/** What two tags are compared by, as the host compares them: their case never makes them two. */
const kinTagFold = (tag: string) => tag.trim().normalize("NFC").toLowerCase();

const kinTagOn = (tags: ReadonlyArray<string>, tag: string) =>
  tags.some((one) => kinTagFold(one) === kinTagFold(tag));

/**
 * The tags with one more, typed or picked, and what the field holds after: one already there in
 * any case is not added twice; a twenty-first stays in the field (`kinTagsFull` says why).
 */
export function kinTagAdd(
  tags: ReadonlyArray<string>,
  typed: string,
): { readonly tags: ReadonlyArray<string>; readonly typed: string } {
  const tag = typed.trim();
  if (tag === "") return { tags, typed };
  if (kinTagOn(tags, tag)) return { tags, typed: "" };
  if (tags.length >= KIN_TAGS_MAX) return { tags, typed };
  return { tags: [...tags, tag], typed: "" };
}

/** The limit, in the form's words, while what is typed would be a twenty-first tag. */
export const kinTagsFull = (tags: ReadonlyArray<string>, typed: string) =>
  tags.length >= KIN_TAGS_MAX && typed.trim() !== "" && !kinTagOn(tags, typed.trim())
    ? KIN_MARKETING.tagsFull
    : null;

export const kinTagsWithout = (tags: ReadonlyArray<string>, tag: string) =>
  tags.filter((one) => kinTagFold(one) !== kinTagFold(tag));

/** The company's tags to pick from: not already on it, matching what is typed, a few at a time. */
export function kinTagChoices(
  tags: ReadonlyArray<string>,
  company: ReadonlyArray<string>,
  typed: string,
  max = 8,
): ReadonlyArray<string> {
  const on = new Set(tags.map(kinTagFold));
  const wanted = kinTagFold(typed);
  return company
    .filter((one) => !on.has(kinTagFold(one)) && kinTagFold(one).includes(wanted))
    .slice(0, max);
}

/** A stored source as people read it: a campaign by its name, anything else as written. */
export function kinCameFromLabel(source: string, choices: ReadonlyArray<KinCameFrom>): string {
  const known = choices.find((one) => one.source === source);
  if (known !== undefined) return known.label;
  return source.startsWith(KIN_CAMPAIGN_SOURCE) ? KIN_MARKETING.campaign : source;
}

export const kinIsCampaignSource = (source: string) => source.startsWith(KIN_CAMPAIGN_SOURCE);

export type KinCampaignResultId = "prospects" | "clients" | "deals" | "won" | "audience";
export interface KinCampaignResultRow {
  readonly id: KinCampaignResultId;
  readonly label: string;
  /** "14", "5 · €61,000 · $5,000" (each currency on its own), "212 contacts". */
  readonly value: string;
}

const counted = (count: number, values: KinCampaignResults["open"]["values"]) =>
  [String(count), ...values.map((money) => kinMoneyText(money))].join(" · ");

/** A campaign's results as rows; each opens the list it counts. Deals only while they are on. */
export function kinCampaignResultRows(
  results: KinCampaignResults,
  audience: string | null | undefined,
  deals: boolean,
): ReadonlyArray<KinCampaignResultRow> {
  return [
    { id: "prospects", label: KIN_MARKETING.prospects, value: String(results.prospects) },
    { id: "clients", label: KIN_MARKETING.clients, value: String(results.clients) },
    ...(deals
      ? [
          {
            id: "deals" as const,
            label: KIN_MARKETING.deals,
            value: counted(results.open.count, results.open.values),
          },
          {
            id: "won" as const,
            label: KIN_MARKETING.won,
            value: counted(results.won.count, results.won.values),
          },
        ]
      : []),
    ...(audience == null
      ? []
      : [
          {
            id: "audience" as const,
            label: KIN_MARKETING.onList,
            value: KIN_MARKETING.contacts(results.audience),
          },
        ]),
  ];
}

const counting = (n: number, one: string, many: string) =>
  n === 0 ? [] : [kinCount(n, one, many)];

/** "1 client · 2 deals · 1 won": a campaign's results on their folded line, zeros left out. */
export function kinCampaignResultsSummary(
  results: KinCampaignResults,
  audience: string | null | undefined,
  deals: boolean,
): string {
  const parts = [
    ...counting(results.prospects, "prospect", "prospects"),
    ...counting(results.clients, "client", "clients"),
    ...(deals ? counting(results.open.count, "deal", "deals") : []),
    ...(deals ? counting(results.won.count, "won", "won") : []),
    ...(audience == null ? [] : counting(results.audience, "contact", "contacts")),
  ];
  return parts.length === 0 ? KIN_MARKETING.resultsNone : parts.join(" · ");
}

/** The contacts at the clients and prospects a Clients filter shows, as a list asks for them. */
export function kinContactListOfClients(
  query: Omit<KinPartiesInput, "cursor" | "limit">,
): KinContactListInput {
  const { orgId, ...parties } = query;
  return { orgId, parties };
}

export const kinContactListOfTag = (orgId: KinOrgId, tag: string): KinContactListInput => ({
  orgId,
  tag,
});

export interface KinContactListRowView {
  readonly key: string;
  readonly name: string;
  /** "Head of operations · Brightwater Clinics". */
  readonly line: string;
  /** "ingrid@brightwater.example · +47 900 00 000", or null for names only. */
  readonly reach: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly party: string;
}

export function kinContactListView(list: KinContactList): {
  readonly rows: ReadonlyArray<KinContactListRowView>;
  /** "212 contacts". */
  readonly count: string;
  readonly more: string | null;
  readonly note: string | null;
} {
  return {
    rows: list.contacts.map((one) => {
      const reach = [one.emails[0] ?? one.email, one.phones[0] ?? one.phone].filter(
        (part): part is NonNullable<typeof part> => part != null && part !== "",
      );
      return {
        key: one.key,
        name: one.name,
        line: [one.role, one.party.title].filter((part) => part != null && part !== "").join(" · "),
        reach: reach.length === 0 ? null : reach.join(" · "),
        tags: one.tags ?? [],
        party: one.party.key,
      };
    }),
    count: KIN_MARKETING.contacts(list.total),
    more:
      list.total > list.contacts.length
        ? KIN_MARKETING.listMore(list.contacts.length, list.total)
        : null,
    note: list.details ? null : KIN_MARKETING.namesOnly,
  };
}
