// @effect-diagnostics nodeBuiltinImport:off -- pdf.js loads its fonts and decoders from files beside its package.
// oxlint-disable-next-line typescript/triple-slash-reference -- pdf.js ships no types for its worker module.
/// <reference path="../work/statements/pdfjsWorker.d.ts" />
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { inflatedTooFar } from "../work/statements/statementFiles.ts";

/**
 * What a Codex turn takes of its PDFs as page images. Claude reads up to 100 pages a session as
 * document blocks (`ClaudeAdapterV2`); a page is ~2k tokens to gpt-6.1, whose window is 500k.
 */
export const PDF_PAGE_IMAGES = {
  /** Across all of a turn's PDFs, first attached first. */
  pagesPerTurn: 50,
  /** Claude's vision downsizes past this long edge: ~140 dpi on a letter page. */
  longEdge: 1568,
  jpegQuality: 80,
  /** Encoded bytes across a turn's page images. */
  bytesPerTurn: 20 * 1024 * 1024,
  /** One decoded picture inside a page; a 600 dpi A4 scan is ~35M. */
  imagePixels: 40_000_000,
};

export type PageBudget = { pages: number; bytes: number };
export type RenderedPages = {
  readonly pageCount: number;
  /** The first pages as base64 JPEGs, as many as the budget held. */
  readonly images: ReadonlyArray<string>;
};

/** pdf.js's own font and decoder files; without them a PDF with unembedded fonts draws no text. */
const assetUrls = () => {
  try {
    const root = NodePath.dirname(
      NodeModule.createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
    );
    return {
      standardFontDataUrl: `${root}/standard_fonts/`,
      cMapUrl: `${root}/cmaps/`,
      wasmUrl: `${root}/wasm/`,
    };
  } catch {
    return {};
  }
};

/**
 * A PDF's first pages as JPEGs, within `budget`, which it spends. Undefined when the PDF can't be
 * drawn here (damaged, password-protected, too large, or no canvas for this platform): the turn
 * keeps its text layer.
 */
export const renderPdfPages = async (
  bytes: Uint8Array,
  budget: PageBudget,
): Promise<RenderedPages | undefined> => {
  if (inflatedTooFar(bytes) !== undefined) return undefined;
  const canvas = await import("@napi-rs/canvas").catch(() => undefined);
  if (canvas === undefined) return undefined;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js runs its worker in this thread, from this global; bundled, its own path to it is gone.
  Reflect.set(globalThis, "pdfjsWorker", await import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  const task = pdfjs.getDocument({
    // pdf.js takes ownership of the buffer it is given, so it reads a copy.
    data: new Uint8Array(bytes),
    ...assetUrls(),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: PDF_PAGE_IMAGES.imagePixels,
  });
  try {
    const document = await task.promise;
    const images: Array<string> = [];
    for (let number = 1; number <= document.numPages && budget.pages > 0; number += 1) {
      const page = await document.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: PDF_PAGE_IMAGES.longEdge / Math.max(natural.width, natural.height),
      });
      const sheet = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = sheet.getContext("2d");
      // A JPEG has no transparency: an unpainted page would come out black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, sheet.width, sheet.height);
      // pdf.js types its canvas as the DOM's; in Node it draws on this one (its NodeCanvasFactory).
      const target = { canvas: sheet, canvasContext: context, viewport };
      await page.render(target as unknown as Parameters<typeof page.render>[0]).promise;
      page.cleanup();
      const jpeg = await sheet.encode("jpeg", PDF_PAGE_IMAGES.jpegQuality);
      if (jpeg.byteLength > budget.bytes) break;
      budget.pages -= 1;
      budget.bytes -= jpeg.byteLength;
      images.push(jpeg.toString("base64"));
    }
    return { pageCount: document.numPages, images };
  } catch {
    return undefined;
  } finally {
    await task.destroy();
  }
};
