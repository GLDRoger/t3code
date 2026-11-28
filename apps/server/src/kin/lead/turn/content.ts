import {
  type ChatAttachment,
  type ChatImageAttachment,
  isProviderSendTurnSupportedImageMimeType,
  type KinEvent,
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
import { billPhotoForModel } from "../../work/billPhotoForModel.ts";
import { readPdfPages } from "../../work/statements/statementFiles.ts";
import { PDF_PAGE_IMAGES, type PageBudget, renderPdfPages } from "./pdfPageImages.ts";

/** About 50k tokens across a turn's documents: a long contract, not a book. */
export const TURN_TEXT_CHARS = 200_000;
// A file's own "[Text of" or "[End of", anywhere in it, as "(…)": only Kin's lines open or close its text.
const FRAME_MARKER =
  /[[\uff3b]([\t \p{Zs}\p{Cf}]*(?:text|end)[\t \p{Zs}\p{Cf}]+of\b[^\]\uff3d\n\r\u0085\u2028\u2029]*)[\]\uff3d]?/giu;

/**
 * A turn's own files, newest kept: past 20 images a request's images shrink on Claude, and its
 * adapter carries 28 MB of base64, which 20 MB of images (PDF pages counted after them) fits.
 */
const TURN_FILES = { count: 20, imageBytes: PDF_PAGE_IMAGES.bytesPerTurn };

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

type TurnContentInput = {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** The turn offers `bills_add`, so the files left out are named to it. */
  readonly offersBillsAdd?: boolean;
  /** The isolated bills.read lane keeps its separately prepared photos. */
  readonly billPhotos?: boolean | "legacy";
};

/** A bills turn queued before its photos were prepared up front still prepares them itself. */
export const billPhotoMode = (events: ReadonlyArray<KinEvent>) => {
  if (!events.every((event) => event._tag === "bills.read")) return false;
  return events.every((event) => event.photosPrepared === true) ? true : "legacy";
};

/**
 * What every provider gets in place of a file: text the model reads and pictures it sees. No Kin
 * turn depends on a provider's own document support, so every model reads the same thing.
 */
export class KinTurnContent extends Context.Service<
  KinTurnContent,
  {
    readonly prepare: (input: TurnContentInput) => Effect.Effect<{
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

      // Shares the prepare span with document extraction.
      const prepareFiles = Effect.fnUntraced(
        function* (
          input: TurnContentInput,
          kept: ReadonlyArray<{ file: ChatAttachment; unavailable: boolean }>,
          own: ReadonlyArray<ChatAttachment>,
          left: number,
        ) {
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
            const shown = body.replace(FRAME_MARKER, "($1)");
            const cut = shown.length > chars;
            const kept = shown.slice(0, chars);
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
          for (const { file: attachment, unavailable } of kept) {
            if (!unavailable && shownAsPicture(attachment)) continue;
            const file = resolveAttachmentPath({ attachmentsDir, attachment });
            const named = `[Attached ${attachment.type} "${attachment.name}"`;
            if (unavailable || file === null || !(yield* fs.exists(file))) {
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
        (effect, input, kept, own) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin couldn't prepare a turn's attachments", { cause }).pipe(
                Effect.as({
                  text: input.text,
                  attachments: input.billPhotos ? kept.map(({ file }) => file) : own,
                }),
              ),
            ),
          ),
      );
      const prepare = Effect.fn("KinTurnContent.prepare")(function* (input: TurnContentInput) {
        if (input.attachments.length === 0) return { text: input.text, attachments: [] };
        let files = input.attachments;
        if (input.billPhotos) {
          const attachments = yield* Effect.forEach(files, (file) =>
            shownAsPicture(file) && !isPdf(file)
              ? billPhotoForModel(attachmentsDir, file, {
                  cachedOnly: input.billPhotos !== "legacy",
                }).pipe(Effect.provideService(FileSystem.FileSystem, fs))
              : Effect.succeed(file),
          );
          // Skipping just one image would point the prompt's B-numbers at the wrong photos.
          if (!attachments.every((file) => file !== undefined)) {
            yield* Effect.logWarning(
              "Kin couldn't prepare a bill photo; leaving the turn without attachments",
            );
            return { text: input.text, attachments: [] };
          }
          files = attachments;
        }

        const kept: Array<{ file: ChatAttachment; unavailable: boolean }> = [];
        const copies: Array<string> = [];
        let bytes = 0;
        for (const source of files.toReversed()) {
          if (kept.length === TURN_FILES.count) break;
          const file =
            !input.billPhotos && shownAsPicture(source)
              ? yield* billPhotoForModel(attachmentsDir, source, { kind: "chat" }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                )
              : source;
          const image =
            file !== undefined &&
            (input.billPhotos
              ? file.type === "image" || isProviderSendTurnSupportedImageMimeType(file.mimeType)
              : shownAsPicture(file));
          if (image && bytes + file.sizeBytes > TURN_FILES.imageBytes) break;
          if (image) bytes += file.sizeBytes;
          kept.push({ file: file ?? source, unavailable: file === undefined });
          // The copy's path is all a provider names; tools take the original's id and bytes.
          if (file !== undefined && file.id !== source.id)
            copies.push(
              `[The attached image "${source.name}" is a copy of file ${source.id}, whose original is saved at: ${resolveAttachmentPath({ attachmentsDir, attachment: source })}]`,
            );
        }
        kept.reverse();
        const own = kept.flatMap(({ file, unavailable }) =>
          !unavailable && shownAsPicture(file) ? [file] : [],
        );
        const text = [input.text, ...copies.reverse()].join("\n\n");
        return yield* prepareFiles({ ...input, text }, kept, own, files.length - kept.length);
      });
      return KinTurnContent.of({ prepare });
    }),
  );
}
