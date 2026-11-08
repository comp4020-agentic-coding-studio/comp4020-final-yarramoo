// Track E chat: the server's relay, rate limit, length cap and refusals over the real protocol; the frames' layout;
// the mention matcher; and that markup in a message renders as text.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { CHAT_HISTORY_MAX, CHAT_PER_WINDOW } from "../../server/world.ts";
import { C_CHAT, MAX_CHAT_BYTES, MAX_CHAT_CHARS, S_CHAT, decodeClient, decodeServer, encodeChat, encodeChatLine } from "../../shared/protocol.ts";
import { chatSegments, mentions, renderChatLine } from "../../client/chat.ts";
import { buildHashHex, connect, register, sleep, waitFor, type TestClient } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function boot(): Promise<RunningServer> {
  const d = mkdtempSync(join(tmpdir(), "sand-chat-"));
  const s = await startServer({ port: 0, dataDir: d, quiet: true, inputSummaryMs: 100000 });
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  cleanups.push(() => s.close());
  return s;
}
const GAME = 1;

describe("chat relay", () => {
  it("relays a line to every member with the sender's plain name, and never logs the body", async () => {
    const s = await boot();
    const ana = await register(s.port, "Ana");
    const bo = await register(s.port, "Bo");
    const a = await connect(s.port, hex, { world: GAME, token: ana.token });
    const b = await connect(s.port, hex, { world: GAME, token: bo.token });
    const spec = await connect(s.port, hex, { world: GAME, spectate: true });
    a.chat("hello @Bo, secret-body-xyz");
    await waitFor(() => b.chats.length === 1 && a.chats.length === 1 && spec.chats.length === 1, 3000, "relay");
    expect(b.chats[0]).toEqual({ name: "Ana", text: "hello @Bo, secret-body-xyz", history: false });
    expect(b.chats[0].name).not.toContain("#");
    const logged = JSON.stringify(s.log.recent());
    expect(logged).not.toContain("secret-body-xyz");
    a.close();
    b.close();
    spec.close();
  });

  it("a registered spectator may chat; an anonymous connection may not", async () => {
    const s = await boot();
    const cy = await register(s.port, "Cy");
    const p = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Pat")).token });
    const watcher = await connect(s.port, hex, { world: GAME, token: cy.token, spectate: true });
    const anon = await connect(s.port, hex, { world: GAME, spectate: true });
    anon.chat("from nobody");
    watcher.chat("from the stands");
    await waitFor(() => p.chats.length >= 1, 3000, "spectator line");
    await sleep(200);
    expect(p.chats.map((c) => c.text)).toEqual(["from the stands"]);
    expect(p.chats[0].name).toBe("Cy");
    expect(s.log.recent().some((e) => e.ev === "input.rejected" && e.reason === "chat_anonymous")).toBe(true);
    p.close();
    watcher.close();
    anon.close();
  });

  it("refuses control characters and over-long lines, trims, and logs only the reason", async () => {
    const s = await boot();
    const a = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Ana")).token });
    const b = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Bo")).token });
    a.chat("bad\u0007bell");
    a.chat("rtl‮override");
    a.chat("x".repeat(MAX_CHAT_CHARS + 1));
    a.chat("   ");
    a.chat("  " + "y".repeat(MAX_CHAT_CHARS) + "  ");
    await waitFor(() => b.chats.length === 1, 3000, "the one good line");
    await sleep(200);
    expect(b.chats.map((c) => c.text)).toEqual(["y".repeat(MAX_CHAT_CHARS)]);
    const reasons = s.log.recent().filter((e) => e.ev === "input.rejected").map((e) => e.reason);
    expect(reasons).toContain("chat_control"); // limited per connection: the first refusal is the one logged
    a.close();
    b.close();
  });

  it("refuses invisible lines: format characters (U+2060, U+FEFF, U+061C) and blank-looking fillers (review-chat L1)", async () => {
    const s = await boot();
    const a = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Ana")).token });
    const b = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Bo")).token });
    // A leading U+FEFF never reaches the server: TextDecoder drops a BOM, so "\ufeffhi" arrives as plain "hi". Mid-line it is refused.
    for (const bad of ["a\u2060b", "h\ufeffi", "x\u061cy", "\u3164\u3164", "\u2800", " \u3164 \u115f\uffa0 "]) a.chat(bad);
    await sleep(10_500); // past the 5-per-10 s window, so on a regression the invisible lines show up in the diff, not as a timeout
    a.chat("visible");
    await waitFor(() => b.chats.some((c) => c.text === "visible"), 3000, "the visible line");
    await sleep(200);
    expect(b.chats.map((c) => c.text)).toEqual(["visible"]);
    a.close();
    b.close();
  });

  it("rate-limits per player, and a reconnect does not refill the budget", async () => {
    const s = await boot();
    const ana = await register(s.port, "Ana");
    const a = await connect(s.port, hex, { world: GAME, token: ana.token });
    const b = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Bo")).token });
    for (let i = 0; i < CHAT_PER_WINDOW + 3; i++) a.chat(`line ${i}`);
    await waitFor(() => b.chats.length === CHAT_PER_WINDOW, 3000, "the allowed lines");
    await sleep(300);
    expect(b.chats).toHaveLength(CHAT_PER_WINDOW);
    expect(s.log.recent().some((e) => e.ev === "input.rate_limited" && e.what === "chat")).toBe(true);
    a.close();
    await sleep(100);
    const a2 = await connect(s.port, hex, { world: GAME, token: ana.token });
    a2.chat("after reconnect");
    await sleep(400);
    expect(b.chats.map((c) => c.text)).not.toContain("after reconnect");
    a2.close();
    b.close();
  });

  it("a late joiner gets the recent history marked as history, capped (in the sandbox: registered painters chat too)", async () => {
    const s = await boot();
    // The sandbox (world 0), not the game world: six in-process game sims are too slow for one test.
    const talkers = await Promise.all(["A1", "A2", "A3", "A4", "A5"].map((n) => register(s.port, n)));
    const conns: TestClient[] = [];
    for (const t of talkers) conns.push(await connect(s.port, hex, { world: 0, token: t.token }));
    // 5 talkers x 5 lines = 25 lines, all inside each talker's rate budget.
    for (let i = 0; i < 5; i++) for (const [k, c] of conns.entries()) c.chat(`m${k}-${i}`);
    await waitFor(() => conns[0].chats.length === 25, 3000, "all lines");
    const late = await connect(s.port, hex, { world: 0, token: (await register(s.port, "Late")).token });
    await waitFor(() => late.chats.length === CHAT_HISTORY_MAX, 3000, "history");
    expect(late.chats.every((c) => c.history)).toBe(true);
    expect(late.chats.map((c) => c.text)).toEqual(conns[0].chats.slice(-CHAT_HISTORY_MAX).map((c) => c.text));
    expect(late.chats[0].name).toBe("A1");
    for (const c of conns) c.close();
    late.close();
  });

  it("counts relayed lines in input.summary, never one log line per message", async () => {
    const s = await boot();
    const a = await connect(s.port, hex, { world: GAME, token: (await register(s.port, "Ana")).token });
    a.chat("one");
    a.chat("two");
    await waitFor(() => a.chats.length === 2, 3000, "echo");
    a.close();
    await waitFor(() => s.log.recent().some((e) => e.ev === "input.summary" && e.final === true), 3000, "final summary");
    const sum = s.log.recent().find((e) => e.ev === "input.summary" && e.final === true)!;
    expect(sum.chats).toBe(2);
  });
});

