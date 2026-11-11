import * as Schema from "effect/Schema";

const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const HOSTED_PAIRING_LABEL_PARAM = "label";
const PAIRING_APP_LINK_PARAM = "pairingUrl";
const APP_LINK_PROTOCOL = /^t3code(?:-[a-z]+)?:$/;
const SUPPORTED_REMOTE_BACKEND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

export class RemoteBackendUrlMissingError extends Schema.TaggedError<RemoteBackendUrlMissingError>()(
  "RemoteBackendUrlMissingError",
  {},
) {
  override get message(): string {
    return "Enter a backend URL.";
  }
}

export class RemotePairingUrlInvalidError extends Schema.TaggedError<RemotePairingUrlInvalidError>()(
  "RemotePairingUrlInvalidError",
  {
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Pairing URL is invalid.";
  }
}

export class RemoteBackendUrlInvalidError extends Schema.TaggedError<RemoteBackendUrlInvalidError>()(
  "RemoteBackendUrlInvalidError",
  {
    source: Schema.Literals(["direct-host", "hosted-pairing-host"]),
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Backend URL is invalid.";
  }
}

export class RemotePairingTokenMissingError extends Schema.TaggedError<RemotePairingTokenMissingError>()(
  "RemotePairingTokenMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Pairing URL is missing its token.";
  }
}

export class RemotePairingCodeMissingError extends Schema.TaggedError<RemotePairingCodeMissingError>()(
  "RemotePairingCodeMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Enter a pairing code.";
  }
}

export const RemotePairingTargetError = Schema.Union([
  RemoteBackendUrlMissingError,
  RemotePairingUrlInvalidError,
  RemoteBackendUrlInvalidError,
  RemotePairingTokenMissingError,
  RemotePairingCodeMissingError,
]);
export type RemotePairingTargetError = typeof RemotePairingTargetError.Type;

const hasSupportedRemoteBackendProtocol = (url: URL): boolean =>
  SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(url.protocol);

const normalizeRemoteBaseUrl = (
  rawValue: string,
  source: RemoteBackendUrlInvalidError["source"],
): URL => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new RemoteBackendUrlMissingError();
  }

  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  const normalizedInput = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)
    ? withoutLeadingSlashes
    : `https://${withoutLeadingSlashes}`;
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch (cause) {
    throw new RemoteBackendUrlInvalidError({ source, cause });
  }
  if (!hasSupportedRemoteBackendProtocol(url)) {
    throw new RemoteBackendUrlInvalidError({
      source,
      protocol: url.protocol,
    });
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  /** The credential is a Kin teammate's invite, redeemed for a chat-only session. */
  readonly kinInvite?: true;
}

/** The page a Kin teammate's invite link names; its fragment is the single-use secret. */
export const KIN_INVITE_LINK_PATH = "/kin/invite";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};

export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};

export const readHostedPairingRequest = (url: URL): HostedPairingRequest | null => {
  const host = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get(HOSTED_PAIRING_LABEL_PARAM)?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  };
};

/** Wraps a pairing URL in the `t3code://pair` link that desktop opens and mobile scans. */
export const buildPairingAppLink = (pairingUrl: string): string =>
  `t3code://pair?${new URLSearchParams([[PAIRING_APP_LINK_PARAM, pairingUrl]])}`;

/** Reads the pairing URL from a `t3code://pair` link on any app channel scheme. */
export const readPairingAppLink = (value: string): string | null => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (!APP_LINK_PROTOCOL.test(url.protocol) || url.host !== "pair") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return url.searchParams.get(PAIRING_APP_LINK_PARAM)?.trim() || null;
};

const KIN_JOIN_APP_LINK_PARAM = "link";

const kinInviteSecret = (url: URL): string =>
  url.pathname === KIN_INVITE_LINK_PATH && getPairingTokenFromUrl(url) === null
    ? url.hash.slice(1).trim()
    : "";

/** Wraps a join link in the `t3code://kin/join` link a phone's browser hands to the app. */
export const buildKinJoinAppLink = (joinLink: string): string =>
  `t3code://kin/join?${new URLSearchParams([[KIN_JOIN_APP_LINK_PARAM, joinLink]])}`;

/**
 * The teammate's join link in pasted text, a scanned code or an app link, or null when there is
 * none. People paste whole messages, so the link may sit among other words.
 */
export const readKinJoinLink = (text: string): string | null => {
  for (const word of text.split(/\s+/)) {
    const candidate = word.replace(/^[<("']+|[>)"',.;]+$/g, "");
    if (!URL.canParse(candidate)) continue;
    const url = new URL(candidate);
    if (APP_LINK_PROTOCOL.test(url.protocol)) {
      const wrapped = url.searchParams.get(KIN_JOIN_APP_LINK_PARAM);
      const inner =
        url.host === "kin" && url.pathname === "/join" && wrapped ? readKinJoinLink(wrapped) : null;
      if (inner !== null) return inner;
      continue;
    }
    if ((url.protocol === "https:" || url.protocol === "http:") && kinInviteSecret(url) !== "") {
      return url.toString();
    }
  }
  return null;
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(pairingUrl);
    } catch (cause) {
      throw new RemotePairingUrlInvalidError({ cause });
    }
    if (!hasSupportedRemoteBackendProtocol(url)) {
      throw new RemotePairingUrlInvalidError({
        protocol: url.protocol,
      });
    }
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      const hostedBackendUrl = normalizeRemoteBaseUrl(
        hostedPairingRequest.host,
        "hosted-pairing-host",
      );
      return {
        credential: hostedPairingRequest.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackendUrl),
        wsBaseUrl: toWsBaseUrl(hostedBackendUrl),
      };
    }

    const credential = getPairingTokenFromUrl(url) ?? "";
    const inviteSecret = kinInviteSecret(url);
    if (inviteSecret) {
      const origin = new URL(url.origin);
      return {
        credential: decodeURIComponent(inviteSecret),
        httpBaseUrl: toHttpBaseUrl(origin),
        wsBaseUrl: toWsBaseUrl(origin),
        kinInvite: true,
      };
    }
    if (!credential) {
      throw new RemotePairingTokenMissingError({ host: url.host });
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new RemoteBackendUrlMissingError();
  }
  const normalizedHost = normalizeRemoteBaseUrl(host, "direct-host");
  if (!pairingCode) {
    throw new RemotePairingCodeMissingError({ host: normalizedHost.host });
  }

  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
};
