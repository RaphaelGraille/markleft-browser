"use strict";

const STORAGE_KEY = "mdviewer:state:v2";
const COLLAPSE_KEY_PREFIX = "mdviewer:collapsed:";

const ICON_FOLDER = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M1.5 3.5h4l1.2 1.5H14a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5v-8.5a.5.5 0 0 1 .5-.5z"/></svg>`;
const ICON_FOLDER_OPEN = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M1.5 4.3V3a.5.5 0 0 1 .5-.5h3.2l1.2 1.3H13a.5.5 0 0 1 .5.5v1"/><path d="M1.2 4.8h12.6a.5.5 0 0 1 .49.6l-1 6a.5.5 0 0 1-.49.4H2.2a.5.5 0 0 1-.49-.4l-1-6a.5.5 0 0 1 .49-.6z"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M4 1.5h5.3L12.5 4.7V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z"/><path d="M9.2 1.5V4.7h3.3"/><path d="M5.3 8h5.4M5.3 10.3h5.4M5.3 5.8h2.4"/></svg>`;
const ICON_PREVIEW = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4"/><line x1="9.5" y1="9.5" x2="13.5" y2="13.5"/></svg>`;
const ICON_PIN = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.6c-2 0-3.6 1.6-3.6 3.6 0 2.7 3.6 7.2 3.6 7.2s3.6-4.5 3.6-7.2c0-2-1.6-3.6-3.6-3.6z"/><circle cx="8" cy="5.2" r="1.3"/></svg>`;
const ICON_SWITCH_FOLDER = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M1.5 3.5h4l1.2 1.5H14a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5v-8.5a.5.5 0 0 1 .5-.5z"/><path d="M6 9.5h5m0 0-2-2m2 2-2 2" stroke-width="1.1"/></svg>`;
const ICON_NEW_WINDOW = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><rect x="1.5" y="2.5" width="13" height="10" rx="1.5"/><line x1="1.5" y1="5.2" x2="14.5" y2="5.2"/><line x1="8" y1="7.5" x2="8" y2="11" stroke-width="1.1"/><line x1="6.3" y1="9.3" x2="9.7" y2="9.3" stroke-width="1.1"/></svg>`;

/** Ordered list of open tabs: {path, title, rawText, error, permanent} */
let tabsOrder = [];
let previewPath = null;
let activeTab = null;
let treeData = null;
let draggingPath = null;

// ---------- persistence ----------
//
// Both keys are namespaced by the current root's absolute path, so switching
// roots never leaks one folder's open-tabs/collapse-state into an unrelated
// folder that happens to share a relative structure (e.g. two repos each
// with a top-level "docs/").

function rootNamespace() {
  return (treeData && treeData.rootAbsPath) || "";
}

function saveState() {
  localStorage.setItem(STORAGE_KEY + ":" + rootNamespace(), JSON.stringify({
    openTabs: tabsOrder.filter((t) => t.permanent).map((t) => t.path),
    activeTab: activeTab && findTab(activeTab)?.permanent ? activeTab : null,
  }));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + ":" + rootNamespace());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function isCollapsed(dirPath) {
  const v = localStorage.getItem(COLLAPSE_KEY_PREFIX + rootNamespace() + ":" + dirPath);
  return v === null ? true : v === "1"; // collapsed by default
}

function setCollapsed(dirPath, collapsed) {
  localStorage.setItem(COLLAPSE_KEY_PREFIX + rootNamespace() + ":" + dirPath, collapsed ? "1" : "0");
}

// ---------- path helpers ----------

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function basename(path) {
  return path.split("/").pop();
}

function resolveRelative(basePath, relHref) {
  const base = dirname(basePath).split("/").filter(Boolean);
  const parts = relHref.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

// ---------- markdown rendering ----------
//
// Parsing (marked) and syntax highlighting (hljs) run in a Web Worker, off
// the main thread -- a big file's parse cost must never block keyboard/mouse
// input. Only the finished HTML string crosses back; DOM work (innerHTML +
// link rewriting) happens here since workers have no DOM access.

const renderWorker = new Worker("/static/render-worker.js");
let renderRequestSeq = 0;
const pendingRenderResolvers = new Map();

renderWorker.onmessage = (e) => {
  const { requestId, html } = e.data;
  const resolve = pendingRenderResolvers.get(requestId);
  if (resolve) {
    pendingRenderResolvers.delete(requestId);
    resolve(html);
  }
};

function parseMarkdownAsync(rawText) {
  const requestId = ++renderRequestSeq;
  return new Promise((resolve) => {
    pendingRenderResolvers.set(requestId, resolve);
    renderWorker.postMessage({ requestId, rawText });
  });
}

async function renderMarkdownAsync(rawText, filePath) {
  const html = await parseMarkdownAsync(rawText);
  const container = document.createElement("div");
  container.className = "markdown-body";
  container.innerHTML = html;
  rewriteLinks(container, filePath);
  return container;
}

function rewriteLinks(container, filePath) {
  container.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (/^([a-z]+:)?\/\//i.test(href) || href.startsWith("mailto:")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      return;
    }
    if (href.startsWith("#")) return; // in-page anchor, leave native
    const [rawTarget, hash] = href.split("#");
    if (!rawTarget) return;
    const resolved = resolveRelative(filePath, decodeURIComponent(rawTarget));
    if (resolved.toLowerCase().endsWith(".md")) {
      a.href = "javascript:void(0)";
      a.addEventListener("click", () => openFile(resolved, { permanent: false }));
    } else {
      a.href = `/api/asset?path=${encodeURIComponent(resolved)}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  });
  container.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src");
    if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith("data:")) return;
    const resolved = resolveRelative(filePath, decodeURIComponent(src));
    img.src = `/api/asset?path=${encodeURIComponent(resolved)}`;
  });
}