describe("chat frames", () => {
  it("C_CHAT and S_CHAT round trip with literal layouts", () => {
    expect(Array.from(encodeChat("hi"))).toEqual([C_CHAT, 0x68, 0x69]);
    expect(decodeClient(encodeChat("hé @Bo"))).toEqual({ t: "chat", text: "hé @Bo" });
    const f = encodeChatLine("Ana", "yo", true);
    expect(Array.from(f)).toEqual([S_CHAT, 1, 3, ...Buffer.from("Ana"), ...Buffer.from("yo")]);
    expect(decodeServer(f)).toEqual({ t: "chat", name: "Ana", text: "yo", history: true });
  });
  it("refuses empty or oversized text, and decodes hostile bytes to null", () => {
    expect(() => encodeChat("")).toThrow();
    expect(() => encodeChat("x".repeat(MAX_CHAT_BYTES + 1))).toThrow();
    expect(decodeClient(new Uint8Array([C_CHAT]))).toBeNull();
    expect(decodeClient(new Uint8Array([C_CHAT, 0xff, 0xfe]))).toBeNull(); // not UTF-8
    expect(decodeClient(new Uint8Array(2 + MAX_CHAT_BYTES).fill(0x41).fill(C_CHAT, 0, 1))).toBeNull();
    expect(decodeServer(new Uint8Array([S_CHAT, 0, 5, 0x41]))).toBeNull(); // name runs past the end
    expect(decodeServer(new Uint8Array([S_CHAT, 0, 1, 0x41]))).toBeNull(); // no text
  });
});

