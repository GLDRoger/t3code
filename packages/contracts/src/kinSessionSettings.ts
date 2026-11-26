import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { NonNegativeInt } from "./baseSchemas.ts";

export const KinSessionCompactAtTokens = NonNegativeInt.pipe(
  Schema.decodeTo(
    NonNegativeInt,
    SchemaTransformation.transform({
      decode: (tokens) => Math.min(150_000, Math.max(70_000, tokens)),
      encode: (tokens) => tokens,
    }),
  ),
);
