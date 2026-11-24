import {
  type ChatAttachment,
  type ChatImageAttachment,
  isProviderSendTurnSupportedImageMimeType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  createDeterministicAttachmentId,
  KIN_ATTACHMENT_ID_PREFIX,
  resolveAttachmentPath,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import { readPdfPages } from "../../work/statements/statementFiles.ts";
import { PDF_PAGE_IMAGES, type PageBudget, renderPdfPages } from "./pdfPageImages.ts";

/** About 50k tokens across a turn's documents: a long contract, not a book. */
export const TURN_TEXT_CHARS = 200_000;

/**
 * A turn's own files, newest kept: past 20 images a request's images shrink on Claude, and its
 * adapter carries 28 MB of base64, which 20 MB of images (PDF pages counted after them) fits.
 */
const TURN_FILES = { count: 20, imageBytes: PDF_PAGE_IMAGES.bytesPerTurn };

/** The files of `files` a turn takes, newest kept, in the order they were sent; and how many not. */
const turnFiles = <A extends Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes">>(
  files: ReadonlyArray<A>,
) => {
  const newest: Array<A> = [];
  let bytes = 0;
  for (const file of files.toReversed()) {
    const image = file.type === "image" || isProviderSendTurnSupportedImageMimeType(file.mimeType);
    if (newest.length + 1 > TURN_FILES.count) break;
    if (image && bytes + file.sizeBytes > TURN_FILES.imageBytes) break;
    if (image) bytes += file.sizeBytes;
    newest.push(file);
  }
  return { kept: newest.toReversed(), left: files.length - newest.length };
};

/** Whether a turn shows `file` to the model as a picture; any other file goes as text or a path. */
export const shownAsPicture = (file: Pick<ChatAttachment, "type" | "mimeType">) =>
  file.type === "image" && isProviderSendTurnSupportedImageMimeType(file.mimeType);

const KIN_FILES = KIN_ATTACHMENT_ID_PREFIX.slice(0, -1);
const PAGE_IMAGE_VERSION = 1;

/** Where page `page` of a stored PDF is kept as a JPEG: drawn once, reused by a retry or steer. */
export const pageImageId = (pdfId: string, page: number) => {
  const id = createDeterministicAttachmentId(
    KIN_FILES,
    `${pdfId}#page-${page}#v${PAGE_IMAGE_VERSION}`,
  );
  return id === null ? null : `${id}-jpg`;
};

