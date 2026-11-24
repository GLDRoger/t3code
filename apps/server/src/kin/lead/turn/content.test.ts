import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as KinAttachmentStore from "../../chat/KinAttachmentStore.ts";
import { pdf } from "../../work/statements/statementPdf.testkit.ts";
import { KinTurnContent, pageImageId, TURN_TEXT_CHARS } from "./content.ts";
import { PDF_PAGE_IMAGES } from "./pdfPageImages.ts";

const file = (id: string, name: string, mimeType: string, sizeBytes = 1): ChatAttachment => ({
  type: "file",
  id,
  name,
  mimeType,
  sizeBytes,
});
const scanned = () =>
  pdf([[]], undefined, {
    dict: "",
    data: new TextEncoder().encode("0 0 1 rg 0 0 638 842 re f"),
  });

/** Lays the files out as Kin stores them; T3's extraction is a sidecar beside its file. */
const stored = (files: ReadonlyArray<readonly [ChatAttachment, Uint8Array | string]>) =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    for (const [attachment, bytes] of files) {
      const path = resolveAttachmentPath({ attachmentsDir, attachment })!;
      yield* typeof bytes === "string"
        ? fs.writeFileString(path, bytes)
        : fs.writeFile(path, bytes);
    }
    return attachmentsDir;
  });

