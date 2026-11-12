// pdfjs-dist ships no types for its worker module; statementFiles only hands it back to pdf.js.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