const extensionOf = (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "";
const mimeOf = (attachment: ChatAttachment) =>
  attachment.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
const isPdf = (attachment: ChatAttachment) =>
  mimeOf(attachment) === "application/pdf" || extensionOf(attachment.name) === "pdf";
const PLAIN_TEXT = new Set(["csv", "tsv", "txt", "md", "json", "log"]);
const isPlainText = (attachment: ChatAttachment) =>
  mimeOf(attachment).startsWith("text/") || PLAIN_TEXT.has(extensionOf(attachment.name));
const isAudio = (attachment: ChatAttachment) => mimeOf(attachment).startsWith("audio/");

type PdfRead = Awaited<ReturnType<typeof readPdfPages>>;

const pagesNamed = (name: string, shown: number, total: number) =>
  shown === 1
    ? `[Page 1 of "${name}" is attached as an image, "${pageName(name, 1, total)}".]`
    : `[Pages 1 to ${shown} of "${name}" are attached as images, "${pageName(name, 1, total)}" onward.]`;
const pageName = (name: string, page: number, total: number) =>
  `${name.slice(0, 200)}, page ${page} of ${total}.jpg`;

/**
 * What every provider gets in place of a file: text the model reads and pictures it sees. No Kin
 * turn depends on a provider's own document support, so every model reads the same thing.
 */
export class KinTurnContent extends Context.Service<
  KinTurnContent,
  {
    readonly prepare: (input: {
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      /** The turn offers `bills_add`, so the files left out are named to it. */
      readonly offersBillsAdd?: boolean;
    }) => Effect.Effect<{
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    }>;
  }
>()("t3/kin/lead/turn/content/KinTurnContent") {
  static readonly layer = Layer.effect(
    KinTurnContent,
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const documents = yield* DocumentText.DocumentText;

      const keepPage = Effect.fn("KinTurnContent.keepPage")(function* (
        pdf: ChatAttachment,
        page: number,
        total: number,
        jpeg: Uint8Array,
      ) {
        const id = pageImageId(pdf.id, page);
        if (id === null) return undefined;
        const image: ChatImageAttachment = {
          type: "image",
          id,
          name: pageName(pdf.name, page, total),
          mimeType: "image/jpeg",
          sizeBytes: jpeg.byteLength,
        };
        const file = resolveAttachmentPath({ attachmentsDir, attachment: image });
        if (file === null) return undefined;
        if (!(yield* fs.exists(file))) {
          yield* fs.writeFile(`${file}.part`, jpeg);
          yield* fs.rename(`${file}.part`, file);
        }
        return image;
      });

      const prepare = Effect.fn("KinTurnContent.prepare")(
        function* (input: {
          readonly text: string;
          readonly attachments: ReadonlyArray<ChatAttachment>;
          readonly offersBillsAdd?: boolean;
        }) {
          if (input.attachments.length === 0)
            return { text: input.text, attachments: input.attachments };
          const { kept, left } = turnFiles(input.attachments);
          const own = kept.filter(shownAsPicture);
          // Claude's adapter carries 28 MB of base64 a request: the turn's own pictures come first.
          const budget: PageBudget = {
            pages: PDF_PAGE_IMAGES.pagesPerTurn,
            bytes: Math.max(
              0,
              PDF_PAGE_IMAGES.bytesPerTurn -
                own.reduce((total, attachment) => total + attachment.sizeBytes, 0),
            ),
          };
          let chars = TURN_TEXT_CHARS;
          const quoted = (name: string, body: string, heading: string) => {
            const cut = body.length > chars;
            const kept = body.slice(0, chars);
            chars -= kept.length;
            return `[${heading}${cut ? `, cut at ${kept.length} characters` : ""}]\n${kept}\n[End of "${name}"]`;
          };
          const lines: Array<string> =
            left === 0
              ? []
              : [
                  `[${left} of the attached files ${left === 1 ? "isn't" : "aren't"} shown: too many for one turn.${input.offersBillsAdd === true ? " bills_add reads bills and receipts among them in the background." : ""}]`,
                ];
          const pages: Array<ChatAttachment> = [];
          for (const attachment of kept) {
            if (shownAsPicture(attachment)) continue;
            const file = resolveAttachmentPath({ attachmentsDir, attachment });
            const named = `[Attached ${attachment.type} "${attachment.name}"`;
            if (file === null || !(yield* fs.exists(file))) {
              lines.push(`${named} is unavailable.]`);
              continue;
            }
            lines.push(`${named} is saved at: ${file}]`);
            if (isPdf(attachment)) {
              const bytes = yield* fs.readFile(file);
              const read: PdfRead = yield* Effect.promise(() =>
                readPdfPages(bytes).catch(() => ({
                  _tag: "unreadable" as const,
                  reason: "it couldn't be opened.",
                })),
              );
              const drawn = yield* Effect.promise(() =>
                renderPdfPages(bytes, budget).catch(() => undefined),
              );
              const total = drawn?.pageCount ?? 0;
              const kept = yield* Effect.forEach(drawn?.images ?? [], (jpeg, index) =>
                keepPage(attachment, index + 1, total, jpeg).pipe(
                  Effect.orElseSucceed(() => undefined),
                ),
              );
              const shown = kept.findIndex((image) => image === undefined);
              const images = (shown === -1 ? kept : kept.slice(0, shown)).filter(
                (image) => image !== undefined,
              );
              pages.push(...images);
              const hasText = !("_tag" in read);
              if (hasText)
                lines.push(
                  quoted(
                    attachment.name,
                    read.map((page, index) => `--- Page ${index + 1} ---\n${page}`).join("\n"),
                    `Text of "${attachment.name}", ${read.length} pages`,
                  ),
                );
              else if (read._tag === "scanned" && images.length > 0)
                lines.push(
                  `[The PDF "${attachment.name}" has no text layer: read it from its pages.]`,
                );
              else
                lines.push(
                  `[Kin couldn't read the PDF "${attachment.name}": ${
                    read._tag === "scanned"
                      ? "it is scanned pages with no text layer, and they couldn't be drawn here. Ask for photos of the pages."
                      : read._tag === "unreadable"
                        ? read.reason
                        : "it is password-protected."
                  }]`,
                );
              if (images.length > 0) lines.push(pagesNamed(attachment.name, images.length, total));
              if (drawn !== undefined && images.length < total)
                lines.push(
                  `[${images.length + 1 === total ? `Page ${total}` : `Pages ${images.length + 1} to ${total}`} of "${attachment.name}" were left out as images${hasText ? " (their text is above)" : ""}. To see them, ask for those pages as their own file.]`,
                );
              continue;
            }
            if (isAudio(attachment)) {
              lines.push(`[There is no transcript of "${attachment.name}": you can't hear it.]`);
              continue;
            }
            // T3's own extraction, the text the owner's chat could already open, now in every chat.
            const extracted = isPlainText(attachment) ? file : yield* documents.ensure(file);
            const text =
              extracted === undefined
                ? undefined
                : yield* fs.readFileString(extracted).pipe(Effect.orElseSucceed(() => undefined));
            if (text !== undefined && text.trim() !== "")
              lines.push(quoted(attachment.name, text, `Text of "${attachment.name}"`));
          }
          return {
            text: [input.text, ...lines].join("\n\n"),
            attachments: [...own, ...pages],
          };
        },
        // A file Kin can't prepare leaves the turn its text and the files that fit, never stops it.
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin couldn't prepare a turn's attachments", { cause }).pipe(
                Effect.as({ text: input.text, attachments: turnFiles(input.attachments).kept }),
              ),
            ),
          ),
      );
      return KinTurnContent.of({ prepare });
    }),
  );
}
