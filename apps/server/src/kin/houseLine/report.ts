/** Lane reports must open with these lines. The server checks the first against the read log. */

const FIRST_READS = /^First reads:[ \t]*(.*)$/m;
const MISLEADING = /^Misleading notes:[ \t]*(.*)$/m;
const TOKEN = /^(?<kind>will|note):(?<id>\S+)$/u;

export interface KinReadRef {
  readonly kind: "will" | "note";
  readonly id: string;
}

export interface KinLaneReportLines {
  readonly firstReads: ReadonlyArray<KinReadRef>;
  readonly misleading: ReadonlyArray<KinReadRef>;
}

class KinLaneReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KinLaneReportError";
  }
}

export function parseLaneReport(body: string): KinLaneReportLines {
  const first = FIRST_READS.exec(body);
  const misleading = MISLEADING.exec(body);
  if (first === null || misleading === null) {
    throw new KinLaneReportError(
      "A lane report needs a First reads line and a Misleading notes line.",
    );
  }
  return {
    firstReads: parseTokens(first[1] ?? "", "First reads"),
    misleading: parseTokens(misleading[1] ?? "", "Misleading notes"),
  };
}

function readRefKey(ref: KinReadRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Set equality. Order in the report does not matter; a missing or extra read is a mismatch. */
export function firstReadsMatchLog(
  reported: ReadonlyArray<KinReadRef>,
  logged: ReadonlyArray<KinReadRef>,
): boolean {
  const left = new Set(reported.map(readRefKey));
  const right = new Set(logged.map(readRefKey));
  if (left.size !== right.size) return false;
  for (const key of left) {
    if (!right.has(key)) return false;
  }
  return true;
}

function parseTokens(raw: string, label: string): ReadonlyArray<KinReadRef> {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "none")) return [];
  return tokens.map((token) => {
    const match = TOKEN.exec(token);
    const kind = match?.groups?.kind;
    const id = match?.groups?.id;
    if ((kind !== "will" && kind !== "note") || id === undefined) {
      throw new KinLaneReportError(
        `${label} token '${token}' must look like note:<id> or will:<id>.`,
      );
    }
    return { kind, id };
  });
}
