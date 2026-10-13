// Quiet behaviour signals (progressive enhancement, no UI at all). For every form containing
// <textarea data-provenance> or <input data-provenance>, tracks characters typed vs pasted,
// paste events, characters deleted while editing, and active writing time (field focused AND
// input/keyboard activity within the last 20 s, counted in 1 s ticks). On submit it writes
// hidden inputs prov_typed, prov_pasted_prose, prov_active_ms, prov_paste_events, prov_deletions.
// "Prose" is text outside ``` fences. The server treats all of this as a hint only.
(() => {
  const FENCE = /```[\s\S]*?(?:```|$)/g;
  const IDLE_MS = 20000;
  const TYPED = new Set(["insertText", "insertLineBreak", "insertParagraph", "insertCompositionText", "insertReplacementText"]);
  const PASTED = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank"]);
  const norm = (s) => s.replace(/\r\n?/g, "\n");

  function hidden(form, name) {
    let i = form.querySelector(`input[type=hidden][name="${name}"]`);
    if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = name; form.appendChild(i); }
    return i;
  }

  const forms = new Map();
  document.querySelectorAll("textarea[data-provenance], input[data-provenance]").forEach((el) => {
    if (el.form) {
      if (!forms.has(el.form)) forms.set(el.form, []);
      forms.get(el.form).push(el);
    }
  });

  forms.forEach((fields, form) => {
    let typed = 0, pasteEvents = 0, deletions = 0, activeMs = 0;
    let focused = 0, lastActivity = 0, timer = null;
    const state = new Map(fields.map((f) => [f, []])); // field -> pasted strings

    const touch = () => { lastActivity = Date.now(); };
    function start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (focused > 0 && Date.now() - lastActivity <= IDLE_MS) activeMs += 1000;
      }, 1000);
    }

    fields.forEach((el) => {
      el.addEventListener("focus", () => { focused++; start(); });
      el.addEventListener("blur", () => { focused = Math.max(0, focused - 1); });
      el.addEventListener("keydown", touch);
      el.addEventListener("beforeinput", (e) => {
        touch();
        if (TYPED.has(e.inputType)) {
          typed += e.data ? e.data.length : 1;
        } else if (PASTED.has(e.inputType)) {
          const s = e.data ?? (e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
          if (!s) return;
          state.get(el).push(s);
          pasteEvents++;
        } else if (e.inputType.startsWith("delete")) {
          const n = (el.selectionEnd ?? 0) - (el.selectionStart ?? 0);
          deletions += n > 0 ? n : 1;
        }
      });
    });

    form.addEventListener("submit", () => {
      let total = 0;
      state.forEach((pasted, el) => {
        const value = norm(el.value).replace(FENCE, "");
        let prose = value;
        let sum = 0;
        for (const p of pasted) {
          const part = norm(p).replace(FENCE, "");
          if (!part) continue;
          const at = prose.indexOf(part);
          if (at < 0) continue;
          prose = prose.slice(0, at) + prose.slice(at + part.length);
          sum += part.length;
        }
        total += Math.min(sum, value.length);
      });
      hidden(form, "prov_typed").value = String(typed);
      hidden(form, "prov_pasted_prose").value = String(total);
      hidden(form, "prov_active_ms").value = String(activeMs);
      hidden(form, "prov_paste_events").value = String(pasteEvents);
      hidden(form, "prov_deletions").value = String(deletions);
    });
  });
})();