describe("mention matcher", () => {
  it("matches @name case-insensitively, on a word boundary, and only the viewer's name", () => {
    expect(mentions("hey @ana look", "Ana")).toBe(true);
    expect(mentions("hey @ANA!", "Ana")).toBe(true);
    expect(mentions("hey @Anabel", "Ana")).toBe(false);
    expect(mentions("hey Ana", "Ana")).toBe(false);
    expect(mentions("hey @Bo", "Ana")).toBe(false);
    expect(mentions("mail@ana", "Ana")).toBe(true); // an @ is an @: names are what players chose, not addresses
    expect(mentions("@Ana", "")).toBe(false);
  });
  it("handles names with spaces and non-ASCII letters", () => {
    expect(mentions("gg @big bo", "Big Bo")).toBe(true);
    expect(mentions("@Zoë!", "zoë")).toBe(true);
    expect(mentions("@Zoëy", "Zoë")).toBe(false);
  });
  it("segments rebuild the text and mark each mention", () => {
    const segs = chatSegments("@Ana and @ana, not @Anabel", "Ana");
    expect(segs.map((s) => s.text).join("")).toBe("@Ana and @ana, not @Anabel");
    expect(segs.filter((s) => s.mention).map((s) => s.text)).toEqual(["@Ana", "@ana"]);
  });
});

describe("rendering", () => {
  const doc = () => new JSDOM("<!doctype html><body></body>").window.document;
  it("markup in a message or a name renders as text, never as elements", () => {
    const d = doc();
    const el = renderChatLine(d, "<i>Eve</i>", "<img src=x onerror=alert(1)> <b>bold</b>", "Ana");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("i")).toBeNull();
    expect(el.querySelectorAll("b")).toHaveLength(0);
    expect(el.textContent).toBe("<i>Eve</i>: <img src=x onerror=alert(1)> <b>bold</b>");
  });
  it("a mention of the viewer is bold for that viewer only", () => {
    const d = doc();
    const forAna = renderChatLine(d, "Bo", "hi @ana <script>", "Ana");
    expect(Array.from(forAna.querySelectorAll("b")).map((b) => b.textContent)).toEqual(["@ana"]);
    expect(forAna.classList.contains("mention")).toBe(true);
    expect(forAna.textContent).toBe("Bo: hi @ana <script>");
    const forCy = renderChatLine(d, "Bo", "hi @ana <script>", "Cy");
    expect(forCy.querySelectorAll("b")).toHaveLength(0);
    expect(forCy.classList.contains("mention")).toBe(false);
  });
});
