// Bloomy — Blog posts: the reading-progress bar across the top of the page.
// How far down the article the reader is, from 0 (its top at the top of the window) to 1 (its end at the
// bottom of the window). The bar is moved with a transform, not a width, so it costs the page no layout.

// rectTop: the article's distance from the top of the window (negative once scrolled past);
// rectHeight: the article's height; viewport: the window's height.
function readingProgress(rectTop, rectHeight, viewport) {
  const scrollable = Math.max(1, rectHeight - viewport);
  return Math.min(1, Math.max(0, -rectTop / scrollable));
}

(function () {
  const bar = document.getElementById("reading-progress-bar");
  const article = document.querySelector(".blog-article");
  if (!bar || !article) return;
  let queued = false;
  function update() {
    queued = false;
    const rect = article.getBoundingClientRect();
    bar.style.transform = `scaleX(${readingProgress(rect.top, rect.height, window.innerHeight)})`;
  }
  function schedule() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  }
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  update();
})();