// ---------- tabs / panes ----------

const tabbarEl = document.getElementById("tabbar");
const panesEl = document.getElementById("panes");

function paneId(path) {
  return "pane-" + btoa(unescape(encodeURIComponent(path))).replace(/[^a-zA-Z0-9]/g, "");
}

function findTab(path) {
  return tabsOrder.find((t) => t.path === path);
}

function removePaneDom(path) {
  const el = document.getElementById(paneId(path));
  if (el) el.remove();
}

// Invariant: the preview tab (if any) is always the LAST element of tabsOrder.
// New permanent tabs insert just before it; a new preview always appends at
// the end after removing whatever preview was there before.

async function openFile(path, { permanent = false, focus = true } = {}) {
  let tab = findTab(path);

  if (tab) {
    if (permanent && !tab.permanent) {
      tab.permanent = true;
      if (previewPath === path) previewPath = null;
      renderPane(path); // drop the "click to pin" stamp
    }
    if (focus) {
      if (path === activeTab) {
        await loadTabContent(path); // re-clicking the active file is a manual refresh
      } else {
        setActiveTab(path);
      }
    }
    renderTabbar();
    saveState();
    return;
  }

  if (permanent) {
    tab = { path, title: basename(path), rawText: null, error: null, permanent: true };
    const previewIdx = previewPath ? tabsOrder.findIndex((t) => t.path === previewPath) : -1;
    tabsOrder.splice(previewIdx === -1 ? tabsOrder.length : previewIdx, 0, tab);
  } else {
    if (previewPath) {
      const idx = tabsOrder.findIndex((t) => t.path === previewPath);
      if (idx !== -1) {
        removePaneDom(previewPath);
        tabsOrder.splice(idx, 1);
      }
    }
    tab = { path, title: basename(path), rawText: null, error: null, permanent: false };
    tabsOrder.push(tab); // anchored rightmost
    previewPath = path;
  }

  renderTabbar();
  await loadTabContent(path);
  if (focus) setActiveTab(path);
  saveState();
}

function pinTab(path) {
  let tab = findTab(path);
  if (!tab) {
    openFile(path, { permanent: true });
    return;
  }
  if (tab.permanent) return;
  tab.permanent = true;
  if (previewPath === path) previewPath = null;
  renderTabbar();
  renderPane(path);
  saveState();
}

async function loadTabContent(path) {
  const tab = findTab(path);
  if (!tab || tab._loading) return;
  tab._loading = true;
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    tab.rawText = await res.text();
    tab.error = null;
  } catch (err) {
    tab.error = String(err);
  } finally {
    tab._loading = false;
  }
  renderPane(path);
}

function closeTab(path) {
  const idx = tabsOrder.findIndex((t) => t.path === path);
  if (idx === -1) return;
  tabsOrder.splice(idx, 1);
  removePaneDom(path);
  if (previewPath === path) previewPath = null;
  if (activeTab === path) {
    const next = tabsOrder[idx] || tabsOrder[idx - 1];
    setActiveTab(next ? next.path : null);
  }
  renderTabbar();
  saveState();
}

function setActiveTab(path) {
  activeTab = path;
  renderTabbar();
  document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".tree-file").forEach((el) => el.classList.remove("active"));
  if (path) {
    const pane = document.getElementById(paneId(path));
    if (pane) pane.classList.add("active");
    const treeFileEl = document.querySelector(`.tree-file[data-path="${cssEscape(path)}"]`);
    if (treeFileEl) treeFileEl.classList.add("active");
  }
  renderEmptyStateIfNeeded();
  saveState();
}

