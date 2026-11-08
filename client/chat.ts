// Track E chat: the mention matcher and the line renderer. Pure (the renderer takes a Document), render-only:
// nothing here reaches the sim (invariant 1), and a chat line is untrusted text, so it is only ever set with
// textContent, never innerHTML.

export interface ChatSegment {
  text: string;
  /** True for an `@name` that names the viewer: drawn bold on the viewer's screen only. */
  mention: boolean;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/**
 * Split `text` into plain runs and mentions of `myName`. A mention is `@` followed by the viewer's plain display
 * name, case-insensitive, and not followed by a letter, digit or underscore (so `@Ana` does not match `@Anabel`).
 * An empty `myName` (an anonymous viewer) matches nothing. Concatenating the segments' text gives back `text`.
 */
export function chatSegments(text: string, myName: string): ChatSegment[] {
  const name = myName.trim();
  if (!name) return text ? [{ text, mention: false }] : [];
  const want = name.toLowerCase();
  const out: ChatSegment[] = [];
  let plainFrom = 0;
  let i = text.indexOf("@");
  while (i !== -1) {
    const cand = text.slice(i + 1, i + 1 + name.length);
    const end = i + 1 + name.length;
    if (cand.length === name.length && cand.toLowerCase() === want && !isWordChar(text[end])) {
      if (i > plainFrom) out.push({ text: text.slice(plainFrom, i), mention: false });
      out.push({ text: text.slice(i, end), mention: true });
      plainFrom = end;
      i = text.indexOf("@", end);
    } else {
      i = text.indexOf("@", i + 1);
    }
  }
  if (plainFrom < text.length) out.push({ text: text.slice(plainFrom), mention: false });
  return out;
}

/** True when `text` mentions `myName` (see chatSegments). */
export const mentions = (text: string, myName: string): boolean => chatSegments(text, myName).some((s) => s.mention);

/**
 * One chat line as a DOM element: the sender's plain name, then the text, with a mention of the viewer in `<b>`.
 * Every piece goes in through textContent, so markup in a name or a message shows as the characters typed.
 */
export function renderChatLine(doc: Document, from: string, text: string, myName: string): HTMLElement {
  const el = doc.createElement("div");
  const who = doc.createElement("span");
  who.className = "who";
  who.textContent = from;
  el.append(who, doc.createTextNode(": "));
  let mentioned = false;
  for (const s of chatSegments(text, myName)) {
    if (s.mention) {
      const b = doc.createElement("b");
      b.textContent = s.text;
      el.append(b);
      mentioned = true;
    } else {
      el.append(doc.createTextNode(s.text));
    }
  }
  if (mentioned) el.classList.add("mention");
  return el;
}
