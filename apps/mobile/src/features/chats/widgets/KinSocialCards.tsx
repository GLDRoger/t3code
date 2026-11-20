import { useAtomValue } from "@effect/atom-react";
import {
  createKinCardActions,
  type KinCardNotice,
} from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import {
  KIN_SOCIAL_ACTION_LABELS,
  kinSocialActInput,
  kinSocialFailureNotice,
  kinSocialPostActions,
  type KinSocialPackView,
  type KinSocialPostTone,
  type KinSocialPostView,
  type KinSocialWeekView,
  KIN_SOCIAL_COPY,
} from "@t3tools/client-runtime/kin/kinSocial";
import { kinFailure } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinSocialMedia,
  KinSocialPackCardAction,
  KinSocialWeekCardAction,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Image as ExpoImage } from "expo-image";
import { useRef, useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { assetImageSource } from "../../../lib/assetImageSource";
import { downloadAndShareAttachment } from "../../../lib/attachmentDownload";
import { useNowMinuteMs } from "../../../lib/clock";
import { cn } from "../../../lib/cn";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../../lib/uuid";
import { useAssetUrl } from "../../../state/assets";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";

const TONE_CLASSES: Record<KinSocialPostTone, string> = {
  waiting: "text-foreground-muted",
  active: "text-foreground",
  done: "text-success-foreground",
  error: "text-danger-foreground",
  muted: "text-foreground-muted",
};

type Tap = {
  readonly actionId: KinSocialWeekCardAction | KinSocialPackCardAction;
  readonly value: unknown;
};
type Target = Pick<KinSocialWeekView, "widgetId" | "revision">;

/** One tap at a time per card; a refusal shows in the owner's words until the card changes. */
function useSocialTaps(environmentId: EnvironmentId, view: Target) {
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const actions = useRef<ReturnType<typeof createKinCardActions<Target, string>> | null>(null);
  const taps = useRef(new Map<string, Tap>());
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ revision: number; notice: KinCardNotice } | null>(null);
  const press = async (key: string, tap: Tap) => {
    taps.current.set(key, tap);
    if (actions.current === null)
      actions.current = createKinCardActions<Target, string>({
        newId: uuidv4,
        toInput: (target, actionKey, clientActionId) =>
          kinSocialActInput(target, taps.current.get(actionKey)!, clientActionId),
        failureNotice: (cause) => kinSocialFailureNotice(cause),
        post: async (input) => {
          const result = await post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false as const, cause: squashAtomCommandFailure(result) }
            : { ok: true as const };
        },
      });
    const revision = view.revision;
    const outcome = await actions.current(view, key, () => {
      setPending(key);
      setNotice(null);
    });
    if (outcome.status === "ignored") return;
    setPending(null);
    if (outcome.status === "failed") setNotice({ revision, notice: outcome.notice });
  };
  return {
    canAct,
    pending,
    notice: notice !== null && notice.revision === view.revision ? notice.notice : null,
    press,
  };
}

function NoticeText(props: { readonly notice: KinCardNotice | null }) {
  if (props.notice === null) return null;
  return (
    <Text
      accessibilityRole={props.notice.kind === "sent" ? undefined : "alert"}
      textRole="footnote"
      className={
        props.notice.kind === "error" ? "text-danger-foreground" : "text-warning-foreground"
      }
    >
      {props.notice.text}
    </Text>
  );
}

const attachmentOf = (media: KinSocialMedia) => ({
  _tag: "attachment" as const,
  attachmentId: media.attachmentId,
  fileName: media.name,
  mimeType: media.mimeType,
});

/** The post's picture as the platform will get it; a video or file shows its name. */
function MediaThumb(props: {
  readonly environmentId: EnvironmentId;
  readonly media: KinSocialMedia;
  readonly size: "small" | "large";
}) {
  const { media } = props;
  const image = media.mimeType.startsWith("image/");
  const resource = image ? attachmentOf(media) : null;
  const uri = useAssetUrl(props.environmentId, resource);
  const [failed, setFailed] = useState(false);
  const box = props.size === "small" ? "h-16 w-16" : "h-44 w-full";
  return (
    <View
      className={cn(
        box,
        "items-center justify-center overflow-hidden rounded-xl border border-border bg-subtle",
      )}
    >
      {resource === null || uri === null || failed ? (
        <Text
          textRole="caption"
          className="px-1 text-center text-foreground-muted"
          numberOfLines={3}
        >
          {media.name}
        </Text>
      ) : (
        <ExpoImage
          source={assetImageSource(props.environmentId, resource, uri)}
          contentFit="cover"
          accessibilityLabel={KIN_SOCIAL_COPY.postPicture(media.name)}
          style={{ width: "100%", height: "100%" }}
          onError={() => setFailed(true)}
        />
      )}
    </View>
  );
}

