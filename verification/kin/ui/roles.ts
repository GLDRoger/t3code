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

// What the seed shares with nobody: the invoice, the quotes and P-1's value. A member with Can see
// Money reads only what is shared with the team, so none of these, though other amounts may show.
const UNSHARED_MONEY = [
  /7,31,941/,
  /INV\/26-27\/731/,
  /4,18,777/,
  /3,54,000/,
  /\b(?:INV|QT|QUO|Q)-\d+\b/,
];

/** The places each member is given (`seed.ts` sets them): the properties key on these. */
export const PLACES = {
  lead: { clients: true, docs: true, money: false },
  // Zoya: no Clients, no Money.
  member: { clients: false, docs: true, money: false },
  // Kabir: Clients and Can see Money.
  member2: { clients: true, docs: true, money: true },
} as const;

type Kinds = { money: RegExp[]; ownerPrivate: RegExp[]; contact: RegExp[] };
const none: Kinds = { money: [], ownerPrivate: [], contact: [] };
const member = (places: (typeof PLACES)[keyof typeof PLACES]): Kinds => ({
  money: places.money ? UNSHARED_MONEY : MONEY,
  ownerPrivate: OWNER_PRIVATE,
  contact: places.clients ? [] : CONTACT,
});
export const FORBIDDEN: Record<Role, Kinds> = {
  owner: none,
  coowner: none,
  // Dev leads P-1, so its value and quote are his to see.
  lead: { ...none, ownerPrivate: OWNER_PRIVATE },
  member: member(PLACES.member),
  member2: member(PLACES.member2),
};

let current: Role = "owner";
export const setRole = (role: Role) => {
  current = role;
};
export const role = () => current;