function cssEscape(s) {
  return s.replace(/["\\]/g, "\\$&");
}

// ---------- drag-and-drop tab reordering ----------

function attachTabDnD(tabEl, path) {
  tabEl.draggable = true; // caller only attaches this to permanent tabs
  tabEl.addEventListener("dragstart", (e) => {
    draggingPath = path;
    tabEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", path);
  });
  tabEl.addEventListener("dragend", () => {
    draggingPath = null;
    document.querySelectorAll(".tab").forEach((el) =>
      el.classList.remove("dragging", "drag-over-left", "drag-over-right")
    );
  });
  tabEl.addEventListener("dragover", (e) => {
    if (!draggingPath || draggingPath === path) return;
    e.preventDefault();
    const rect = tabEl.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    tabEl.classList.toggle("drag-over-left", before);
    tabEl.classList.toggle("drag-over-right", !before);
  });
  tabEl.addEventListener("dragleave", () => {
    tabEl.classList.remove("drag-over-left", "drag-over-right");
  });
  tabEl.addEventListener("drop", (e) => {
    e.preventDefault();
    tabEl.classList.remove("drag-over-left", "drag-over-right");
    if (!draggingPath || draggingPath === path) return;
    const rect = tabEl.getBoundingClientRect();
    const before = e.clientX - rect.left < rect.width / 2;
    reorderTab(draggingPath, path, before);
    draggingPath = null;
  });
}

function reorderTab(sourcePath, targetPath, before) {
  const sourceIdx = tabsOrder.findIndex((t) => t.path === sourcePath);
  if (sourceIdx === -1) return;
  const [moved] = tabsOrder.splice(sourceIdx, 1);
  let targetIdx = tabsOrder.findIndex((t) => t.path === targetPath);
  if (targetIdx === -1) targetIdx = tabsOrder.length;
  tabsOrder.splice(before ? targetIdx : targetIdx + 1, 0, moved);
  renderTabbar();
  saveState();
}

// ---------- render: tabs / panes ----------

function renderTabbar() {
  tabbarEl.innerHTML = "";
  tabsOrder.forEach((tab) => {
    const el = document.createElement("div");
    el.className = "tab" + (tab.path === activeTab ? " active" : "") + (!tab.permanent ? " preview" : "");
    el.title = tab.path;
    el.addEventListener("click", () => setActiveTab(tab.path));
    el.addEventListener("dblclick", () => pinTab(tab.path));
    if (tab.permanent) attachTabDnD(el, tab.path); // preview tab is anchored: not draggable, not a drop target

    if (!tab.permanent) {
      const previewIcon = document.createElement("span");
      previewIcon.className = "tab-icon";
      previewIcon.innerHTML = ICON_PREVIEW;
      el.appendChild(previewIcon);
    }

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;
    el.appendChild(label);

    if (!tab.permanent) {
      const pinBtn = document.createElement("span");
      pinBtn.className = "tab-pin";
      pinBtn.innerHTML = ICON_PIN;
      pinBtn.title = "Pin this tab";
      pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pinTab(tab.path);
      });
      el.appendChild(pinBtn);
    }

    const closeBtn = document.createElement("span");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });
    el.appendChild(closeBtn);

    tabbarEl.appendChild(el);
  });
}

async function renderPane(path) {
  const tab = findTab(path);
  if (!tab) return;
  let pane = document.getElementById(paneId(path));
  if (!pane) {
    pane = document.createElement("div");
    pane.id = paneId(path);
    pane.className = "pane";
    panesEl.appendChild(pane);
  }
  pane.innerHTML = "";
  if (!tab.permanent) {
    const stamp = document.createElement("div");
    stamp.className = "preview-stamp";
    stamp.innerHTML = `${ICON_PREVIEW}<span>Preview &middot; click to pin</span>`;
    stamp.addEventListener("click", () => pinTab(path));
    pane.appendChild(stamp);
  }
  if (tab.error) {
    const err = document.createElement("div");
    err.className = "pane-error";
    err.textContent = `Failed to load ${path}: ${tab.error}`;
    pane.appendChild(err);
  } else if (tab.rawText !== null) {
    const container = await renderMarkdownAsync(tab.rawText, path);
    if (findTab(path) !== tab) return; // superseded while we were awaiting the worker
    pane.appendChild(container);
  }
  if (path === activeTab) pane.classList.add("active");
  renderEmptyStateIfNeeded();
}

function renderEmptyStateIfNeeded() {
  let empty = panesEl.querySelector(".empty-state");
  if (tabsOrder.length === 0) {
    const noRoot = !treeData || !treeData.rootAbsPath;
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "empty-state";
      panesEl.appendChild(empty);
    }
    empty.classList.toggle("empty-state-clickable", noRoot);
    if (noRoot) {
      empty.innerHTML = `<div class="empty-state-icon">${ICON_FOLDER_OPEN}</div>
        <div>No folder selected — click here to choose one.</div>
        <div class="empty-state-easter-egg">Made with Sonnet, Fu*k Opus</div>`;
      empty.onclick = () => pickRootFlow();
    } else {
      empty.innerHTML = "";
      empty.textContent = "Select a file from the left to open it.";
      empty.onclick = null;
    }
  } else if (empty) {
    empty.remove();
  }
}

// ---------- sidebar tree ----------

const treeEl = document.getElementById("tree");
const filterBox = document.getElementById("filter-box");

