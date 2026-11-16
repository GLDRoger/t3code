// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a dev CLI speaking effect-rpc's JSON frames.
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";

/** A failure the CLI prints as one line: what happened and what to do next. */
export class VerifyError extends Error {}

/** Exchanges a one-use pairing credential for an access token, as `t3 pair` clients do. */
export async function exchangePairing(origin: string, credential: string): Promise<string> {
  const response = await fetch(new URL("/oauth/token", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }),
  });
  if (!response.ok) throw new VerifyError(`token exchange failed (${response.status})`);
  return ((await response.json()) as { access_token: string }).access_token;
}

interface Waiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly chunks: Array<unknown>;
  readonly onChunk?: (values: ReadonlyArray<unknown>) => boolean;
}

/** Effect RPC over the server's `/ws`, spoken as raw JSON frames so any method can be called. */
export class RpcConnection {
  private readonly socket: WebSocket;
  private readonly waiters = new Map<string, Waiter>();
  private next = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => {
      for (const waiter of this.waiters.values()) waiter.reject(new VerifyError("socket closed"));
      this.waiters.clear();
    });
  }

  static async open(origin: string, accessToken: string): Promise<RpcConnection> {
    const ticket = await fetch(new URL("/api/auth/websocket-ticket/rpc", origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      },
    });
    if (ticket.status === 401)
      throw new VerifyError("session expired or revoked; rerun `kin-verify up` to mint a new one");
    if (!ticket.ok) throw new VerifyError(`websocket ticket refused (${ticket.status})`);
    const url = new URL("/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
    url.searchParams.set("wsTicket", ((await ticket.json()) as { ticket: string }).ticket);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new VerifyError("websocket failed")), {
        once: true,
      });
    });
    return new RpcConnection(socket);
  }

  private send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  private receive(raw: string) {
    const parsed = JSON.parse(raw) as unknown;
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const frame = message as {
        _tag: string;
        requestId?: string | number;
        values?: ReadonlyArray<unknown>;
        exit?: { _tag: string; value?: unknown; cause?: ReadonlyArray<Record<string, unknown>> };
        defect?: unknown;
      };
      if (frame._tag === "Ping") {
        this.send({ _tag: "Pong" });
        continue;
      }
      if (frame._tag === "Defect") {
        for (const waiter of this.waiters.values())
          waiter.reject(new VerifyError(`server defect: ${JSON.stringify(frame.defect)}`));
        this.waiters.clear();
        continue;
      }
      const id = String(frame.requestId);
      const waiter = this.waiters.get(id);
      if (waiter === undefined) continue;
      if (frame._tag === "Chunk") {
        const values = frame.values ?? [];
        waiter.chunks.push(...values);
        this.send({ _tag: "Ack", requestId: id });
        if (waiter.onChunk?.(values) === true) {
          this.waiters.delete(id);
          this.send({ _tag: "Interrupt", requestId: id });
          waiter.resolve(waiter.chunks);
        }
        continue;
      }
      if (frame._tag !== "Exit") continue;
      this.waiters.delete(id);
      const exit = frame.exit;
      if (exit?._tag === "Success") {
        waiter.resolve(waiter.chunks.length > 0 ? waiter.chunks : exit.value);
        continue;
      }
      const cause = exit?.cause ?? [];
      const failure = cause.find((part) => part._tag === "Fail")?.error;
      const defect = cause.find((part) => part._tag === "Die")?.defect;
      waiter.reject(new RpcFailure(failure ?? defect ?? cause));
    }
  }

  /** One request; a stream resolves with its chunks once `until` says enough (default: first). */
  call(
    method: string,
    payload: unknown,
    options: {
      readonly until?: (values: ReadonlyArray<unknown>) => boolean;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const id = String(this.next++);
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new VerifyError(`${method} gave no answer in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          error.message = `${method}: ${error.message}`;
          reject(error);
        },
        chunks: [],
        onChunk: options.until ?? (() => true),
      });
      this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
    });
  }

  close() {
    this.socket.close();
  }
}

/** A typed failure the server returned, such as `KinChatError { reason, message }`. */
export class RpcFailure extends Error {
  readonly error: unknown;
  constructor(error: unknown) {
    const tagged = error as { _tag?: string; reason?: string; message?: string };
    super(
      tagged !== null && typeof tagged === "object"
        ? [tagged._tag, tagged.reason, tagged.message].filter(Boolean).join(": ")
        : JSON.stringify(error),
    );
    this.error = error;
  }
}
