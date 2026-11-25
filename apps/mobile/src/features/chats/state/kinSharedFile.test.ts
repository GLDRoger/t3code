import { describe, expect, it } from "vite-plus/test";

import { kinSharedFileLanding } from "./kinSharedFile";

const inbox = "file:///private/var/mobile/Containers/Data/Application/A1/Documents/Inbox";

describe("kinSharedFileLanding", () => {
  it.each([
    [
      "a PDF opened from Files",
      { uri: `${inbox}/Tidewater%20invoice%20Nov.pdf` },
      { screen: "KinBillsAdd", name: "Tidewater invoice Nov.pdf", mimeType: "application/pdf" },
    ],
    [
      "a photo",
      { uri: `${inbox}/receipt.HEIC` },
      { screen: "KinBillsAdd", name: "receipt.HEIC", mimeType: "image/heic" },
    ],
    [
      "a CSV",
      { uri: `${inbox}/clients.csv` },
      { screen: "KinImport", name: "clients.csv", mimeType: "text/csv" },
    ],
    [
      "an XLSX",
      { uri: `${inbox}/crm-export.xlsx` },
      {
        screen: "KinImport",
        name: "crm-export.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
    [
      "an Android share naming its type and name",
      { uri: "content://media/external/file/42", name: "patients.csv", mimeType: "text/csv" },
      { screen: "KinImport", name: "patients.csv", mimeType: "text/csv" },
    ],
    [
      "a type Kin doesn't read, which Bills refuses as it would a picked one",
      { uri: `${inbox}/notes.docx` },
      { screen: "KinBillsAdd", name: "notes.docx", mimeType: "application/octet-stream" },
    ],
  ])("sends %s to its import screen", (_case, shared, landing) => {
    expect(kinSharedFileLanding(shared)).toEqual({
      screen: landing.screen,
      file: { uri: shared.uri, name: landing.name, mimeType: landing.mimeType },
    });
  });

  it("leaves links that aren't files to the app's own linking", () => {
    expect(kinSharedFileLanding({ uri: "t3code://kin/env/org/chats/c1" })).toBeNull();
    expect(kinSharedFileLanding({ uri: "https://app.t3.codes/threads/a/b" })).toBeNull();
  });
});
