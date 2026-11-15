// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a dev command's output and the mail's time.
// Delivers mail to, or lists what was sent from, a dev server's fake mailbox (KIN_DEV_FAKE_MAIL).
//   node scripts/kin-fake-mail.ts <stateDir>/kin-fake-mail.json deliver --to hello@invented-co.example \
//     --from "Ravi Menon <ravi@lumen.example>" --subject "Launch date" --body "Can we move it?" [--thread ft3]
//   node scripts/kin-fake-mail.ts <stateDir>/kin-fake-mail.json sent
import * as NodeUtil from "node:util";

import { fileStore, makeFakeMail } from "../src/kin/connections/FakeMail.ts";

const [path, command, ...rest] = process.argv.slice(2);
if (path === undefined || (command !== "deliver" && command !== "sent")) {
  console.error(
    "Usage: kin-fake-mail.ts <mailbox.json> deliver --to --from --subject --body | sent",
  );
  process.exit(2);
}
const fake = makeFakeMail(fileStore(path));
if (command === "sent") {
  console.log(JSON.stringify(fake.sent(), null, 2));
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
    at: Date.now(),
    ...(values.thread === undefined ? {} : { threadId: values.thread }),
  });
  console.log(JSON.stringify({ threadId: message.threadId, messageId: message.messageId }));
}
