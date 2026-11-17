// @effect-diagnostics nodeBuiltinImport:off -- zlib's raw deflate and crc32 are what a zip is made of.
import * as NodeZlib from "node:zlib";
import * as NodeStream from "@effect/platform-node/NodeStream";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";

/**
 * A zip written as it goes: each file is deflated as its bytes arrive, its sizes and CRC follow
 * it in a data descriptor, and the directory comes last. Nothing is held but the directory, so
 * an export of any size streams through in bounded memory. Zip32 only: past 4 GiB it dies.
 */

export type ZipEntry<E, R> = {
  readonly name: string;
  readonly data: Stream.Stream<Uint8Array, E, R>;
};

const LIMIT = 0xffff_ffff;
const UTF8_AND_DESCRIPTOR = 0x0800 | 0x0008;
const DEFLATE = 8;

/** Zip keeps a local time with no zone; UTC is as good a reading as any. */
const dosStamp = (ms: number) => {
  const at = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
  return {
    time: (at.hour << 11) | (at.minute << 5) | Math.floor(at.second / 2),
    date: (Math.max(at.year - 1980, 0) << 9) | (at.month << 5) | at.day,
  };
};

const tooLarge = () => new Error("The export is larger than a zip without zip64 can hold (4 GiB).");

export const zipStream = <E, R>(
  entries: Stream.Stream<ZipEntry<E, R>, E, R>,
  modifiedAt: number,
): Stream.Stream<Uint8Array, E | Cause.UnknownError, R> =>
  Stream.suspend(() => {
    const { time, date } = dosStamp(modifiedAt);
    const directory: Array<Uint8Array> = [];
    let offset = 0;
    let count = 0;
    const advance = (bytes: number) => {
      offset += bytes;
      if (offset > LIMIT) throw tooLarge();
    };

    const files = entries.pipe(
      Stream.flatMap((entry) => {
        const name = Buffer.from(entry.name, "utf8");
        const start = offset;
        let crc = 0;
        let size = 0;
        let packed = 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
        local.writeUInt16LE(DEFLATE, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt16LE(name.length, 26);
        const head = Buffer.concat([local, name]);
        const body = entry.data.pipe(
          Stream.map((chunk) => {
            crc = NodeZlib.crc32(chunk, crc);
            size += chunk.length;
            return chunk;
          }),
          NodeStream.pipeThroughSimple(() => NodeZlib.createDeflateRaw()),
          Stream.map((chunk) => {
            packed += chunk.length;
            advance(chunk.length);
            return chunk;
          }),
        );
        const tail = Stream.suspend(() => {
          if (size > LIMIT) throw tooLarge();
          const descriptor = Buffer.alloc(16);
          descriptor.writeUInt32LE(0x08074b50, 0);
          descriptor.writeUInt32LE(crc, 4);
          descriptor.writeUInt32LE(packed, 8);
          descriptor.writeUInt32LE(size, 12);
          advance(descriptor.length);
          const central = Buffer.alloc(46);
          central.writeUInt32LE(0x02014b50, 0);
          central.writeUInt16LE(20, 4);
          central.writeUInt16LE(20, 6);
          central.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
          central.writeUInt16LE(DEFLATE, 10);
          central.writeUInt16LE(time, 12);
          central.writeUInt16LE(date, 14);
          central.writeUInt32LE(crc, 16);
          central.writeUInt32LE(packed, 20);
          central.writeUInt32LE(size, 24);
          central.writeUInt16LE(name.length, 28);
          central.writeUInt32LE(start, 42);
          directory.push(central, name);
          count += 1;
          return Stream.make(descriptor as Uint8Array);
        });
        return Stream.suspend(() => {
          advance(head.length);
          return Stream.make(head as Uint8Array);
        }).pipe(Stream.concat(body), Stream.concat(tail));
      }),
    );

    const end = Stream.suspend(() => {
      const listed = Buffer.concat(directory);
      if (count > 0xffff || offset + listed.length > LIMIT) throw tooLarge();
      const record = Buffer.alloc(22);
      record.writeUInt32LE(0x06054b50, 0);
      record.writeUInt16LE(count, 8);
      record.writeUInt16LE(count, 10);
      record.writeUInt32LE(listed.length, 12);
      record.writeUInt32LE(offset, 16);
      return Stream.make(listed as Uint8Array, record as Uint8Array);
    });
    return files.pipe(Stream.concat(end));
  });
