// A cookie-jar HTTP client for the spec: keeps cookies, finds the CSRF token in
// a page's form, posts form-encoded, and reads SSE streams.

export interface SseStream {
  messages: any[];
  /** Resolve with the first message (past or future) matching, or reject after ms. */
  waitFor(pred: (m: any) => boolean, ms?: number): Promise<any>;
  close(): void;
}

export class Client {
  jar = new Map<string, string>();
  private csrf: string | null = null;
  private streams: SseStream[] = [];
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private remember(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      this.jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }

  /** Fetch without following redirects; cookies are kept. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(new URL(path, this.baseUrl), {
      redirect: "manual",
      ...init,
      headers: { ...(init.headers as Record<string, string>), cookie: this.cookieHeader() },
    });
    this.remember(res);
    return res;
  }

  async get(path: string): Promise<{ res: Response; text: string }> {
    const res = await this.fetch(path);
    return { res, text: await res.text() };
  }

  /** The `_csrf` hidden field of a page's first form (the token is per cookie jar). */
  async csrfToken(from = "/"): Promise<string> {
    if (this.csrf) return this.csrf;
    const { text } = await this.get(from);
    const m = text.match(/name="_csrf" value="([0-9a-f]+)"/);
    if (!m) throw new Error(`no _csrf field on ${from}`);
    return (this.csrf = m[1]!);
  }

  /** POST form-encoded. `csrf: false` leaves the token out on purpose. */
  async post(path: string, fields: Record<string, string> = {}, opts: { csrf?: boolean } = {}): Promise<Response> {
    const body = new URLSearchParams(fields);
    if (opts.csrf !== false) body.set("_csrf", await this.csrfToken());
    return this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  async setCallsign(callsign: string): Promise<Response> {
    return this.post("/crew", { callsign });
  }

  /** POST /m/CODE/act and parse its JSON. */
  async act(code: string, fields: Record<string, string>): Promise<{ status: number; body: any }> {
    const res = await this.post(`/m/${code}/act`, fields);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** Open an SSE stream; read until closed. */
  stream(path: string): SseStream {
    const ctrl = new AbortController();
    const messages: any[] = [];
    const waiters: (() => void)[] = [];
    (async () => {
      try {
        const res = await fetch(new URL(path, this.baseUrl), {
          headers: { cookie: this.cookieHeader() },
          signal: ctrl.signal,
        });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) {
              messages.push(JSON.parse(data));
              waiters.splice(0).forEach((w) => w());
            }
          }
        }
      } catch {
        // aborted
      }
    })();
    const s: SseStream = {
      messages,
      close: () => ctrl.abort(),
      waitFor(pred, ms = 1000) {
        return new Promise((resolve, reject) => {
          const started = Date.now();
          const check = (): void => {
            const hit = messages.find(pred);
            if (hit) return resolve(hit);
            const left = ms - (Date.now() - started);
            if (left <= 0) return reject(new Error(`no matching stream message within ${ms} ms; got ${JSON.stringify(messages).slice(0, 600)}`));
            const t = setTimeout(check, left);
            waiters.push(() => { clearTimeout(t); check(); });
          };
          check();
        });
      },
    };
    this.streams.push(s);
    return s;
  }

  closeStreams(): void {
    this.streams.forEach((s) => s.close());
    this.streams = [];
  }
}

export const uniqueCallsign = (prefix: string): string => `${prefix}${Math.random().toString(36).slice(2, 8)}`.slice(0, 16);

/** Every key in a JSON value, at any depth. */
export function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}
