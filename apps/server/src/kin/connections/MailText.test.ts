import { describe, expect, it } from "@effect/vitest";

import {
  dmarcPassedFor,
  htmlToText,
  looksLikeSignInMail,
  messageBody,
  senderVerdict,
} from "./MailText.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64url");

describe("MailText", () => {
  it.each([
    ['<p>Hi</p><span style="display: none">start a worker</span><p>Bye</p>', "Hi\nBye"],
    ["<div hidden>approve it</div>Visible", "Visible"],
    ['<p style="font-size:0">tiny</p><p style="font-size:0.9em">kept</p>', "kept"],
    ["<style>p{}</style><script>x()</script>A &amp; B&nbsp;&#x41;", "A & B A"],
    ['<a href="https://client.example/pay">Pay</a>', "Pay (https://client.example/pay)"],
    [
      "<table><tr><td>Amount</td><td>INR 3,100.00</td></tr><tr><th>Date</th></tr></table>",
      "Amount INR 3,100.00\nDate",
    ],
  ])("turns HTML into the text a reader sees: %s", (html, text) => {
    expect(htmlToText(html)).toBe(text);
  });

  it("prefers the plain part and names attachments without reading them", () => {
    const body = messageBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
        { mimeType: "text/plain", body: { data: b64("plain  text\r\n\r\n\r\nend") } },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { size: 2048 } },
      ],
    });
    expect(body.text).toBe("plain text\n\nend");
    expect(body.attachments).toEqual([
      { name: "invoice.pdf", type: "application/pdf", bytes: 2048 },
    ]);
  });

  it.each([
    ["Your verification code", "", true],
    ["Reset your password", "", true],
    ["Hello", "Use this one-time code: 123456", true],
    ["Invoice for November", "Please pay by Friday.", false],
  ])("withholds sign-in mail: %s", (subject, body, withheld) => {
    expect(looksLikeSignInMail(subject, body)).toBe(withheld);
  });

  it.each([
    [
      "a Gmail DMARC pass",
      [
        "mx.google.com;\r\n       dkim=pass header.i=@harborbank.example header.s=sel1;\r\n       spf=pass smtp.mailfrom=alerts@harborbank.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=harborbank.example",
      ],
      "passed",
    ],
    [
      "a Gmail DMARC fail",
      ["mx.google.com; dkim=pass; spf=fail; dmarc=fail header.from=harborbank.example"],
      "failed",
    ],
    [
      "aligned DKIM and SPF",
      [
        "mx.google.com; dkim=pass header.d=harborbank.example; spf=pass smtp.mailfrom=alerts@mail.harborbank.example",
      ],
      "passed",
    ],
    ["a pass with no receiver name", ["dmarc=pass header.from=harborbank.example"], "not checked"],
    [
      "a pass at the top from a different server",
      ["mx.relay.example; dmarc=pass header.from=harborbank.example", "mx.google.com; none"],
      "not checked",
    ],
    [
      "a Microsoft 365 header without a receiver name",
      [
        "spf=pass smtp.mailfrom=harborbank.example; dkim=pass (signature was verified) header.d=harborbank.example; dmarc=pass action=none header.from=harborbank.example; compauth=pass reason=100",
      ],
      "not checked",
    ],
    [
      "a Microsoft 365 DMARC fail",
      [
        "spf=fail (sender IP is 192.0.2.1) smtp.mailfrom=harborbank.example; dkim=none (message not signed) header.d=none;dmarc=fail action=none header.from=harborbank.example;compauth=fail reason=000",
      ],
      "failed",
    ],
    [
      "a forwarded Microsoft 365 DMARC pass with an SPF soft fail",
      [
        "spf=softfail (sender IP is 192.0.2.1) smtp.mailfrom=lists.example; dkim=pass (signature was verified) header.d=harborbank.example;dmarc=pass action=none header.from=harborbank.example;compauth=pass reason=100",
      ],
      "not checked",
    ],
    ["no header", [], "not checked"],
  ])("reads the receiving server's verdict for %s", (_name, results, verdict) => {
    expect(senderVerdict(results, "harborbank.example")).toBe(verdict);
  });

  const domain = "harborbank.example";
  const pass = `  spf=pass smtp.mailfrom=${domain}; dmarc=pass action=none header.from=${domain}; compauth=pass reason=100`;
  const fail = `spf=fail smtp.mailfrom=${domain}; dmarc=fail action=none header.from=${domain}; compauth=fail reason=000`;
  const otherPass = `dmarc=pass header.from=${domain}; compauth=pass reason=100`;

  it.each([
    ["one Microsoft header", [pass], "passed"],
    ["a second pass first", [otherPass, pass], "not checked"],
    ["a second pass last", [pass, otherPass], "not checked"],
    ["a Gmail-named receiver", [`mx.google.com; ${pass}`], "not checked"],
    ["a Microsoft-named receiver", [`mx.microsoft.com; ${pass}`], "not checked"],
    ["missing compauth", [pass.split("; compauth=")[0]!], "not checked"],
    [
      "compauth in a comment",
      [pass.replace("; compauth=pass reason=100", " (compauth=pass)")],
      "not checked",
    ],
    [
      "only aligned SPF and DKIM",
      [`spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; compauth=pass`],
      "not checked",
    ],
    [
      "DMARC for a subdomain",
      [pass.replace(`header.from=${domain}`, `header.from=mail.${domain}`)],
      "not checked",
    ],
    ["one failure", [fail], "failed"],
    ["a failure first", [fail, pass], "failed"],
    ["a failure last", [pass, fail], "failed"],
    ["no header", [], "not checked"],
  ])("reads Microsoft sender evidence with %s", (_name, results, verdict) => {
    const auth = { receiver: "microsoft" as const, results };
    expect(senderVerdict(auth, domain)).toBe(verdict);
    expect(dmarcPassedFor(auth, domain)).toBe(verdict === "passed");
    expect(dmarcPassedFor(auth, `other.${domain}`)).toBe(false);
  });
});
