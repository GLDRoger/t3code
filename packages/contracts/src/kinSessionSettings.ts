import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { NonNegativeInt } from "./baseSchemas.ts";

export const KinSessionCompactAtTokens = NonNegativeInt.pipe(
  Schema.decodeTo(
    NonNegativeInt,
    SchemaTransformation.transform({
      decode: (tokens) => Math.min(800_000, Math.max(100_000, tokens)),
      encode: (tokens) => tokens,
    }),
  ),
);
