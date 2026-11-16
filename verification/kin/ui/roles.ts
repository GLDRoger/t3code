// What each seeded role must never see. Canaries come from seed.jsonl and seed.ts.
export type Role = "owner" | "coowner" | "lead" | "member" | "member2";

const MONEY = [
  /₹\s?\d/, // any rupee amount
  /\b(?:Rs\.?|INR)\s?\d/,
  /\b\d{1,2},\d{2},\d{3}\b/, // Indian grouping: 7,31,941
  /INV\/\d{2}-\d{2}\/\d+/, // invoice number
  /\b(?:INV|QT|QUO|Q)-\d+\b/, // invoice and quote keys
];
const OWNER_PRIVATE = [/CANARY-PRIVATE/];
const CONTACT = [/canary\.anita@/i, /98450\s?73194/];

type Kinds = { money: RegExp[]; ownerPrivate: RegExp[]; contact: RegExp[] };
const none: Kinds = { money: [], ownerPrivate: [], contact: [] };
export const FORBIDDEN: Record<Role, Kinds> = {
  owner: none,
  coowner: none,
  lead: { ...none, ownerPrivate: OWNER_PRIVATE },
  // Zoya has no Clients place; Kabir has it, so he may see the contact.
  member: { money: MONEY, ownerPrivate: OWNER_PRIVATE, contact: CONTACT },
  member2: { ...none, money: MONEY, ownerPrivate: OWNER_PRIVATE },
};

let current: Role = "owner";
export const setRole = (role: Role) => {
  current = role;
};
export const role = () => current;