function buildTreeDOM(node, isFiltering, tempExpanded) {
  const frag = document.createDocumentFragment();
  node.children.forEach((child) => {
    if (child.type === "dir") {
      const wrapper = document.createElement("div");
      wrapper.className = "tree-dir";

      const label = document.createElement("div");
      label.className = "tree-label";
      label.dataset.path = child.path;
      label.dataset.type = "dir";
      label.tabIndex = -1;

      const collapsed = isFiltering ? !tempExpanded.has(child.path) : isCollapsed(child.path);

      const caret = document.createElement("span");
      caret.className = "tree-caret" + (collapsed ? " collapsed" : "");
      caret.textContent = "\u25b8";
      label.appendChild(caret);

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.innerHTML = collapsed ? ICON_FOLDER : ICON_FOLDER_OPEN;
      label.appendChild(icon);

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = child.name;
      label.appendChild(name);

      const childrenEl = document.createElement("div");
      childrenEl.className = "tree-children" + (collapsed ? " collapsed" : "");
      childrenEl.appendChild(buildTreeDOM(child, isFiltering, tempExpanded));

      label.addEventListener("click", () => {
        const nowCollapsed = !childrenEl.classList.contains("collapsed");
        childrenEl.classList.toggle("collapsed", nowCollapsed);
        caret.classList.toggle("collapsed", nowCollapsed);
        icon.innerHTML = nowCollapsed ? ICON_FOLDER : ICON_FOLDER_OPEN;
        if (!isFiltering) setCollapsed(child.path, nowCollapsed);
        else if (nowCollapsed) tempExpanded.delete(child.path);
        else tempExpanded.add(child.path);
        setCursorPointer(child.path, "dir");
      });

      wrapper.appendChild(label);
      wrapper.appendChild(childrenEl);
      frag.appendChild(wrapper);
    } else {
      const fileEl = document.createElement("div");
      fileEl.className = "tree-file";
      fileEl.dataset.path = child.path;
      fileEl.dataset.type = "file";
      fileEl.tabIndex = -1;
      fileEl.title = child.path;

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.innerHTML = ICON_FILE;
      fileEl.appendChild(icon);

      const name = document.createElement("span");
      name.className = "tree-name";
      name.textContent = child.name;
      fileEl.appendChild(name);

      fileEl.addEventListener("click", () => {
        setCursorPointer(child.path, "file");
        requestPreview(child.path);
      });
      fileEl.addEventListener("dblclick", () => pinTab(child.path));

      if (child.path === activeTab) fileEl.classList.add("active");
      frag.appendChild(fileEl);
    }
  });
  return frag;
}

function collectMatches(node, query, acc) {
  let anyMatch = false;
  node.children.forEach((child) => {
    if (child.type === "dir") {
      if (collectMatches(child, query, acc)) {
        acc.add(child.path);
        anyMatch = true;
      }
    } else if (child.name.toLowerCase().includes(query) || child.path.toLowerCase().includes(query)) {
      anyMatch = true;
    }
  });
  return anyMatch;
}

function filterTreeNode(node, query) {
  const filteredChildren = [];
  node.children.forEach((child) => {
    if (child.type === "dir") {
      const filteredChild = filterTreeNode(child, query);
      if (filteredChild.children.length > 0) filteredChildren.push(filteredChild);
    } else if (child.name.toLowerCase().includes(query) || child.path.toLowerCase().includes(query)) {
      filteredChildren.push(child);
    }
  });
  return { ...node, children: filteredChildren };
}

// forceExpanded: null = default (auto-expand every dir that contains a
// match); true/false = Expand All / Collapse All acting on the CURRENT
// (possibly filtered) view. Plain auto-expand and forceExpanded:true happen
// to look identical while filtering (filterTreeNode already prunes to only
// match-containing dirs, so "expand every dir shown" and "expand every
// match" are the same set) -- forceExpanded:false is the one that actually
// differs, and is what Collapse All needs to have any visible effect at all
// while a search is active (collapsed-state in localStorage is otherwise
// never consulted by the filtered render path).
function renderTree({ forceExpanded = null } = {}) {
  treeEl.innerHTML = "";
  if (!treeData.rootAbsPath) {
    const empty = document.createElement("div");
    empty.className = "tree-empty-state";
    empty.textContent = "No folder selected — click the button above to choose one.";
    treeEl.appendChild(empty);
    return;
  }
  const query = filterBox.value.trim().toLowerCase();
  if (query) {
    const filtered = filterTreeNode(treeData, query);
    const expandedDirs = new Set();
    if (forceExpanded !== false) collectMatches(treeData, query, expandedDirs);
    treeEl.appendChild(buildTreeDOM(filtered, true, expandedDirs));
  } else {
    treeEl.appendChild(buildTreeDOM(treeData, false, null));
  }
  restoreCursorAfterRebuild();
}

const filterWrapper = document.getElementById("filter-wrapper");
const filterClearBtn = document.getElementById("filter-clear-btn");

function updateFilterClearVisibility() {
  filterWrapper.classList.toggle("has-value", filterBox.value.length > 0);
}

