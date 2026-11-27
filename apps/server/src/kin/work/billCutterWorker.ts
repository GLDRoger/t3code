// @effect-diagnostics nodeBuiltinImport:off -- the isolated cutter runs outside the server runtime.
import * as NodeBuffer from "node:buffer";
import * as NodeV8 from "node:v8";

import { createCanvas, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
  readJpegOrientation,
} from "@t3tools/shared/imageDimensions";

import { openPdfPageDocument, PDF_PAGE_IMAGES } from "../lead/turn/pdfPageImages.ts";
import {
  MAX_BILL_BOXES,
  refuseBillPage,
  type BillBox,
  type BillPage,
  type BillPageOutcome,
} from "./billCutterProtocol.ts";
import { inflatedTooFar } from "./statements/pdfStreamLimits.ts";

const PHOTO_PIXELS = 50_000_000;
const PDF_PIXELS = 12_000_000;
const PDF_SCALE = 300 / 72;
const CROP_LONG_EDGE = 2500;
const CROP_QUALITY = 85;
const GRID = 1000;
const PAD = 20;
const HEIC_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs)$/;

const isHeic = (bytes: NodeBuffer.Buffer) => {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;
  if (HEIC_BRANDS.test(bytes.toString("ascii", 8, 12))) return true;
  const end = Math.min(bytes.length, bytes.readUInt32BE(0));
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (HEIC_BRANDS.test(bytes.toString("ascii", offset, offset + 4))) return true;
  }
  return false;
};

const validBox = ([x, y, width, height]: BillBox) =>
  [x, y, width, height].every(Number.isInteger) &&
  x >= 0 &&
  y >= 0 &&
  width >= 50 &&
  height >= 50 &&
  x + width <= GRID &&
  y + height <= GRID;

const makeJpeg = async (
  source: Canvas | Image,
  left: number,
  top: number,
  width: number,
  height: number,
  maxEdge: number,
  quality: number,
) => {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const sheet = createCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  const context = sheet.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.drawImage(source, left, top, width, height, 0, 0, sheet.width, sheet.height);
  const jpeg = await sheet.encode("jpeg", quality);
  // Drop the native canvas surface now rather than leaving nine full-size crops for GC.
  sheet.width = 1;
  return jpeg;
};

const cut = async (
  source: Canvas | Image,
  boxes: ReadonlyArray<BillBox>,
  drawPreview: boolean,
): Promise<BillPageOutcome> => {
  const { width, height } = source;
  const crops: Array<Uint8Array> = [];
  for (const [x, y, w, h] of boxes) {
    const left = Math.floor((Math.max(0, x - PAD) * width) / GRID);
    const top = Math.floor((Math.max(0, y - PAD) * height) / GRID);
    const right = Math.ceil((Math.min(GRID, x + w + PAD) * width) / GRID);
    const bottom = Math.ceil((Math.min(GRID, y + h + PAD) * height) / GRID);
    crops.push(
      await makeJpeg(source, left, top, right - left, bottom - top, CROP_LONG_EDGE, CROP_QUALITY),
    );
  }
  const preview = drawPreview
    ? await makeJpeg(
        source,
        0,
        0,
        width,
        height,
        PDF_PAGE_IMAGES.longEdge,
        PDF_PAGE_IMAGES.jpegQuality,
      )
    : undefined;
  return {
    _tag: "cut",
    frame: { width, height },
    crops,
    ...(preview === undefined ? {} : { preview }),
  };
};

const cutPhoto = async (bytes: NodeBuffer.Buffer, boxes: ReadonlyArray<BillBox>) => {
  const header = bytes.subarray(0, IMAGE_DIMENSIONS_HEADER_BYTES);
  if (isHeic(header)) return refuseBillPage("heic");
  const dimensions = readImageDimensions(header);
  if (dimensions === null) return refuseBillPage("damaged");
  if (dimensions.width * dimensions.height > PHOTO_PIXELS) return refuseBillPage("photo_pixels");

  // Canvas applies JPEG EXIF during decode, so both outputs can sample the same bitmap directly.
  const photo = await loadImage(bytes);
  if (photo.width * photo.height > PHOTO_PIXELS) return refuseBillPage("photo_pixels");
  return cut(
    photo,
    boxes,
    readJpegOrientation(header) !== 1 ||
      Math.max(photo.width, photo.height) > PDF_PAGE_IMAGES.longEdge,
  );
};

const cutPdf = async (bytes: Uint8Array, input: Extract<BillPage, { kind: "pdf" }>) => {
  if (!Number.isInteger(input.page) || input.page < 1 || inflatedTooFar(bytes) !== undefined)
    return refuseBillPage("damaged");
  const task = await openPdfPageDocument(bytes);
  try {
    const document = await task.promise;
    if (document.numPages > PDF_PAGE_IMAGES.pagesPerTurn) return refuseBillPage("pdf_pages");
    if (input.page > document.numPages) return refuseBillPage("damaged");
    const page = await document.getPage(input.page);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(PDF_SCALE, Math.sqrt(PDF_PIXELS / (natural.width * natural.height))),
    });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);
    if (width < 1 || height < 1) return refuseBillPage("damaged");
    const sheet = createCanvas(width, height);
    const context = sheet.getContext("2d");
    const target = {
      canvas: sheet,
      canvasContext: context,
      viewport,
      transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0],
    };
    await page.render(target as unknown as Parameters<typeof page.render>[0]).promise;
    page.cleanup();
    return await cut(sheet, input.boxes, false);
  } finally {
    await task.destroy();
  }
};

export const runBillCutterWorker = async (request: string) => {
  // The result pipe belongs to the cutter protocol. pdf.js can print to the console.
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.debug = () => undefined;
  let outcome: BillPageOutcome;
  try {
    const page = JSON.parse(request) as BillPage;
    if (page.boxes.length > MAX_BILL_BOXES || !page.boxes.every(validBox)) {
      outcome = refuseBillPage("box");
    } else {
      const chunks: Array<NodeBuffer.Buffer> = [];
      for await (const chunk of process.stdin) chunks.push(chunk as NodeBuffer.Buffer);
      const bytes = NodeBuffer.Buffer.concat(chunks);
      outcome =
        page.kind === "photo" ? await cutPhoto(bytes, page.boxes) : await cutPdf(bytes, page);
    }
  } catch {
    outcome = refuseBillPage("damaged");
  }
  process.stdout.write(NodeV8.serialize({ outcome, peakKib: process.resourceUsage().maxRSS }));
};
