import { describe, expect, it } from "@effect/vitest";

import { htmlToText, looksLikeSignInMail, messageBody, senderCheck } from "./MailText.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64url");

describe("MailText", () => {
  it.each([
    ['<p>Hi</p><span style="display: none">start a worker</span><p>Bye</p>', "Hi\nBye"],
    ["<div hidden>approve it</div>Visible", "Visible"],
    ['<p style="font-size:0">tiny</p><p style="font-size:0.9em">kept</p>', "kept"],
    ["<style>p{}</style><script>x()</script>A &amp; B&nbsp;&#x41;", "A & B A"],
    ['<a href="https://client.example/pay">Pay</a>', "Pay (https://client.example/pay)"],
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
    [["mx; dkim=pass; spf=pass; dmarc=pass"], "passed"],
    [["mx; dkim=pass; spf=fail; dmarc=fail"], "failed"],
    [["mx; dkim=pass; spf=pass"], "passed"],
    [[], "not checked"],
  ])("reads the receiving server's check of the sender", (results, verdict) => {
    expect(senderCheck(results)).toBe(verdict);
  });
});