filterBox.addEventListener("input", () => {
  updateFilterClearVisibility();
  renderTree();
});

filterClearBtn.addEventListener("click", () => {
  filterBox.value = "";
  updateFilterClearVisibility();
  renderTree();
  filterBox.focus();
});

// ---------- keyboard navigation ----------
//
// Up/Down move the cursor between visible rows and preview the file it lands
// on, without expanding folders. Left/Right collapse/expand a folder under
// the cursor (no-op on a file). Enter pins the file under the cursor. Roving
// tabindex: exactly one row is tabbable at a time (the cursor), so Tab into
// the sidebar lands on it and native scrollIntoView-on-focus keeps it visible.

let cursorPath = null;
let cursorType = null;
// The cursor ring is invisible until the user's first real interaction with
// the tree (click or arrow-key move). Boot places a starting cursor position
// silently -- for arrow-key math and Tab-key accessibility -- without ever
// showing it. Once revealed, it stays revealed for the rest of the session.
let cursorRevealed = false;

// Which area last received a mousedown/focus: "tree" | "filter" | "content".
// Arrow-key tree navigation only acts while this is "tree" -- routing this way
// (instead of relying on which element literally holds browser focus) means a
// click on a tab, a pin icon, or into the document body never silently breaks
// arrow-key navigation, since focus itself is fragile (any click on a
// non-focusable element blurs whatever had it) but this flag isn't.
let keyboardContext = "tree";

const PREVIEW_DEBOUNCE_MS = 50;
let previewDebounceTimer = null;

// Cursor movement (the highlight ring + scroll) is instant; the actual
// fetch+render is debounced so rapid skimming (arrow-key repeat, or fast
// clicking) never fetches/renders files you're only passing over -- only
// the one you settle on. User input must never wait on content loading.
function requestPreview(path) {
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    openFile(path, { permanent: false });
  }, PREVIEW_DEBOUNCE_MS);
}

function getNavigableRows() {
  return Array.from(treeEl.querySelectorAll(".tree-label, .tree-file")).filter((el) => el.offsetParent !== null);
}

function findRowByPath(path) {
  return getNavigableRows().find((el) => el.dataset.path === path) || null;
}

function setCursorPointer(path, type, { focus = true } = {}) {
  const prevRow = cursorPath ? findRowByPath(cursorPath) : null;
  if (prevRow) {
    prevRow.classList.remove("tree-cursor");
    prevRow.tabIndex = -1;
  }
  cursorPath = path;
  cursorType = type;
  if (focus) cursorRevealed = true; // boot's silent initial placement passes focus:false
  const row = findRowByPath(path);
  if (row) {
    row.tabIndex = 0;
    if (cursorRevealed) row.classList.add("tree-cursor");
    if (focus) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
    }
  }
}

function restoreCursorAfterRebuild() {
  if (!cursorPath) return;
  const row = findRowByPath(cursorPath);
  if (!row) return;
  if (cursorRevealed) row.classList.add("tree-cursor");
  row.tabIndex = 0;
  if (keyboardContext === "tree") row.focus({ preventScroll: true });
}

function moveCursorTo(path, type) {
  setCursorPointer(path, type);
  if (type === "file") requestPreview(path);
}

function getDirRowParts(dirPath) {
  const label = treeEl.querySelector(`.tree-label[data-path="${cssEscape(dirPath)}"]`);
  if (!label) return null;
  const childrenEl = label.parentElement.querySelector(":scope > .tree-children");
  const caret = label.querySelector(".tree-caret");
  const icon = label.querySelector(".tree-icon");
  return { childrenEl, caret, icon };
}

function setDirCollapsedByKeyboard(dirPath, collapsed) {
  const parts = getDirRowParts(dirPath);
  if (!parts) return;
  const { childrenEl, caret, icon } = parts;
  if (childrenEl.classList.contains("collapsed") === collapsed) return; // already there
  childrenEl.classList.toggle("collapsed", collapsed);
  caret.classList.toggle("collapsed", collapsed);
  icon.innerHTML = collapsed ? ICON_FOLDER : ICON_FOLDER_OPEN;
  if (!filterBox.value.trim()) setCollapsed(dirPath, collapsed);
}

document.getElementById("sidebar").addEventListener("mousedown", () => {
  keyboardContext = "tree";
});
filterBox.addEventListener("focus", () => {
  keyboardContext = "filter";
});
document.getElementById("content").addEventListener("mousedown", () => {
  keyboardContext = "content";
});