function PostRow(props: {
  readonly post: KinSocialPostView;
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
  readonly canAct: boolean;
  readonly pending: string | null;
  readonly press: (key: string, tap: Tap) => void;
}) {
  const { post } = props;
  const actions = props.canAct ? kinSocialPostActions(post, props.nowMs) : [];
  const removed = post.tone === "muted";
  return (
    <View className="flex-row gap-3 border-t border-border py-3">
      {post.media === null ? null : (
        <MediaThumb environmentId={props.environmentId} media={post.media} size="small" />
      )}
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row flex-wrap items-baseline justify-between gap-x-2">
          <Text textRole="caption" className="text-foreground-muted">
            <Text textRole="caption" className="font-t3-medium text-foreground">
              {post.when}
            </Text>
            {" · "}
            {post.account} on {post.platform}
          </Text>
          <Text textRole="caption" className={cn("font-t3-medium", TONE_CLASSES[post.tone])}>
            {post.state}
          </Text>
        </View>
        <Text
          textRole="footnote"
          numberOfLines={8}
          selectable
          className={removed ? "text-foreground-muted line-through" : "text-foreground"}
        >
          {post.caption}
        </Text>
        {post.reason === null ? null : (
          <Text
            textRole="caption"
            className={post.tone === "error" ? "text-danger-foreground" : "text-foreground-muted"}
          >
            {post.reason}
          </Text>
        )}
        {post.url === null && actions.length === 0 ? null : (
          <View className="flex-row flex-wrap gap-2 pt-1">
            {post.url === null ? null : (
              <Button
                label={KIN_SOCIAL_COPY.seePost}
                tone="text"
                size="compact"
                onPress={() => void Linking.openURL(post.url!)}
              />
            )}
            {actions.map((action) => {
              const key = `${action}:${post.postId}`;
              return (
                <Button
                  key={action}
                  label={KIN_SOCIAL_ACTION_LABELS[action]}
                  tone={action === "retry" ? "outline" : "text"}
                  size="compact"
                  disabled={props.pending !== null}
                  loading={props.pending === key}
                  onPress={() => props.press(key, { actionId: action, value: post.postId })}
                />
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}

/** A file on a card, shared through the phone's own sheet so the owner can save or send it. */
function useShareFile(environmentId: EnvironmentId, media: KinSocialMedia | null) {
  const uri = useAssetUrl(environmentId, media === null ? null : attachmentOf(media));
  return uri === null || media === null
    ? null
    : () => {
        const controller = new AbortController();
        void downloadAndShareAttachment({
          url: uri,
          attachment: { name: media.name, mimeType: media.mimeType },
          signal: controller.signal,
        }).catch((error: unknown) =>
          Dialog.alert("Couldn't open the file", kinFailure(error, "Couldn't open the file.").text),
        );
      };
}

/** One group's week: every post as it will go out, remove per post, and one Confirm. */
export function KinSocialWeekCard(props: {
  readonly week: KinSocialWeekView;
  readonly environmentId: EnvironmentId;
}) {
  const { week, environmentId } = props;
  const nowMs = useNowMinuteMs();
  const { canAct, pending, notice, press } = useSocialTaps(environmentId, week);
  const review = week.clientReview;
  const sharePreview = useShareFile(environmentId, review?.preview ?? null);
  return (
    <View
      accessibilityLabel={week.accessibilityLabel}
      className="gap-2 rounded-[20px] border border-border bg-card-alt p-4"
    >
      <Text textRole="caption" className="text-foreground-muted">
        {week.eyebrow}
      </Text>
      <Text textRole="body" className="font-t3-medium text-foreground">
        {week.title}
      </Text>
      <View>
        {week.posts.map((post) => (
          <PostRow
            key={post.postId}
            post={post}
            environmentId={environmentId}
            nowMs={nowMs}
            canAct={canAct}
            pending={pending}
            press={(key, tap) => void press(key, tap)}
          />
        ))}
      </View>
      {review === null ? null : (
        <View className="gap-2 border-t border-border pt-3">
          <View className="min-h-11 flex-row items-center justify-between gap-3">
            <Text textRole="footnote" className="flex-1 text-foreground">
              {review.label}
            </Text>
            <ThemedSwitch
              accessibilityLabel={review.label}
              value={review.ok}
              disabled={!canAct || pending !== null || week.confirm === null}
              onValueChange={(value) => void press("client_ok", { actionId: "client_ok", value })}
            />
          </View>
          <View className="flex-row flex-wrap items-center gap-2">
            {sharePreview === null || review.preview === null ? null : (
              <Button
                label={`Send ${review.preview.name}`}
                icon="square.and.arrow.up"
                tone="outline"
                size="compact"
                onPress={sharePreview}
              />
            )}
            {canAct && review.canPreview ? (
              <Button
                label={review.previewLabel}
                tone="text"
                size="compact"
                disabled={pending !== null}
                loading={pending === "preview"}
                onPress={() => void press("preview", { actionId: "preview", value: null })}
              />
            ) : review.making ? (
              <Text textRole="caption" className="text-foreground-muted">
                {review.previewLabel}
              </Text>
            ) : null}
          </View>
        </View>
      )}
      <NoticeText notice={notice} />
      <View className="gap-2 border-t border-border pt-3">
        <Text textRole="caption" className="text-foreground-muted">
          {week.confirm !== null && !week.confirm.ready && review !== null
            ? `Turn on "${review.label}" to confirm.`
            : week.status}
        </Text>
        {week.confirm === null || !canAct ? null : (
          <Button
            label={week.confirm.label}
            tone="primary"
            fullWidth
            disabled={pending !== null || !week.confirm.ready}
            loading={pending === "confirm"}
            onPress={() =>
              week.confirm !== null &&
              void press("confirm", { actionId: "confirm", value: week.confirm.digest })
            }
          />
        )}
      </View>
    </View>
  );
}

/** A post to make by hand: where and when, why, the caption to copy and the file to save. */
export function KinSocialPackCard(props: {
  readonly pack: KinSocialPackView;
  readonly environmentId: EnvironmentId;
}) {
  const { pack, environmentId } = props;
  const { canAct, pending, notice, press } = useSocialTaps(environmentId, pack);
  const share = useShareFile(environmentId, pack.media);
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text textRole="caption" className="text-foreground-muted">
        {pack.eyebrow}
      </Text>
      <Text textRole="body" className="font-t3-medium text-foreground">
        {pack.title}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {pack.why}
      </Text>
      {pack.media === null ? null : (
        <MediaThumb environmentId={environmentId} media={pack.media} size="large" />
      )}
      <View className="rounded-xl bg-subtle px-3 py-2">
        <Text textRole="body" selectable className="text-foreground">
          {pack.caption}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Copy caption"
          icon="doc.on.doc"
          tone="outline"
          size="compact"
          onPress={() => void tryCopyTextWithHaptic(pack.caption, { target: "caption" })}
        />
        {share === null ? null : (
          <Button
            label={KIN_SOCIAL_COPY.saveFile}
            icon="square.and.arrow.up"
            tone="outline"
            size="compact"
            onPress={share}
          />
        )}
        {pack.posted ? (
          <Text textRole="footnote" className="self-center font-t3-medium text-success-foreground">
            Posted
          </Text>
        ) : canAct ? (
          <Button
            label={KIN_SOCIAL_ACTION_LABELS.posted}
            tone="text"
            size="compact"
            disabled={pending !== null}
            loading={pending === "posted"}
            onPress={() => void press("posted", { actionId: "posted", value: null })}
          />
        ) : null}
      </View>
      {pack.reminder === null ? null : (
        <Text textRole="caption" className="text-foreground-muted">
          {pack.reminder}
        </Text>
      )}
      <NoticeText notice={notice} />
    </View>
  );
}
