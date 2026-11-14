// Bloomy — Blog posts: the reading-progress bar across the top of the page.
// How far down the article the reader is, from 0 (its top at the top of the window) to 1 (its end at the
// bottom of the window). The bar is moved with a transform, not a width, so it costs the page no layout.

export {};

// qol2_test calls this by name on the page's window, so it is put there on purpose.
declare global {
  interface Window {
    readingProgress: (rectTop: number, rectHeight: number, viewport: number) => number;
  }
}

// rectTop: the article's distance from the top of the window (negative once scrolled past);
// rectHeight: the article's height; viewport: the window's height.
function readingProgress(rectTop: number, rectHeight: number, viewport: number): number {
  const scrollable = Math.max(1, rectHeight - viewport);
  return Math.min(1, Math.max(0, -rectTop / scrollable));
}
window.readingProgress = readingProgress;

function initProgressBar(): void {
  const bar = document.getElementById("reading-progress-bar");
  const article = document.querySelector(".blog-article");
  if (!bar || !article) return;
  let queued = false;
  function update(): void {
    queued = false;
    if (!bar || !article) return;
    const rect = article.getBoundingClientRect();
    bar.style.transform = `scaleX(${readingProgress(rect.top, rect.height, window.innerHeight)})`;
  }
  function schedule(): void {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  }
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  update();
}
initProgressBar();