document.addEventListener("keydown", (e) => {
  if (keyboardContext !== "tree") return;
  // Modified arrow keys (Cmd+Left/Right for tab switching, etc.) are a
  // different command entirely -- plain arrows only here, or Cmd+Right on a
  // collapsed folder would also incorrectly expand it, fighting the
  // desktop shortcut handler below.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
  const rows = getNavigableRows();
  if (rows.length === 0) return;
  e.preventDefault();
  const idx = rows.findIndex((el) => el.dataset.path === cursorPath);

  if (e.key === "ArrowDown") {
    const nextIdx = idx === -1 ? 0 : Math.min(idx + 1, rows.length - 1);
    const row = rows[nextIdx];
    moveCursorTo(row.dataset.path, row.dataset.type);
  } else if (e.key === "ArrowUp") {
    const prevIdx = idx === -1 ? rows.length - 1 : Math.max(idx - 1, 0);
    const row = rows[prevIdx];
    moveCursorTo(row.dataset.path, row.dataset.type);
  } else if (e.key === "ArrowRight") {
    if (cursorType === "dir") setDirCollapsedByKeyboard(cursorPath, false);
  } else if (e.key === "ArrowLeft") {
    if (cursorType === "dir") setDirCollapsedByKeyboard(cursorPath, true);
  } else if (e.key === "Enter") {
    if (cursorType === "file") pinTab(cursorPath);
  }
});

function countFiles(node) {
  let count = 0;
  node.children.forEach((child) => {
    count += child.type === "file" ? 1 : countFiles(child);
  });
  return count;
}

function setAllCollapsed(node, collapsed) {
  node.children.forEach((child) => {
    if (child.type === "dir") {
      setCollapsed(child.path, collapsed);
      setAllCollapsed(child, collapsed);
    }
  });
}

document.getElementById("expand-all-btn").addEventListener("click", () => {
  setAllCollapsed(treeData, false);
  renderTree({ forceExpanded: true });
});

document.getElementById("collapse-all-btn").addEventListener("click", () => {
  setAllCollapsed(treeData, true);
  renderTree({ forceExpanded: false });
});

// ---------- generic modal ----------

