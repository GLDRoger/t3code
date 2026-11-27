import { getDomain } from "tldts";

const names = new Intl.ListFormat("en", { type: "conjunction" });
export const accountList = (accounts: ReadonlyArray<string>) =>
  `account${accounts.length === 1 ? "" : "s"} ending ${names.format(accounts)}`;

export const bankSenderCopy = (input: {
  readonly address: string;
  readonly bankName: string;
  readonly source: "company_details" | "statement";
  readonly company: string;
  readonly mailboxes: ReadonlyArray<string>;
  readonly since: string;
  readonly count: number;
  readonly accounts: ReadonlyArray<string>;
  readonly knownAccounts: boolean;
  readonly shownUnknown: ReadonlyArray<string>;
  readonly sibling?: string | undefined;
}) => {
  const { address, bankName, count, accounts, shownUnknown } = input;
  const one = count === 1;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  // A bank's name can sit in a sub-domain of anyone's domain; say whose it is.
  const owner = getDomain(domain, { allowPrivateDomains: true });
  const owns =
    owner === null || owner === domain ? "" : ` That name belongs to whoever owns ${owner}.`;
  const mails = `${count} mail${one ? "" : "s"}`;
  const mentioned = [...accounts, ...shownUnknown];
  const article = input.knownAccounts ? "the " : mentioned.length === 1 ? "an " : "";
  const about = input.knownAccounts
    ? `the ${accountList(accounts)}`
    : accounts.length === 1
      ? "that account"
      : "those accounts";
  const source =
    input.source === "statement" ? "on your confirmed statement" : "in Company details";
  const alternative =
    input.sibling === undefined
      ? ""
      : ` Kin already counts ${bankName}'s alerts from ${input.sibling}. This is a different address.`;
  const excluded =
    shownUnknown.length === 0
      ? ""
      : ` Kin won't count alerts about accounts ending ${names.format(shownUnknown)} unless you add ${shownUnknown.length === 1 ? "that account" : "those accounts"} in Settings.`;
  return {
    ask: `Count alerts from ${address} as ${bankName}'s?`,
    noticed: `Kin has had ${mails} from ${address} in the ${input.company} mailbox${input.mailboxes.length === 1 ? "" : "es"} ${names.format(input.mailboxes)} since ${input.since}. The mail server that received ${one ? "it confirmed it was" : "them confirmed they were"} sent by ${domain}.${owns} Kin noticed this address because it matches ${bankName}, the bank ${source}, and the ${one ? "mail mentions" : "mails mention"} ${article}${accountList(mentioned)}.${alternative}`,
    gives: `If you say yes, each alert from this address about ${about} becomes a Bank transaction, marked Unexplained, and the ${mails} already here ${one ? "is" : "are"} added. Nothing is marked paid without you.${excluded}\n\nSay yes only if you know ${bankName} sends alerts from exactly this address. Anyone can set up an address that looks like a bank's.`,
  };
};
