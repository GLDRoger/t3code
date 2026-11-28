import { createCanvas } from "@napi-rs/canvas";
import { ChatImageAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import { KinTurnContent } from "./content.ts";

export const prepareChatPhoto = Effect.fn("Test.prepareChatPhoto")(function* (
  attachmentsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const original = yield* Effect.promise(() => createCanvas(4000, 3000).encode("jpeg"));
  const photo = ChatImageAttachment.make({
    type: "image",
    id: "kin-chat-photo",
    name: "Harbor Cafe.jpg",
    mimeType: "image/jpeg",
    sizeBytes: original.byteLength,
  });
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  yield* fs.writeFile(resolveAttachmentPath({ attachmentsDir, attachment: photo })!, original);
  const prepared = yield* Effect.gen(function* () {
    const content = yield* KinTurnContent;
    return yield* content.prepare({ text: "Look at this", attachments: [photo] });
  }).pipe(
    Effect.provide(
      KinTurnContent.layer.pipe(
        Layer.provide(
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, attachmentsDir })),
          ).pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "kin-photo-request-" })),
          ),
        ),
        Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
      ),
    ),
  );
  return { original, prepared };
});