const modalOverlay = document.getElementById("modal-overlay");
const modalTitleEl = document.getElementById("modal-title");
const modalBodyEl = document.getElementById("modal-body");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const modalConfirmBtn = document.getElementById("modal-confirm-btn");

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Shows a modal; resolves true on Proceed/Enter, false on Cancel/overlay-click/Escape. */
function showModal({ title, bodyHtml, confirmLabel = "Proceed", cancelLabel = "Cancel", onRender }) {
  return new Promise((resolve) => {
    modalTitleEl.textContent = title;
    modalBodyEl.innerHTML = bodyHtml;
    modalConfirmBtn.textContent = confirmLabel;
    modalCancelBtn.textContent = cancelLabel;
    modalOverlay.classList.remove("hidden");
    if (onRender) onRender(modalBodyEl);

    function cleanup(result) {
      modalOverlay.classList.add("hidden");
      modalConfirmBtn.removeEventListener("click", onConfirm);
      modalCancelBtn.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlayClick(e) { if (e.target === modalOverlay) cleanup(false); }
    function onKeydown(e) { if (e.key === "Escape") cleanup(false); }

    modalConfirmBtn.addEventListener("click", onConfirm);
    modalCancelBtn.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
  });
}

// ---------- root switching ----------
//
// Manual path entry is the reliable baseline on every OS -- it's the one
// mechanism that has never failed across everything tried. On macOS only,
// clicking the button first tries a native folder dialog (via osascript,
// isolated in its own subprocess with a hard server-side timeout, since an
// earlier tkinter-based attempt hung and wedged the whole server -- that
// must never be able to happen again regardless of what the dialog does).
// The server reports {supported:false} immediately on non-macOS, and ANY
// failure of the native attempt (not just "unsupported") falls through to
// the manual flow -- a real folder switch is always still one path-paste
// away even if the native picker breaks again.

const RECENT_ROOTS_KEY = "mdviewer:recentRoots";
const MAX_RECENT_ROOTS = 8;

function getRecentRoots() {
  try {
    const raw = localStorage.getItem(RECENT_ROOTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function addRecentRoot(path) {
  const existing = getRecentRoots().filter((r) => r !== path);
  existing.unshift(path);
  localStorage.setItem(RECENT_ROOTS_KEY, JSON.stringify(existing.slice(0, MAX_RECENT_ROOTS)));
}

const rootPickerBtn = document.getElementById("root-picker-btn");
document.getElementById("root-picker-icon").innerHTML = ICON_SWITCH_FOLDER;

// ---------- new window ----------
//
// Each window is a fully independent backend process on its own port --
// simpler and more robust than one process serving multiple sessions, since
// there's no shared root/tab state that could ever leak between windows.
// The server picks a free port and re-launches itself; that entry point's
// own existing startup behavior (server.py opens a browser tab, desktop.py
// opens a native window) makes the new window appear, so there's nothing
// else to do here beyond triggering it and reporting failure if it happens.

const newWindowBtn = document.getElementById("new-window-btn");
document.getElementById("new-window-icon").innerHTML = ICON_NEW_WINDOW;

async function openNewWindow() {
  newWindowBtn.disabled = true;
  try {
    const res = await fetch("/api/new-window", { method: "POST" });
    if (!res.ok) alert(`Couldn't open a new window: ${await res.text()}`);
  } catch {
    alert("Couldn't open a new window.");
  } finally {
    newWindowBtn.disabled = false;
  }
}

newWindowBtn.addEventListener("click", () => openNewWindow());

function setRootPickerBusy(busy, label) {
  rootPickerBtn.disabled = busy;
  document.getElementById("repo-name").textContent = busy ? label : treeData.name;
}

rootPickerBtn.addEventListener("click", () => pickRootFlow());

async function pickRootFlow() {
  const openPaths = tabsOrder.map((t) => t.path);

  setRootPickerBusy(true, "Waiting for folder selection…");
  let native = null;
  try {
    const res = await fetch("/api/pick-root-native", { method: "POST" });
    if (res.ok) native = await res.json();
  } catch {
    native = null;
  } finally {
    setRootPickerBusy(false);
  }

  if (native && native.supported) {
    if (native.cancelled) return; // deliberate cancel -- do nothing, don't fall back
    if (native.root) {
      await previewAndCommitRootSwitch(native.root, openPaths);
      return;
    }
    // supported:true but no root and not cancelled means a real failure --
    // fall through to manual entry below.
  }

  await manualRootFlow(openPaths);
}

async function manualRootFlow(openPaths) {
  const recents = getRecentRoots().filter((r) => r !== treeData.rootAbsPath);
  const recentHtml = recents.length
    ? `<p style="margin-top:14px;">Recent folders:</p>
       <ul id="recent-roots-list">${recents
         .map((r) => `<li data-path="${escapeHtml(r)}">${escapeHtml(r)}</li>`)
         .join("")}</ul>`
    : "";

  const proceed = await showModal({
    title: "Switch root folder",
    bodyHtml: `<p>Enter the absolute path to the folder you want to browse:</p>
      <input id="manual-root-input" type="text" placeholder="/Users/you/some/folder" autocomplete="off">
      ${recentHtml}`,
    confirmLabel: "Use this path",
    onRender: (body) => {
      const input = body.querySelector("#manual-root-input");
      input.focus();
      body.querySelectorAll("#recent-roots-list li").forEach((li) => {
        li.addEventListener("click", () => {
          input.value = li.dataset.path;
          input.focus();
        });
      });
    },
  });
  const typedPath = document.getElementById("manual-root-input")?.value.trim();
  if (!proceed || !typedPath) return;

  await previewAndCommitRootSwitch(typedPath, openPaths);
}

async function previewAndCommitRootSwitch(newRootPath, openPaths) {
  setRootPickerBusy(true, "Loading…");
  let data = null;
  try {
    const res = await fetch("/api/pick-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newRoot: newRootPath, openPaths }),
    });
    if (!res.ok) {
      alert(`Couldn't use that path: ${await res.text()}`);
      return;
    }
    data = await res.json();
  } finally {
    setRootPickerBusy(false);
  }
  await confirmAndCommitRootSwitch(data);
}

async function confirmAndCommitRootSwitch(data) {
  const { root, survivingRemap, willClose } = data;

  if (willClose.length > 0) {
    const listHtml = willClose.map((p) => `<li title="${escapeHtml(p)}">${escapeHtml(p)}</li>`).join("");
    const proceed = await showModal({
      title: "Switch root folder?",
      bodyHtml: `
        <p>Switching to <strong>${escapeHtml(root)}</strong>.</p>
        <p>${willClose.length} open file${willClose.length === 1 ? "" : "s"} will be closed because
        they're outside the new folder:</p>
        <ul>${listHtml}</ul>`,
    });
    if (!proceed) return;
  }

  const res = await fetch("/api/set-root", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root }),
  });
  if (!res.ok) {
    alert("Failed to switch root folder.");
    return;
  }

  await applyRootSwitch(survivingRemap, willClose);
}

async function applyRootSwitch(survivingRemap, willClose) {
  // Clear the filter FIRST -- a leftover query from the old root would
  // otherwise render the new tree already filtered (loadTreeAndHeader
  // below renders using whatever's currently in the box), and clearing the
  // input's value afterward wouldn't retroactively fix that render.
  filterBox.value = "";
  updateFilterClearVisibility();

  // Reload treeData/header -- saveState()/setCollapsed() below key off
  // treeData.rootAbsPath, so they must already point at the NEW root before
  // any of them run, or they'd write into the OLD root's storage slot.
  await loadTreeAndHeader();

  willClose.forEach((p) => closeTab(p));

  Object.entries(survivingRemap).forEach(([oldPath, newPath]) => {
    if (oldPath === newPath) return;
    const tab = findTab(oldPath);
    if (!tab) return;
    const pane = document.getElementById(paneId(oldPath));
    tab.path = newPath;
    tab.title = basename(newPath);
    if (pane) pane.id = paneId(newPath);
    if (previewPath === oldPath) previewPath = newPath;
    if (activeTab === oldPath) activeTab = newPath;
    if (cursorPath === oldPath) cursorPath = newPath;
  });

  renderTabbar();
  renderEmptyStateIfNeeded();
  saveState();
}

