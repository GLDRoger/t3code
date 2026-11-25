/** A file another app handed to Kin: the system's copy on iOS, a content URI on Android. */
export type KinSharedFile = {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
};

/** The existing import screen a shared file opens on, with the file already picked there. */
export type KinSharedFileLanding = {
  readonly screen: "KinBillsAdd" | "KinImport";
  readonly file: KinSharedFile;
};

const SPREADSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  csv: "text/csv",
  xlsx: SPREADSHEET,
};

// Mirrored in app.config.ts, with PDFs and images, as the types the app declares it opens.
const IMPORT_TYPES = new Set([
  "text/csv",
  "text/comma-separated-values",
  "application/csv",
  SPREADSHEET,
]);

const lastSegment = (uri: string) => {
  const segment = uri.split(/[?#]/, 1)[0]?.split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Where a file shared into Kin lands: client imports read spreadsheets, Bills reads photos and
 * PDFs, and anything else goes to Bills, which refuses it as it would a picked one. Null for a
 * link that isn't a file, which the app's own linking handles.
 */
export function kinSharedFileLanding(shared: {
  readonly uri: string;
  readonly name?: string | null;
  readonly mimeType?: string | null;
}): KinSharedFileLanding | null {
  if (!/^(file|content):/i.test(shared.uri)) return null;
  const name = (shared.name?.trim() || lastSegment(shared.uri).trim() || "file").slice(0, 200);
  const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  const given = shared.mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  const mimeType =
    given !== "" && given !== "application/octet-stream"
      ? given
      : (TYPE_OF_EXTENSION[extension] ?? "application/octet-stream");
  return {
    screen: IMPORT_TYPES.has(mimeType) ? "KinImport" : "KinBillsAdd",
    file: { uri: shared.uri, name, mimeType },
  };
}