const documents = Layer.succeed(
  DocumentText.DocumentText,
  DocumentText.DocumentText.of({
    ensure: (path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return (yield* fs.exists(`${path}.txt`)) ? `${path}.txt` : undefined;
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
  }),
);
const layer = (prefix: string) =>
  Layer.mergeAll(KinTurnContent.layer, KinAttachmentStore.layer).pipe(
    Layer.provideMerge(documents),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const blueAtCentre = (jpeg: Uint8Array) =>
  Effect.gen(function* () {
    const { loadImage, createCanvas } = yield* Effect.promise(() => import("@napi-rs/canvas"));
    const image = yield* Effect.promise(() => loadImage(Buffer.from(jpeg)));
    const sheet = createCanvas(image.width, image.height);
    const context = sheet.getContext("2d");
    context.drawImage(image, 0, 0);
    const [red, green, blue] = context.getImageData(image.width / 2, image.height / 2, 1, 1).data;
    return {
      blue: red! < 40 && green! < 40 && blue! > 200,
      longEdge: Math.max(image.width, image.height),
    };
  });

it.effect(
  "every attachment reaches the provider as text and pictures: a picture stays one, one no provider reads is named, a text PDF is its text and its pages, a scanned one its pages, a compressed one too, and a spreadsheet its extracted text",
  () =>
    Effect.gen(function* () {
      const photo: ChatAttachment = {
        type: "image",
        id: "kin-chat-photo",
        name: "chart.png",
        mimeType: "image/png",
        sizeBytes: 8,
      };
      // Claude's adapter fails a whole turn on an image type it can't read.
      const heic: ChatAttachment = {
        ...photo,
        id: "kin-chat-heic",
        name: "Shelf.heic",
        mimeType: "image/heic",
      };
      const contract = file("kin-chat-contract-pdf", "Contract.pdf", "application/pdf");
      const lease = file("kin-chat-lease-pdf", "Lease.pdf", "application/pdf");
      const compressed = file("kin-chat-pantry-pdf", "Pantry.pdf", "application/pdf");
      const sheet = file(
        "kin-chat-sheet-xlsx",
        "Orders.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      const memo = file("kin-chat-memo-m4a", "Memo.m4a", "audio/mp4");
      const fs = yield* FileSystem.FileSystem;
      const objectStreams = yield* fs.readFile(
        NodeURL.fileURLToPath(new URL("./fixtures/object-streams.pdf", import.meta.url)),
      );
      const dir = yield* stored([
        [photo, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
        [heic, "heic bytes"],
        [contract, pdf([[[{ x: 72, text: "Retainer: 40 hours a month" }]]])],
        [lease, scanned()],
        [compressed, objectStreams],
        [sheet, "zip bytes"],
        [memo, "audio bytes"],
      ]);
      yield* fs.writeFileString(`${dir}/kin-chat-sheet-xlsx.xlsx.txt`, "Week 1: 120 orders");
      const content = yield* KinTurnContent;
      const { text, attachments } = yield* content.prepare({
        text: "Read these",
        attachments: [photo, heic, contract, lease, compressed, sheet, memo],
      });
      // Only pictures go to the provider: the photo, then each PDF's pages, in order.
      assert.deepStrictEqual(
        attachments.map(({ type, name }) => `${type}:${name}`),
        [
          "image:chart.png",
          "image:Contract.pdf, page 1 of 1.jpg",
          "image:Lease.pdf, page 1 of 1.jpg",
          "image:Pantry.pdf, page 1 of 1.jpg",
        ],
      );
      assert.strictEqual(attachments[1]?.id, pageImageId(contract.id, 1));
      assert.match(
        text,
        /^Read these\n\n\[Attached image "Shelf\.heic" is saved at: [^\n]+\]\n\n\[Attached file "Contract\.pdf" is saved at: /,
      );
      assert.include(text, '[Text of "Contract.pdf", 1 pages]\n--- Page 1 ---\n');
      assert.include(text, "Retainer: 40 hours a month");
      assert.include(text, '[The PDF "Lease.pdf" has no text layer: read it from its pages.]');
      assert.include(
        text,
        '[Page 1 of "Lease.pdf" is attached as an image, "Lease.pdf, page 1 of 1.jpg".]',
      );
      assert.include(text, "Pantry lease: notice period 45 days");
      assert.include(text, "Late delivery credit: 7% of the invoice");
      assert.include(text, '[Text of "Orders.xlsx"]\nWeek 1: 120 orders\n[End of "Orders.xlsx"]');
      assert.include(text, '[There is no transcript of "Memo.m4a": you can\'t hear it.]');
      const page = yield* fs.readFile(
        resolveAttachmentPath({ attachmentsDir: dir, attachment: attachments[2]! })!,
      );
      // The scanned page is drawn as it is (blue), not as an empty or black frame.
      assert.deepStrictEqual(yield* blueAtCentre(page), { blue: true, longEdge: 1568 });
      // Asked again, the same pages are the same files.
      const again = yield* content.prepare({ text: "Again", attachments: [lease] });
      assert.deepStrictEqual(again.attachments, [attachments[2]!]);
    }).pipe(Effect.provide(layer("kin-turn-content-"))),
);

it.effect(
  "a turn's PDFs past its page images say which pages were left out, and its documents share one text budget",
  () =>
    Effect.gen(function* () {
      const count = PDF_PAGE_IMAGES.pagesPerTurn + 2;
      const shelves = file("kin-chat-shelves-pdf", "Shelves.pdf", "application/pdf");
      const notes = file("kin-chat-notes-txt", "Notes.txt", "text/plain");
      yield* stored([
        [
          shelves,
          pdf(
            Array.from({ length: count }, (_, index) => [[{ x: 72, text: `Shelf ${index + 1}` }]]),
          ),
        ],
        [notes, "n".repeat(TURN_TEXT_CHARS)],
      ]);
      const { text, attachments } = yield* (yield* KinTurnContent).prepare({
        text: "Count these",
        attachments: [shelves, notes],
      });
      assert.lengthOf(attachments, PDF_PAGE_IMAGES.pagesPerTurn);
      assert.include(
        text,
        `[Pages ${PDF_PAGE_IMAGES.pagesPerTurn + 1} to ${count} of "Shelves.pdf" were left out as images (their text is above). To see them, ask for those pages as their own file.]`,
      );
      // The PDF's text came first, so the notes get what is left of the budget.
      const cut = Number(/\[Text of "Notes\.txt", cut at (\d+) characters\]/.exec(text)?.[1]);
      assert.isAbove(cut, 0);
      assert.isBelow(cut, TURN_TEXT_CHARS);
    }).pipe(Effect.provide(layer("kin-turn-content-cut-"))),
);

it.effect(
  "a turn takes its newest 20 files and 20 MB of images, and says how many it left out",
  () =>
    Effect.gen(function* () {
      const photo = (n: number, sizeBytes = 8): ChatAttachment => ({
        type: "image",
        id: `kin-chat-photo-${n}`,
        name: `IMG_${n}.png`,
        mimeType: "image/png",
        sizeBytes,
      });
      const content = yield* KinTurnContent;
      const many = yield* content.prepare({
        text: "These are this month's bills",
        attachments: Array.from({ length: 22 }, (_, index) => photo(index)),
      });
      assert.deepStrictEqual(
        many.attachments.map((file) => file.name),
        Array.from({ length: 20 }, (_, index) => `IMG_${index + 2}.png`),
      );
      assert.strictEqual(
        many.text,
        "These are this month's bills\n\n[2 of the attached files aren't shown: too many for one turn. bills_add reads bills and receipts among them in the background.]",
      );
      const large = yield* content.prepare({
        text: "Big ones",
        attachments: [1, 2, 3].map((n) => photo(n, 8 * 1024 * 1024)),
      });
      assert.deepStrictEqual(
        large.attachments.map((file) => file.name),
        ["IMG_2.png", "IMG_3.png"],
      );
      assert.include(large.text, "[1 of the attached files isn't shown:");
      // Files that fit are the turn's own, with nothing said.
      const few = yield* content.prepare({ text: "Two", attachments: [photo(1), photo(2)] });
      assert.deepStrictEqual(few, { text: "Two", attachments: [photo(1), photo(2)] });
    }).pipe(Effect.provide(layer("kin-turn-content-budget-"))),
);

it.effect("a stored PDF that Kin deletes takes the page images a turn drew of it along", () =>
  Effect.gen(function* () {
    const lease = file(
      "kin-chat-0b1e1c2a-1111-4222-8333-444455556666-pdf",
      "Lease.pdf",
      "application/pdf",
    );
    const dir = yield* stored([[lease, scanned()]]);
    const { attachments } = yield* (yield* KinTurnContent).prepare({
      text: "Read it",
      attachments: [lease],
    });
    const fs = yield* FileSystem.FileSystem;
    const page = resolveAttachmentPath({ attachmentsDir: dir, attachment: attachments[0]! })!;
    assert.isTrue(yield* fs.exists(page));
    yield* (yield* KinAttachmentStore.KinAttachmentStore).remove([lease.id]);
    assert.isFalse(yield* fs.exists(page));
    assert.isFalse(
      yield* fs.exists(resolveAttachmentPath({ attachmentsDir: dir, attachment: lease })!),
    );
  }).pipe(Effect.provide(layer("kin-turn-content-remove-"))),
);
