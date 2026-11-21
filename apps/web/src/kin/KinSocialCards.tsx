import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { useAtomValue } from "@effect/atom-react";
import type { KinCardNotice } from "@t3tools/client-runtime/kin/kinDeferralPresentation";
import {
  KIN_SOCIAL_ACTION_LABELS,
  kinSocialCardActions,
  kinSocialCardTaps,
  kinSocialNoticeShown,
  kinSocialPostActions,
  type KinSocialNotice,
  type KinSocialPackView,
  type KinSocialTap,
  type KinSocialPostTone,
  type KinSocialPostView,
  type KinSocialWeekView,
  KIN_SOCIAL_COPY,
} from "@t3tools/client-runtime/kin/kinSocial";
import type { EnvironmentId, KinSocialMedia } from "@t3tools/contracts";
import { useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { AttachmentImage } from "../components/media/AttachmentImage";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { cn, randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { CardFrame } from "./KinCards";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";

const CANT_ACT_TEXT = KIN_DEVICE_COPY.cantAct("browser", "answer");

const TONE_CLASSES: Record<KinSocialPostTone, string> = {
  waiting: "text-muted-foreground",
  active: "text-foreground",
  done: "text-success-foreground",
  error: "text-destructive-foreground",
  muted: "text-muted-foreground",
};

/** One tap at a time per card; a refusal shows in the owner's words until the card changes. */
function useSocialTaps(
  environmentId: EnvironmentId,
  view: Pick<KinSocialWeekView, "widgetId" | "revision">,
) {
  const post = useAtomCommand(kinClient.widgetAction, { reportFailure: false });
  const canAct = useAtomValue(kinClient.widgetAction.permissionAtom(environmentId));
  const [taps] = useState(kinSocialCardTaps);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<KinSocialNotice>(null);
  const { press } = kinSocialCardActions({
    view,
    environmentId,
    newId: randomUUID,
    taps,
    post,
    set: { pending: setPending, notice: setNotice },
  });
  return {
    canAct,
    pending,
    notice: kinSocialNoticeShown(notice, view),
    press,
  };
}

function Notice(props: { readonly notice: KinCardNotice | null }) {
  if (props.notice === null) return null;
  return (
    <p
      role={props.notice.kind === "sent" ? "status" : "alert"}
      className={cn(
        "text-xs font-medium",
        props.notice.kind === "error" ? "text-destructive-foreground" : "text-warning-foreground",
      )}
    >
      {props.notice.text}
    </p>
  );
}

/** A post's picture as the platform will get it, small; a video or file shows its name. */
function MediaThumb(props: {
  readonly environmentId: EnvironmentId;
  readonly media: KinSocialMedia;
  readonly size: "small" | "large";
}) {
  const { media } = props;
  const image = media.mimeType.startsWith("image/");
  const [src] = useAssetUrls(
    props.environmentId,
    image
      ? [
          {
            _tag: "attachment",
            attachmentId: media.attachmentId,
            fileName: media.name,
            mimeType: media.mimeType,
          },
        ]
      : [],
  );
  const [failed, setFailed] = useState(false);
  const box = props.size === "small" ? "size-16 shrink-0" : "h-40 w-full max-w-xs self-start";
  if (!image || failed || src == null)
    return (
      <div
        className={cn(
          box,
          "flex items-center justify-center rounded-md border border-border bg-muted/40 p-1 text-center text-2xs leading-tight text-muted-foreground",
        )}
      >
        <span className="line-clamp-3 break-all">{media.name}</span>
      </div>
    );
  return (
    <div className={cn(box, "overflow-hidden rounded-md border border-border bg-image-ground")}>
      <AttachmentImage
        name={media.name}
        mimeType={media.mimeType}
        src={src}
        alt={KIN_SOCIAL_COPY.postPicture(media.name)}
        decoding="async"
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </div>
  );
}

function PostRow(props: {
  readonly post: KinSocialPostView;
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
  readonly canAct: boolean;
  readonly pending: string | null;
  readonly press: (key: string, tap: KinSocialTap) => void;
}) {
  const { post } = props;
  const actions = props.canAct ? kinSocialPostActions(post, props.nowMs) : [];
  const removed = post.tone === "muted";
  return (
    <li className="flex gap-3 py-2.5">
      {post.media === null ? null : (
        <MediaThumb environmentId={props.environmentId} media={post.media} size="small" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{post.when}</span>
            {" · "}
            {post.account} on {post.platform}
          </p>
          <span className={cn("text-xs font-medium", TONE_CLASSES[post.tone])}>{post.state}</span>
        </div>
        <p
          className={cn(
            "whitespace-pre-line break-words line-clamp-6",
            removed ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          {post.caption}
        </p>
        {post.reason === null ? null : (
          <p
            className={cn(
              "text-xs",
              post.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {post.reason}
          </p>
        )}
        {post.url === null && actions.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {post.url === null ? null : (
              <a
                className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {KIN_SOCIAL_COPY.seePost}
              </a>
            )}
            {actions.map((action) => {
              const key = `${action}:${post.postId}`;
              return (
                <Button
                  key={action}
                  size="xs"
                  variant={action === "retry" ? "outline" : "ghost"}
                  disabled={props.pending !== null}
                  aria-busy={props.pending === key}
                  onClick={() => props.press(key, { actionId: action, value: post.postId })}
                >
                  {KIN_SOCIAL_ACTION_LABELS[action]}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

/** One group's week: a real preview of every post, remove per post, and one Confirm. */
export function KinSocialWeekCard(props: {
  readonly week: KinSocialWeekView;
  readonly environmentId: EnvironmentId;
}) {
  const { week, environmentId } = props;
  const nowMs = useNowMinuteMs();
  const { canAct, pending, notice, press } = useSocialTaps(environmentId, week);
  const forClient = week.clientReview;
  return (
    <CardFrame eyebrow={week.eyebrow} label={week.accessibilityLabel}>
      <p className="font-medium text-foreground">{week.title}</p>
      <ul className="flex flex-col divide-y divide-border">
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
      </ul>
      {forClient === null ? null : (
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
          <label className="flex min-h-9 items-center justify-between gap-3">
            <span className="text-sm text-foreground">{forClient.label}</span>
            <Switch
              checked={forClient.ok}
              disabled={!canAct || pending !== null || week.confirm === null}
              onCheckedChange={(checked) =>
                void press("client_ok", { actionId: "client_ok", value: checked })
              }
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {forClient.preview === null ? null : (
              <PreviewFile environmentId={environmentId} media={forClient.preview} />
            )}
            {canAct && forClient.canPreview ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                aria-busy={pending === "preview"}
                onClick={() => void press("preview", { actionId: "preview", value: null })}
              >
                {forClient.previewLabel}
              </Button>
            ) : forClient.making ? (
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {forClient.previewLabel}
              </span>
            ) : null}
          </div>
        </div>
      )}
      <Notice notice={notice} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {week.confirm !== null && !week.confirm.ready && forClient !== null
            ? `Turn on "${forClient.label}" to confirm.`
            : week.status}
        </p>
        {week.confirm === null ? null : !canAct ? (
          <p className="text-xs text-muted-foreground">{CANT_ACT_TEXT}</p>
        ) : (
          <Button
            size="sm"
            disabled={pending !== null || !week.confirm.ready}
            aria-busy={pending === "confirm"}
            onClick={() =>
              week.confirm !== null &&
              void press("confirm", { actionId: "confirm", value: week.confirm.digest })
            }
          >
            {week.confirm.label}
          </Button>
        )}
      </div>
    </CardFrame>
  );
}

function PreviewFile(props: {
  readonly environmentId: EnvironmentId;
  readonly media: KinSocialMedia;
}) {
  const [href] = useAssetUrls(props.environmentId, [
    {
      _tag: "attachment",
      attachmentId: props.media.attachmentId,
      fileName: props.media.name,
      mimeType: props.media.mimeType,
    },
  ]);
  return href == null ? null : (
    <a
      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
      href={href}
      download={props.media.name}
      target="_blank"
      rel="noopener noreferrer"
    >
      {props.media.name}
    </a>
  );
}

/** A post to make by hand: where and when, why, the caption to copy and the file to save. */
export function KinSocialPackCard(props: {
  readonly pack: KinSocialPackView;
  readonly environmentId: EnvironmentId;
}) {
  const { pack, environmentId } = props;
  const { canAct, pending, notice, press } = useSocialTaps(environmentId, pack);
  const [copied, setCopied] = useState(false);
  const [href] = useAssetUrls(
    environmentId,
    pack.media === null
      ? []
      : [
          {
            _tag: "attachment",
            attachmentId: pack.media.attachmentId,
            fileName: pack.media.name,
            mimeType: pack.media.mimeType,
          },
        ],
  );
  return (
    <CardFrame eyebrow={pack.eyebrow} label={`${pack.eyebrow}: ${pack.title}`}>
      <p className="font-medium text-foreground">{pack.title}</p>
      <p className="text-xs text-muted-foreground">{pack.why}</p>
      {pack.media === null ? null : (
        <MediaThumb environmentId={environmentId} media={pack.media} size="large" />
      )}
      <p className="whitespace-pre-line break-words rounded-md border border-border bg-muted/30 px-3 py-2 text-foreground">
        {pack.caption}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(pack.caption).then(() => setCopied(true))
          }
        >
          {copied ? "Copied" : "Copy caption"}
        </Button>
        {pack.media === null || href == null ? null : (
          <Button size="xs" variant="outline" render={<a href={href} download={pack.media.name} />}>
            {KIN_SOCIAL_COPY.saveFile}
          </Button>
        )}
        {pack.posted ? (
          <span className="text-xs font-medium text-success-foreground">Posted</span>
        ) : canAct ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending !== null}
            aria-busy={pending === "posted"}
            onClick={() => void press("posted", { actionId: "posted", value: null })}
          >
            {KIN_SOCIAL_ACTION_LABELS.posted}
          </Button>
        ) : null}
      </div>
      {pack.reminder === null ? null : (
        <p className="text-xs text-muted-foreground">{pack.reminder}</p>
      )}
      <Notice notice={notice} />
    </CardFrame>
  );
}
