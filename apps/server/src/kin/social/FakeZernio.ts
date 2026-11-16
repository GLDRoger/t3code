// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a dev and test fixture: a JSON file, post times.
import * as NodeFS from "node:fs";

/**
 * A local Zernio that answers the calls Kin's real connector makes (profiles, accounts, health,
 * connect links, analytics, best times, business discovery, presign and upload, posts), so the
 * whole path runs with nothing leaving the machine. Deterministic: ids count up, and time is the
 * clock it is given. For tests, and for `vp run dev` with `KIN_DEV_FAKE_SOCIAL`.
 */
export type FakeSocialAccount = {
  readonly accountId: string;
  readonly profileId: string;
  readonly platform: string;
  readonly username: string;
  readonly displayName: string;
  canPost: boolean;
};

export type FakeSocialPost = {
  readonly id: string;
  readonly profileId: string;
  readonly accountId: string;
  readonly platform: string;
  readonly content: string;
  readonly scheduledFor: string;
  readonly mediaUrl: string | null;
  readonly idempotencyKey: string | null;
  status: "scheduled" | "published" | "failed" | "cancelled";
  url: string | null;
  error: string | null;
};

export type FakeSocialPast = {
  readonly accountId: string;
  readonly platform: string;
  readonly content: string;
  readonly publishedAt: string;
  readonly mediaType: string;
  readonly likes: number;
  readonly comments: number;
  readonly saves: number;
  readonly shares: number;
  readonly reach: number;
};

export type FakeSocialState = {
  profiles: Array<{ readonly profileId: string; readonly name: string }>;
  /** Each key and the profiles it reaches; "all" is a whole-workspace key. */
  keys: Record<string, { readonly profiles: ReadonlyArray<string> | "all"; expired: boolean }>;
  accounts: Array<FakeSocialAccount>;
  posts: Array<FakeSocialPost>;
  past: Array<FakeSocialPast>;
  uploads: Record<string, { readonly bytes: number; readonly type: string }>;
  publicAccounts: Record<
    string,
    {
      readonly name: string;
      readonly followers: number;
      readonly recent: ReadonlyArray<FakeSocialPast>;
    }
  >;
  /** The next publish on this account fails with this reason. */
  failNext: Record<string, string>;
  /** Every call, method and path, so a test can count reads. */
  calls: Array<string>;
  down: boolean;
  seq: number;
};

export interface FakeSocialStore {
  readonly load: () => FakeSocialState;
  readonly save: (state: FakeSocialState) => void;
}

const empty = (): FakeSocialState => ({
  profiles: [],
  keys: {},
  accounts: [],
  posts: [],
  past: [],
  uploads: {},
  publicAccounts: {},
  failNext: {},
  calls: [],
  down: false,
  seq: 0,
});

export const memoryStore = (state: FakeSocialState = empty()): FakeSocialStore => ({
  load: () => state,
  save: () => {},
});

