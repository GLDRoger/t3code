import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Trimmed, non-empty text a lead tool takes. Its bound and description sit on the encoded side,
 * which is what tools/list advertises; `TrimmedNonEmptyString`'s own checks are not shown there.
 */
export const KinToolText = (max: number, description?: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
    .annotate(description === undefined ? {} : { description })
    .pipe(Schema.decodeTo(TrimmedNonEmptyString.check(Schema.isMaxLength(max))));
