// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a dev command's output and the mail's time.
// Delivers mail to, or lists what was sent from, a dev server's fake mailbox (KIN_DEV_FAKE_MAIL).
//   node scripts/kin-fake-mail.ts <stateDir>/kin-fake-mail.json deliver --to hello@invented-co.example \
//     --from "Ravi Menon <ravi@lumen.example>" --subject "Launch date" --body "Can we move it?" [--thread ft3]
//   node scripts/kin-fake-mail.ts <stateDir>/kin-fake-mail.json sent
//   node scripts/kin-fake-mail.ts <stateDir>/kin-fake-mail.json expire hello@invented-co.example [--back]
//   node scripts/kin-fake-mail.ts <stateDir>/kin-fake-mail.json approve <authorizationUrl> hello@invented-co.example
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { fileStore, makeFakeMail } from "../src/kin/connections/FakeMail.ts";

const [path, command, ...rest] = process.argv.slice(2);
if (
  path === undefined ||
  (command !== "deliver" && command !== "sent" && command !== "expire" && command !== "approve")
) {
  console.error(
    "Usage: kin-fake-mail.ts <mailbox.json> deliver --to --from --subject --body | sent | expire <address> [--back] | approve <authorizationUrl> <address>",
  );
  process.exit(2);
}
const fake = makeFakeMail(fileStore(path));
/** A dev server's moved clock (`DevClock.ts`, beside the mailbox): mail arrives at Kin's now. */
const kinNow = () => {
  try {
    const file = NodePath.join(NodePath.dirname(path), "kin-dev-clock.json");
    const { offsetMs } = JSON.parse(NodeFS.readFileSync(file, "utf8")) as { offsetMs?: unknown };
    return Date.now() + (typeof offsetMs === "number" && Number.isFinite(offsetMs) ? offsetMs : 0);
  } catch {
    return Date.now();
  }
};
if (command === "sent") {
  console.log(JSON.stringify(fake.sent(), null, 2));
} else if (command === "expire") {
  // The account's sign-in stops working, as a revoked grant does; --back restores it.
  const address = rest.find((arg) => !arg.startsWith("--"));
  if (address === undefined) {
    console.error("expire needs the account's address.");
    process.exit(2);
  }
  const back = rest.includes("--back");
  fake.setExpired(address, !back);
  console.log(`${address}: sign-in ${back ? "works again" : "expired"}`);
} else if (command === "approve") {
  // The owner signs in again at the "vendor": a working grant, and the page Kin's sign-in returns to.
  const [authorizationUrl, address] = rest;
  if (
    authorizationUrl === undefined ||
    address === undefined ||
    !fake.load().accounts.some((one) => one.address.toLowerCase() === address.toLowerCase())
  ) {
    console.error("approve needs a sign-in page and one of the fake mailbox's addresses.");
    process.exit(2);
  }
  fake.setExpired(address, false);
  console.log(fake.approve(authorizationUrl, address));
} else {
  const { values } = NodeUtil.parseArgs({
    args: rest,
    options: {
      to: { type: "string" },
      from: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      thread: { type: "string" },
    },
  });
  if (!values.to || !values.from || !values.subject || !values.body) {
    console.error("deliver needs --to, --from, --subject and --body.");
    process.exit(2);
  }
  const message = fake.deliver({
    to: values.to,
    from: values.from,
    subject: values.subject,
    body: values.body,
    at: kinNow(),
    ...(values.thread === undefined ? {} : { threadId: values.thread }),
  });
  console.log(JSON.stringify({ threadId: message.threadId, messageId: message.messageId }));
}
