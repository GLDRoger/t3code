// @effect-diagnostics nodeBuiltinImport:off -- fixtures are ZIPs built byte by byte, as a worker could.
import * as NodeZlib from "node:zlib";

export type Part = readonly [name: string, text: string];
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006";

/** A ZIP as Office writes one; `bend` alters one part's headers or the bytes around them. */
export const zip = (
  parts: ReadonlyArray<Part>,
  bend: {
    readonly flags?: number;
    readonly name?: (name: string) => string;
    readonly crc?: number;
    readonly before?: Buffer;
    readonly after?: Buffer;
    readonly extra?: (name: string) => Buffer;
    /** Moves sizes and CRC to a data descriptor after each part's bytes, written by this. */
    readonly descriptor?: (crc: number, packed: number, size: number) => Buffer;
  } = {},
) => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const data = Buffer.from(text, "utf8");
    const packed = NodeZlib.deflateRawSync(data);
    const nameBytes = Buffer.from(bend.name?.(name) ?? name, "utf8");
    const crc = bend.crc ?? NodeZlib.crc32(data);
    const flags = (bend.flags ?? 0) | (bend.descriptor === undefined ? 0 : 0x0008);
    const extra = bend.extra?.(name) ?? Buffer.alloc(0);
    const trailer = bend.descriptor?.(crc, packed.length, data.length) ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    if (bend.descriptor === undefined) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, extra, packed, trailer);
    centrals.push(central, nameBytes, extra);
    offset += local.length + nameBytes.length + extra.length + packed.length + trailer.length;
  }
  const between = bend.before ?? Buffer.alloc(0);
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset + between.length, 16);
  return Buffer.concat([...locals, between, directory, end, bend.after ?? Buffer.alloc(0)]);
};

export const types = (main: string, type: string, more = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${type}"/>${more}</Types>`;
export const rels = (...relationships: ReadonlyArray<string>) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE}/relationships">${relationships.join("")}</Relationships>`;
export const relationship = (type: string, target: string, external = false) =>
  `<Relationship Id="r${type.length}${target.length}" Type="${OFFICE}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