/** The dev server's fake: one JSON file, read on every call, so a script can change it. */
export const fileStore = (path: string): FakeSocialStore => ({
  load: () =>
    NodeFS.existsSync(path)
      ? { ...empty(), ...(JSON.parse(NodeFS.readFileSync(path, "utf8")) as FakeSocialState) }
      : empty(),
  save: (state) => NodeFS.writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string, type = "invalid_request_error") =>
  json({ error, type }, status);

const API = "/api/v1";
const HOSTS = new Set(["zernio.com", "uploads.zernio.example"]);

export const makeFakeZernio = (
  store: FakeSocialStore = memoryStore(),
  now: () => number = () => Date.now(),
) => {
  const change = <A>(run: (state: FakeSocialState) => A): A => {
    const state = store.load();
    const result = run(state);
    store.save(state);
    return result;
  };
  const id = (state: FakeSocialState, prefix: string) => {
    state.seq += 1;
    return `${prefix}${String(state.seq).padStart(6, "0")}`;
  };

  /** A profile with its accounts and a key limited to it; returns the key. */
  const addProfile = (input: {
    readonly name: string;
    readonly accounts: ReadonlyArray<{
      readonly platform: string;
      readonly username: string;
      readonly displayName: string;
    }>;
    readonly key?: string;
    readonly wholeWorkspace?: boolean;
  }) =>
    change((state) => {
      const profileId = id(state, "prof_");
      state.profiles.push({ profileId, name: input.name });
      for (const account of input.accounts)
        state.accounts.push({ ...account, accountId: id(state, "acc_"), profileId, canPost: true });
      const key = input.key ?? `sk_fake_${profileId}`;
      state.keys[key] = {
        profiles: input.wholeWorkspace === true ? "all" : [profileId],
        expired: false,
      };
      return { profileId, key };
    });
  const accountsOf = (profileId: string) =>
    store.load().accounts.filter((account) => account.profileId === profileId);
  const addPast = (past: ReadonlyArray<FakeSocialPast>) =>
    change((state) => void state.past.push(...past));
  const addPublic = (username: string, account: FakeSocialState["publicAccounts"][string]) =>
    change((state) => void (state.publicAccounts[username.toLowerCase()] = account));
  const failNext = (accountId: string, reason: string) =>
    change((state) => void (state.failNext[accountId] = reason));
  const expireKey = (key: string, expired = true) =>
    change((state) => void (state.keys[key] && (state.keys[key].expired = expired)));
  const setCanPost = (accountId: string, canPost: boolean) =>
    change((state) => {
      const account = state.accounts.find((one) => one.accountId === accountId);
      if (account !== undefined) account.canPost = canPost;
    });
  const setDown = (down: boolean) => change((state) => void (state.down = down));

  /** Publishes every scheduled post whose time has come, as the service would. */
  const publishDue = (state: FakeSocialState) => {
    for (const post of state.posts) {
      if (post.status !== "scheduled" || Date.parse(post.scheduledFor) > now()) continue;
      publish(state, post);
    }
  };
  const publish = (state: FakeSocialState, post: FakeSocialPost) => {
    const reason = state.failNext[post.accountId];
    if (reason !== undefined) {
      delete state.failNext[post.accountId];
      post.status = "failed";
      post.error = reason;
      return;
    }
    const account = state.accounts.find((one) => one.accountId === post.accountId);
    post.status = "published";
    post.error = null;
    post.url = `https://social.example/${account?.username ?? "account"}/${post.id}`;
  };

  const postBody = (post: FakeSocialPost) => ({
    _id: post.id,
    content: post.content,
    status: post.status,
    scheduledFor: post.scheduledFor,
    profileId: post.profileId,
    platforms: [
      {
        platform: post.platform,
        accountId: post.accountId,
        status: post.status === "published" ? "published" : post.status,
        platformPostUrl: post.url ?? undefined,
        errorMessage: post.error ?? undefined,
      },
    ],
  });

  const api = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname.slice(API.length);
    const method = request.method;
    const state = store.load();
    state.calls.push(`${method} ${path}`);
    const finish = (response: Response) => {
      store.save(state);
      return response;
    };
    if (state.down) return finish(refuse(503, "Service unavailable", "api_error"));
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const key = state.keys[bearer];
    if (key === undefined || key.expired)
      return finish(refuse(401, "Invalid API key", "authentication_error"));
    const reaches = (profileId: string) =>
      key.profiles === "all" || key.profiles.includes(profileId);
    const account = (accountId: string) =>
      state.accounts.find((one) => one.accountId === accountId && reaches(one.profileId));
    publishDue(state);

    if (method === "GET" && path === "/profiles")
      return finish(
        json({
          profiles: state.profiles
            .filter((profile) => reaches(profile.profileId))
            .map((profile) => ({ _id: profile.profileId, name: profile.name })),
        }),
      );
    if (method === "GET" && path === "/webhooks/settings")
      return finish(
        key.profiles === "all"
          ? json({ webhooks: [] })
          : refuse(403, "A profile-scoped API key can't manage webhooks.", "permission_error"),
      );
    if (method === "GET" && path === "/accounts") {
      const profileId = url.searchParams.get("profileId");
      if (profileId !== null && !reaches(profileId))
        return finish(refuse(403, "Profile not accessible", "permission_error"));
      return finish(
        json({
          accounts: state.accounts
            .filter((one) => reaches(one.profileId))
            .filter((one) => profileId === null || one.profileId === profileId)
            .map((one) => ({
              _id: one.accountId,
              platform: one.platform,
              profileId: one.profileId,
              username: one.username,
              displayName: one.displayName,
              isActive: true,
            })),
        }),
      );
    }
    if (method === "GET" && path === "/accounts/health")
      return finish(
        json({
          accounts: state.accounts
            .filter((one) => reaches(one.profileId))
            .map((one) => ({
              accountId: one.accountId,
              platform: one.platform,
              profileId: one.profileId,
              canPost: one.canPost,
              needsReconnect: !one.canPost,
              status: one.canPost ? "healthy" : "error",
            })),
        }),
      );
    if (method === "POST" && path === "/platform-invites") {
      const body = (await request.json()) as { profileId?: string; platform?: string };
      if (body.profileId === undefined || !reaches(body.profileId))
        return finish(refuse(403, "Profile not accessible", "permission_error"));
      const invite = id(state, "inv_");
      return finish(
        json({
          invite: {
            _id: invite,
            platform: body.platform,
            expiresAt: new Date(now() + 7 * 86_400_000).toISOString(),
            inviteUrl: `https://zernio.com/api/v1/platform-invites/${invite}/connect`,
          },
        }),
      );
    }
    if (method === "GET" && path === "/analytics") {
      const profileId = url.searchParams.get("profileId") ?? "";
      if (!reaches(profileId))
        return finish(refuse(403, "Profile not accessible", "permission_error"));
      const from = Date.parse(url.searchParams.get("fromDate") ?? "1970-01-01");
      const only = url.searchParams.get("accountId");
      const mine = new Set(accountsOf(profileId).map((one) => one.accountId));
      return finish(
        json({
          posts: state.past
            .filter(
              (past) => mine.has(past.accountId) && (only === null || past.accountId === only),
            )
            .filter((past) => Date.parse(past.publishedAt) >= from)
            .map((past, index) => ({
              _id: `ext_${index}`,
              content: past.content,
              publishedAt: past.publishedAt,
              status: "published",
              platform: past.platform,
              mediaType: past.mediaType,
              platformPostUrl: `https://social.example/p/${index}`,
              platforms: [{ accountId: past.accountId, platform: past.platform }],
              analytics: {
                likes: past.likes,
                comments: past.comments,
                saves: past.saves,
                shares: past.shares,
                reach: past.reach,
                views: past.reach,
              },
            })),
        }),
      );
    }
    if (method === "GET" && path === "/analytics/best-time") {
      const profileId = url.searchParams.get("profileId") ?? "";
      if (!reaches(profileId))
        return finish(refuse(403, "Profile not accessible", "permission_error"));
      const mine = new Set(accountsOf(profileId).map((one) => one.accountId));
      const slots = new Map<string, { day: number; hour: number; sum: number; n: number }>();
      for (const past of state.past.filter((one) => mine.has(one.accountId))) {
        const at = new Date(past.publishedAt);
        const day = (at.getUTCDay() + 6) % 7;
        const slot = slots.get(`${day}:${at.getUTCHours()}`) ?? {
          day,
          hour: at.getUTCHours(),
          sum: 0,
          n: 0,
        };
        slot.sum += past.likes + past.comments + past.shares + past.saves;
        slot.n += 1;
        slots.set(`${day}:${at.getUTCHours()}`, slot);
      }
      return finish(
        json({
          slots: [...slots.values()]
            .map((slot) => ({
              day_of_week: slot.day,
              hour: slot.hour,
              avg_engagement: slot.sum / slot.n,
              post_count: slot.n,
            }))
            .sort((a, b) => b.avg_engagement - a.avg_engagement),
        }),
      );
    }
    const discovery = /^\/accounts\/([^/]+)\/instagram\/business-discovery$/.exec(path);
    if (method === "GET" && discovery !== null) {
      const via = account(decodeURIComponent(discovery[1]!));
      if (via === undefined)
        return finish(refuse(403, "Account not accessible", "permission_error"));
      if (via.platform !== "instagram")
        return finish(refuse(400, "Business discovery needs an Instagram account."));
      const username = (url.searchParams.get("username") ?? "").replace(/^@/, "").toLowerCase();
      const found = state.publicAccounts[username];
      if (found === undefined)
        return finish(refuse(404, "No public business account by that name.", "not_found"));
      return finish(
        json({
          profile: {
            id: `ig_${username}`,
            username,
            name: found.name,
            followersCount: found.followers,
            mediaCount: found.recent.length,
          },
          media: found.recent.map((past, index) => ({
            id: `m_${index}`,
            caption: past.content,
            timestamp: past.publishedAt,
            likeCount: past.likes,
            commentsCount: past.comments,
            mediaType: past.mediaType.toUpperCase(),
            mediaProductType: "FEED",
            permalink: `https://social.example/${username}/${index}`,
          })),
        }),
      );
    }
    if (method === "POST" && path === "/media/presign") {
      const body = (await request.json()) as { filename?: string; contentType?: string };
      const upload = id(state, "up_");
      state.uploads[upload] = { bytes: -1, type: body.contentType ?? "application/octet-stream" };
      return finish(
        json({
          uploadUrl: `https://uploads.zernio.example/put/${upload}?signature=fake`,
          publicUrl: `https://media.zernio.example/${upload}/${body.filename ?? "file"}`,
          key: upload,
          type: (body.contentType ?? "").startsWith("video/") ? "video" : "image",
        }),
      );
    }
    if (method === "POST" && path === "/posts") {
      const idem = request.headers.get("idempotency-key");
      const repeat =
        idem === null ? undefined : state.posts.find((post) => post.idempotencyKey === idem);
      if (repeat !== undefined) return finish(json({ post: postBody(repeat) }, 200));
      const body = (await request.json()) as {
        content?: string;
        scheduledFor?: string;
        platforms?: ReadonlyArray<{ platform: string; accountId: string }>;
        mediaItems?: ReadonlyArray<{ url: string }>;
      };
      const target = body.platforms?.[0];
      const into = target === undefined ? undefined : account(target.accountId);
      if (target === undefined || into === undefined)
        return finish(refuse(403, "Account not accessible with this key", "permission_error"));
      if (!into.canPost)
        return finish(refuse(400, "This account needs reconnecting.", "platform_error"));
      if (into.platform === "instagram" && (body.mediaItems ?? []).length === 0)
        return finish(refuse(400, "Instagram posts need an image or a video."));
      const post: FakeSocialPost = {
        id: id(state, "post_"),
        profileId: into.profileId,
        accountId: into.accountId,
        platform: into.platform,
        content: body.content ?? "",
        scheduledFor: body.scheduledFor ?? new Date(now()).toISOString(),
        mediaUrl: body.mediaItems?.[0]?.url ?? null,
        idempotencyKey: idem,
        status: "scheduled",
        url: null,
        error: null,
      };
      state.posts.push(post);
      // Zernio publishes a past time at once, inside the request.
      if (Date.parse(post.scheduledFor) <= now()) publish(state, post);
      return finish(json({ message: "Post created", post: postBody(post) }, 201));
    }
    const one = /^\/posts\/([^/]+)(\/retry)?$/.exec(path);
    if (one !== null) {
      const post = state.posts.find((found) => found.id === decodeURIComponent(one[1]!));
      if (post === undefined || account(post.accountId) === undefined)
        return finish(refuse(404, "Post not found", "not_found"));
      if (method === "GET" && one[2] === undefined) return finish(json({ post: postBody(post) }));
      if (method === "DELETE" && one[2] === undefined) {
        if (post.status === "published")
          return finish(refuse(400, "Published posts cannot be deleted; unpublish instead."));
        state.posts = state.posts.filter((found) => found !== post);
        return finish(json({ message: "Post deleted" }));
      }
      if (method === "POST" && one[2] === "/retry") {
        if (post.status !== "failed")
          return finish(refuse(409, "Only a failed post can be retried."));
        publish(state, post);
        return finish(json({ post: postBody(post) }));
      }
    }
    return finish(refuse(404, `No route ${method} ${path}`, "not_found"));
  };

  /** Answers for Zernio's hosts; anything else goes to `fallback`. */
  const handle = (fallback: typeof globalThis.fetch) =>
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (!HOSTS.has(url.host)) return fallback(request);
        if (url.host === "uploads.zernio.example") {
          const upload = /^\/put\/([^/]+)$/.exec(url.pathname)?.[1];
          const bytes = (await request.arrayBuffer()).byteLength;
          return change((state) => {
            state.calls.push(`PUT upload`);
            if (upload === undefined || state.uploads[upload] === undefined)
              return new Response("no such upload", { status: 403 });
            state.uploads[upload] = { ...state.uploads[upload], bytes };
            return new Response(null, { status: 200 });
          });
        }
        if (!url.pathname.startsWith(API)) return refuse(404, "Not the API");
        return api(request, url);
      },
      { preconnect() {} },
    ) satisfies typeof globalThis.fetch;

  return {
    addProfile,
    accountsOf,
    addPast,
    addPublic,
    failNext,
    expireKey,
    setCanPost,
    setDown,
    publishDue: () => change(publishDue),
    handle,
    load: store.load,
  };
};
export type FakeZernio = ReturnType<typeof makeFakeZernio>;
