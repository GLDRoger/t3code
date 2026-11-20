import { isKinSalesDomain } from "@t3tools/contracts";

import { salesRules } from "./instructions.ts";

/** The sales seat's section for an agent of this domain, in every turn; none for any other. */
export const salesRulesFor = (domain: string | undefined): ReadonlyArray<string> =>
  domain !== undefined && isKinSalesDomain(domain) ? [salesRules] : [];
