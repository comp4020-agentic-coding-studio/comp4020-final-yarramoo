// Progressive enhancement for the progress-update form: downscale big photos in the browser
// before upload (long edge <= 1600px, JPEG q0.85) and show a preview strip. Without JS the
// form submits the originals and the server's limits apply.
(() => {
  const form = document.getElementById("update-form");
  if (!form || !window.DataTransfer || !HTMLCanvasElement.prototype.toBlob) return;
  const input = form.querySelector('input[type="file"][name="photos"]');
  const strip = document.getElementById("preview-strip");
  if (!input) return;
  const MAX_EDGE = 1600, MAX_BYTES = 1.5 * 1024 * 1024;

  const load = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });

  function preview() {
    if (!strip) return;
    for (const old of strip.querySelectorAll("img")) URL.revokeObjectURL(old.src);
    strip.replaceChildren();
    for (const f of input.files) {
      const im = document.createElement("img");
      im.src = URL.createObjectURL(f);
      im.alt = "";
      im.width = 64;
      im.height = 64;
      strip.append(im);
    }
  }
  input.addEventListener("change", preview);

  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    let loaded;
    try { loaded = await load(file); } catch { return file; }
    const { img, url } = loaded;
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (long <= MAX_EDGE && file.size <= MAX_BYTES) { URL.revokeObjectURL(url); return file; }
    const scale = Math.min(1, MAX_EDGE / long);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size && scale === 1) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  }

  let busy = false, done = false;
  form.addEventListener("submit", async (e) => {
    if (done || !input.files.length) return;
    e.preventDefault();
    if (busy) return;
    busy = true;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      const out = new DataTransfer();
      for (const f of input.files) out.items.add(await shrink(f));
      input.files = out.files;
    } catch { /* submit the originals */ }
    done = true;
    form.submit();
  });
})();
