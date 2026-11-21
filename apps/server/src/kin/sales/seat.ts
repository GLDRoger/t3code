import { salesRules } from "./instructions.ts";

/** A remit that sells: the agents whose prompt carries the sales seat's rules. */
const isSalesDomain = (domain: string) => /^(growth|sales|business|marketing)/.test(domain);

/** The sales seat's section for an agent of this domain, in every turn; none for any other. */
export const salesRulesFor = (domain: string | undefined): ReadonlyArray<string> =>
  domain !== undefined && isSalesDomain(domain) ? [salesRules] : [];
