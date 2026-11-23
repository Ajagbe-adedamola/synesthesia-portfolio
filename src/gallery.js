/**
 * Gallery for album artwork.
 *
 * Each loaded track can be rendered to a static image (a "frame" of the
 * generative artwork at a chosen moment) and added to a grid so an album
 * becomes a sequence of related pieces.
 */

const Gallery = (() => {
  /** @type {HTMLDivElement | null} */
  let root = null;

  /** Track entries currently in the gallery. */
  const items = [];

  /** Callbacks. */
  /** @type {(title: string, sub: string) => void | null} */
  let onReady = null;

  function setRoot(el) {
    root = el;
  }

  function setCallbacks({ onReady: or } = {}) {
    if (or) onReady = or;
  }

  function clear() {
    items.length = 0;
    if (root) root.innerHTML = "";
  }

  /**
   * Add a rendered thumbnail for a track.
   * `imageData` is a data URL (PNG) of the artwork at a chosen moment.
   */
  function add(imageData, meta) {
    if (!root) return;
    const id = meta.file.name + "|" + meta.file.lastModified + "|" + (items.length + 1);

    const card = document.createElement("div");
    card.className = "gallery-card";

    const img = document.createElement("img");
    img.src = imageData;
    img.alt = meta.title;
    img.loading = "lazy";

    const body = document.createElement("div");
    body.className = "gallery-card-body";

    const title = document.createElement("div");
    title.className = "gallery-card-title";
    title.textContent = meta.title;

    const sub = document.createElement("div");
    sub.className = "gallery-card-sub";
    sub.textContent = meta.sub;

    const actions = document.createElement("div");
    actions.className = "gallery-card-actions";

    const download = document.createElement("button");
    download.className = "btn";
    download.type = "button";
    download.textContent = "Save";
    download.addEventListener("click", (e) => {
      e.stopPropagation();
      const a = document.createElement("a");
      a.download = sanitizeFilename(meta.title) + ".png";
      a.href = imageData;
      a.click();
    });

    const play = document.createElement("button");
    play.className = "btn btn-primary";
    play.type = "button";
    play.textContent = "Play";
    play.addEventListener("click", (e) => {
      e.stopPropagation();
      if (onReady) onReady(meta.title, meta.sub);
    });

    actions.append(download, play);
    body.append(title, sub, actions);
    card.append(img, body);

    card.addEventListener("click", () => {
      if (onReady) onReady(meta.title, meta.sub);
    });

    root.appendChild(card);

    items.push({ id, meta, imageData, el: card });
  }

  function sanitizeFilename(name) {
    return name
      .replace(/[/\\?%*:|"<>]/g, "_")
      .slice(0, 120);
  }

  function selectByTitle(title) {
    const found = items.find((it) => it.meta.title === title);
    if (found && onReady) onReady(found.meta.title, found.meta.sub);
    return !!found;
  }

  return {
    setRoot,
    setCallbacks,
    clear,
    add,
    selectByTitle,
    get count() { return items.length; },
    get items() { return items; },
  };
})();

export default Gallery;