// ---------- sidebar resizer + collapse ----------

const SIDEBAR_WIDTH_KEY = "mdviewer:sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "mdviewer:sidebarCollapsed";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_ANIMATION_MS = 200;
const sidebarEl = document.getElementById("sidebar");
const sidebarResizer = document.getElementById("sidebar-resizer");
const sidebarCollapseBtn = document.getElementById("sidebar-collapse-btn");
const sidebarCollapseIcon = document.getElementById("sidebar-collapse-icon");

const ICON_CHEVRON = `<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>`;
sidebarCollapseIcon.innerHTML = ICON_CHEVRON;

let sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";

function applySidebarWidth(px) {
  const maxWidth = window.innerWidth * 0.6;
  const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(px, maxWidth));
  document.documentElement.style.setProperty("--sidebar-w", `${clamped}px`);
}

const savedSidebarWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
if (savedSidebarWidth) applySidebarWidth(parseFloat(savedSidebarWidth));

function setSidebarCollapsed(collapsed, { animate = true } = {}) {
  sidebarCollapsed = collapsed;
  if (animate) {
    sidebarEl.classList.add("animating");
    setTimeout(() => sidebarEl.classList.remove("animating"), SIDEBAR_ANIMATION_MS + 20);
  }
  sidebarEl.classList.toggle("collapsed", collapsed);
  sidebarCollapseIcon.classList.toggle("flipped", collapsed);
  sidebarCollapseBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}

// Apply persisted collapse state on boot, without animating the initial paint.
if (sidebarCollapsed) setSidebarCollapsed(true, { animate: false });

sidebarCollapseBtn.addEventListener("click", (e) => {
  e.stopPropagation(); // don't also start a resize-drag on the resizer beneath it
  setSidebarCollapsed(!sidebarCollapsed);
});

sidebarResizer.addEventListener("mousedown", (e) => {
  if (sidebarCollapsed || e.target === sidebarCollapseBtn || sidebarCollapseBtn.contains(e.target)) return;
  e.preventDefault();
  sidebarResizer.classList.add("resizing");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function onMouseMove(ev) {
    applySidebarWidth(ev.clientX);
  }
  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    sidebarResizer.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const finalWidth = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w");
    localStorage.setItem(SIDEBAR_WIDTH_KEY, parseFloat(finalWidth));
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
});

// ---------- desktop-only keyboard shortcuts ----------
//
// Cmd+N/W/B/Left/Right only, gated on treeData.isDesktop (set once the
// first /api/tree response arrives). Deliberately never bound in a plain
// browser tab: Cmd+W especially is reserved by every real browser (closing
// the current tab) and isn't something a page can safely or reliably
// intercept there -- trying would either silently fail or fight the
// browser's own handling. Inside the desktop app's own window there's no
// browser chrome to conflict with, so these are safe to own outright.

function activateAdjacentTab(direction) {
  if (tabsOrder.length === 0) return;
  const idx = tabsOrder.findIndex((t) => t.path === activeTab);
  const nextIdx = idx === -1 ? 0 : (idx + direction + tabsOrder.length) % tabsOrder.length;
  setActiveTab(tabsOrder[nextIdx].path);
}

document.addEventListener("keydown", (e) => {
  if (!treeData || !treeData.isDesktop || !e.metaKey) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    activateAdjacentTab(-1);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    activateAdjacentTab(1);
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "n") {
    e.preventDefault();
    openNewWindow();
  } else if (key === "w") {
    e.preventDefault();
    if (activeTab) closeTab(activeTab);
  } else if (key === "b") {
    e.preventDefault();
    setSidebarCollapsed(!sidebarCollapsed);
  }
});

// ---------- boot ----------

async function loadTreeAndHeader() {
  const res = await fetch("/api/tree");
  treeData = await res.json();

  if (treeData.rootAbsPath) {
    addRecentRoot(treeData.rootAbsPath);
    document.getElementById("repo-name").textContent = treeData.name;
    document.getElementById("repo-name").title = treeData.rootAbsPath;
    const fileCount = countFiles(treeData);
    document.getElementById("file-count").textContent = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  } else {
    document.getElementById("repo-name").textContent = "No folder selected";
    document.getElementById("repo-name").title = "";
    document.getElementById("file-count").textContent = "";
  }

  renderTree();
}

async function boot() {
  await loadTreeAndHeader();
  const firstRow = getNavigableRows()[0];
  if (firstRow) setCursorPointer(firstRow.dataset.path, firstRow.dataset.type, { focus: false });

  const saved = loadState();
  if (saved && saved.openTabs && saved.openTabs.length) {
    for (const path of saved.openTabs) {
      await openFile(path, { permanent: true, focus: false });
    }
    const target = saved.activeTab && findTab(saved.activeTab) ? saved.activeTab : saved.openTabs[0];
    setActiveTab(target);
  } else {
    renderEmptyStateIfNeeded();
  }
}

boot();
