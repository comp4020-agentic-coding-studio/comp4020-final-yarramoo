// Live-inserted inbox rows carry an empty _csrf (they are rendered for another session);
// fill it from the token on the #pending container.
(() => {
  const box = document.querySelector("#pending[data-csrf]");
  if (!box) return;
  const fill = () => box.querySelectorAll('input[name="_csrf"][value=""]').forEach((i) => { i.value = box.dataset.csrf; });
  new MutationObserver(fill).observe(box, { childList: true, subtree: true });
  fill();
})();
