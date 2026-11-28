// @effect-diagnostics nodeBuiltinImport:off -- the standalone benchmark samples Linux host load and available memory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { createCanvas, ImageData } from "@napi-rs/canvas";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { cutBillPage } from "../src/kin/work/billCutter.ts";
import type { BillBox, BillPageInput } from "../src/kin/work/billCutterProtocol.ts";

const grid = [15, 348, 681];
const boxes: ReadonlyArray<BillBox> = grid.flatMap((y) =>
  grid.map((x) => [x, y, 304, 304] as const),
);

export const billPhoto = async (width: number, height: number, rotate = false) => {
  const sheet = createCanvas(width, height);
  const context = sheet.getContext("2d");
  const grain = new Uint8ClampedArray(width * height * 4);
  let seed = 90;
  for (let pixel = 0; pixel < grain.length; pixel += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const light = 210 + (seed >>> (width > 5000 ? 29 : 27));
    grain[pixel] = light;
    grain[pixel + 1] = light - 2;
    grain[pixel + 2] = light - 7;
    grain[pixel + 3] = 255;
  }
  context.putImageData(new ImageData(grain, width, height), 0, 0);
  if (rotate) {
    context.translate(0, height);
    context.rotate(-Math.PI / 2);
  }
  const uprightWidth = rotate ? height : width;
  const uprightHeight = rotate ? width : height;
  for (const [index, [x, y, w, h]] of boxes.entries()) {
    const [left, top, boxWidth, boxHeight] = [
      (x * uprightWidth) / 1000,
      (y * uprightHeight) / 1000,
      (w * uprightWidth) / 1000,
      (h * uprightHeight) / 1000,
    ];
    context.strokeStyle = "#27201b";
    context.lineWidth = 3;
    context.strokeRect(left, top, boxWidth, boxHeight);
    context.fillStyle = "#27201b";
    const fontSize = Math.round(boxHeight / 26);
    context.font = `bold ${fontSize}px sans-serif`;
    context.fillText(index % 2 ? "Inkspot Cloud" : "Harbor Power", left + 30, top + fontSize * 2);
    context.font = `${fontSize}px sans-serif`;
    context.fillText("Tidewater Freight", left + 30, top + fontSize * 4);
    context.fillText(`Invoice INV-8240${index}`, left + 30, top + fontSize * 6);
    for (let line = 0; line < 12; line += 1) {
      context.fillText(
        `Service ${line + 1}     USD ${index + line + 10}.00`,
        left + 30,
        top + fontSize * (line + 8),
      );
    }
    context.fillText(`Total USD ${186 + 12 * index}.00`, left + 30, top + fontSize * 22);
  }
  const jpeg = await sheet.encode("jpeg", 91);
  return rotate ? withJpegOrientation(jpeg, 6) : jpeg;
};

export const withJpegOrientation = (jpeg: Uint8Array, orientation: number) => {
  const exif = Buffer.from(
    "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
    "hex",
  );
  exif[28] = orientation;
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
};

export const scannedBillPdf = ({
  jpeg,
  width,
  height,
  pageWidth = 595.2,
  pageHeight = 841.92,
  pageCount = 1,
}: {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly pageWidth?: number;
  readonly pageHeight?: number;
  readonly pageCount?: number;
}) => {
  const stream = (dict: string, data: Uint8Array) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.byteLength} >>\nstream\n`),
      data,
      Buffer.from("\nendstream"),
    ]);
  const pages = Array.from({ length: pageCount }, () =>
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Scan 3 0 R >> >> /Contents 4 0 R >>`,
    ),
  );
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(
      `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map((_, index) => `${5 + index} 0 R`).join(" ")}] >>`,
    ),
    stream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpeg,
    ),
    stream("", Buffer.from(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Scan Do Q`)),
    ...pages,
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  let offset = parts[0]!.byteLength;
  const offsets = objects.map((body, index) => {
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    const start = offset;
    offset += part.byteLength;
    return start;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.map((start) => `${String(start).padStart(10, "0")} 00000 n \n`).join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
};

const measure = async (label: string, input: BillPageInput) => {
  const load = NodeOS.loadavg()
    .map((value) => value.toFixed(2))
    .join(", ");
  const available =
    Effect.runSync(HostProcess.Platform) === "linux"
      ? Number(/MemAvailable:\s+(\d+)/.exec(NodeFS.readFileSync("/proc/meminfo", "utf8"))?.[1]) /
        1024 /
        1024
      : undefined;
  const started = performance.now();
  const { outcome, peakKib } = await Effect.runPromise(cutBillPage(input));
  const seconds = (performance.now() - started) / 1000;
  if (outcome._tag !== "cut") throw new Error(`${label} — ${outcome.problem} (${outcome.reason})`);
  const memory = available === undefined ? "" : `, ${available.toFixed(1)} GiB available`;
  const mb = (input.bytes.byteLength / 1_000_000).toFixed(2);
  process.stdout.write(
    `${label} (${outcome.frame.width}×${outcome.frame.height}, ${mb} MB, ${outcome.crops.length} crops) — ${seconds.toFixed(3)} s, ${(peakKib / 1024).toFixed(1)} MiB child peak RSS, load ${load}${memory}\n`,
  );
};

if (import.meta.main) {
  await measure("12 MP photo", { kind: "photo", bytes: await billPhoto(4032, 3024, true), boxes });
  await measure("50 MP photo", { kind: "photo", bytes: await billPhoto(8192, 6103), boxes });
  const width = 2480;
  const height = 3508;
  const jpeg = await billPhoto(width, height);
  await measure("Scanned A4 PDF at 300 dpi", {
    kind: "pdf",
    page: 1,
    bytes: scannedBillPdf({ jpeg, width, height }),
    boxes,
  });
}
