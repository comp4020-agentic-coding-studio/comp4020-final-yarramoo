// Paste tracking (progressive enhancement). For every <textarea data-provenance> in a form, counts
// characters typed vs pasted/dropped and, on submit, writes `prov_typed` and `prov_pasted_prose`
// hidden inputs. "Prose" is text outside ``` fences: code and logs may be pasted freely.
// This is a soft, honest signal, not detection; the server treats it as a hint only.
(() => {
  const FENCE = /```[\s\S]*?(?:```|$)/g;
  const NOTE = "Is this your own writing? This site is for human-written text. Code and error logs are fine — put them in ``` fences.";
  const TYPED = new Set(["insertText", "insertLineBreak", "insertParagraph", "insertCompositionText", "insertReplacementText"]);
  const PASTED = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank"]);

  function hidden(form, name) {
    let i = form.querySelector(`input[type=hidden][name="${name}"]`);
    if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = name; form.appendChild(i); }
    return i;
  }

  document.querySelectorAll("textarea[data-provenance]").forEach((ta) => {
    const form = ta.form;
    if (!form) return;
    let typed = 0;
    const pasted = [];
    let note = null;

    ta.addEventListener("beforeinput", (e) => {
      if (TYPED.has(e.inputType)) {
        typed += e.data ? e.data.length : 1;
      } else if (PASTED.has(e.inputType)) {
        const s = e.data ?? (e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
        if (!s) return;
        pasted.push(s);
        if (s.replace(FENCE, "").length > 150 && !note) {
          note = document.createElement("p");
          note.className = "prov-note";
          note.setAttribute("role", "note");
          note.textContent = NOTE;
          ta.insertAdjacentElement("afterend", note);
        }
      }
    });

    form.addEventListener("submit", () => {
      let prose = ta.value.replace(/\r\n?/g, "\n").replace(FENCE, "");
      let total = 0;
      for (const p of pasted) {
        const part = p.replace(/\r\n?/g, "\n").replace(FENCE, "");
        if (!part) continue;
        const at = prose.indexOf(part);
        if (at < 0) continue;
        prose = prose.slice(0, at) + prose.slice(at + part.length);
        total += part.length;
      }
      hidden(form, "prov_typed").value = String(typed);
      hidden(form, "prov_pasted_prose").value = String(Math.min(total, ta.value.replace(/\r\n?/g, "\n").replace(FENCE, "").length));
    });
  });
})();
