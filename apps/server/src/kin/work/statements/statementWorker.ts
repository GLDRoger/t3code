// @effect-diagnostics nodeBuiltinImport:off -- the isolated reader process: no server runtime is loaded here.
import * as NodeBuffer from "node:buffer";

import { readStatementFile } from "./statementFiles.ts";

/**
 * The reader process's side: stdin carries a 4-byte length, the password's UTF-8 bytes and then
 * the file; stdout carries the outcome as one JSON document. The password lives only here.
 */
export const runStatementWorker = async () => {
  // pdf.js reports through the console; only the outcome may reach stdout.
  const quiet = () => undefined;
  console.log = quiet;
  console.info = quiet;
  console.warn = quiet;
  console.debug = quiet;
  const chunks: Array<NodeBuffer.Buffer> = [];
  for await (const chunk of process.stdin) chunks.push(chunk as NodeBuffer.Buffer);
  const input = NodeBuffer.Buffer.concat(chunks);
  const length = input.readUInt32LE(0);
  const password = length === 0 ? undefined : input.subarray(4, 4 + length).toString("utf8");
  input.fill(0, 4, 4 + length);
  const outcome = await readStatementFile(new Uint8Array(input.subarray(4 + length)), password);
  process.stdout.write(JSON.stringify(outcome));
};
