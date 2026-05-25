const DEFAULTS = {
  ollamaUrl: "http://localhost:11434",
  modelName: "qwen3:8b",
  maxChars: 20000,
  mode: "ask", // "ask" | "factcheck"
};

const els = {
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  scrollToBottom: document.getElementById("scrollToBottom"),
  status: document.getElementById("status"),
  settings: document.getElementById("settings"),
  settingsToggle: document.getElementById("settingsToggle"),
  ollamaUrl: document.getElementById("ollamaUrl"),
  modelName: document.getElementById("modelName"),
  maxChars: document.getElementById("maxChars"),
  saveSettings: document.getElementById("saveSettings"),
  clearChat: document.getElementById("clearChat"),
  modeTabs: document.querySelectorAll(".mode-tab"),
};

let settings = { ...DEFAULTS };
let pageContext = null;
let history = [];
let busy = false;
let activeTabKey = null;
let activeStreamEl = null;
let activeStreamMeta = null; // { kind, sources } for the in-flight assistant bubble
let mode = "ask";

// Smart-scroll
let stickToBottom = true;
const BOTTOM_THRESHOLD = 24;

chrome.runtime.onMessage.addListener(handleBackgroundMessage);
init();

// ===========================================================================
// Background message handler
// ===========================================================================

function handleBackgroundMessage(msg) {
  if (!activeTabKey || msg.tabKey !== activeTabKey) return;

  if (msg.type === "FACTCHECK_STATUS") {
    setStatus(msg.text);
  } else if (msg.type === "FACTCHECK_SOURCES") {
    if (activeStreamMeta) activeStreamMeta.sources = msg.sources;
    renderActiveStream();
  } else if (msg.type === "TOKEN") {
    if (activeStreamEl) {
      activeStreamMeta.text = (activeStreamMeta.text || "") + msg.chunk;
      renderActiveStream();
      maybeAutoScroll();
    }
  } else if (msg.type === "DONE") {
    finalizeStream("ok", "Done.");
  } else if (msg.type === "STOPPED") {
    finalizeStream("ok", "Stopped.");
  } else if (msg.type === "ERROR") {
    if (activeStreamEl) {
      activeStreamMeta.text =
        (activeStreamMeta.text || "") + `\n⚠ ${msg.error}`;
      renderActiveStream();
    }
    finalizeStream("error", msg.error);
  }
}

function finalizeStream(kind, statusText) {
  if (activeStreamEl) {
    activeStreamEl.classList.remove("streaming");
    renderActiveStream(); // final render with full text + sources
  }
  activeStreamEl = null;
  activeStreamMeta = null;
  setBusy(false);
  // Sync history from storage
  chrome.storage.local.get(activeTabKey).then((stored) => {
    history = stored[activeTabKey] || [];
  });
  setStatus(statusText, kind);
}

// ===========================================================================
// Initialisation
// ===========================================================================

async function init() {
  settings = await loadSettings();
  els.ollamaUrl.value = settings.ollamaUrl;
  els.modelName.value = settings.modelName;
  els.maxChars.value = settings.maxChars;
  mode = settings.mode || "ask";
  updateModeUI();

  const tab = await getActiveTab();
  activeTabKey = `chat:${tab?.id ?? "unknown"}`;
  const pendingKey = `pending:${activeTabKey}`;

  const stored = await chrome.storage.local.get([activeTabKey, pendingKey]);
  history = stored[activeTabKey] || [];
  renderHistory();

  // Resume in-progress stream visual
  const pending = stored[pendingKey];
  if (pending && !pending.done) {
    activeStreamMeta = {
      kind: pending.mode === "factcheck" ? "factcheck" : "chat",
      text: pending.text || "",
      sources: [],
    };
    activeStreamEl = pushAssistantBubble();
    activeStreamEl.classList.add("streaming");
    renderActiveStream();
    setBusy(true);
    setStatus("Response in progress…");
  } else if (pending?.error) {
    setStatus(`Last request failed: ${pending.error}`, "error");
  }

  try {
    pageContext = await extractPageContext(tab);
    if (!busy) {
      setStatus(
        `Loaded "${truncate(pageContext.title, 50)}" (${pageContext.text.length.toLocaleString()} chars)`,
        "ok"
      );
    }
  } catch (err) {
    if (!busy) setStatus(`Could not read page: ${err.message}`, "error");
  }

  els.send.addEventListener("click", onSend);
  els.stop.addEventListener("click", onStop);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.settingsToggle.addEventListener("click", () =>
    els.settings.classList.toggle("hidden")
  );
  els.saveSettings.addEventListener("click", onSaveSettings);
  els.clearChat.addEventListener("click", onClearChat);

  els.modeTabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  els.messages.addEventListener("scroll", onMessagesScroll);
  els.scrollToBottom.addEventListener("click", () => {
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
    stickToBottom = true;
    els.scrollToBottom.classList.add("hidden");
  });

  els.messages.scrollTop = els.messages.scrollHeight;
  stickToBottom = true;
}

// ===========================================================================
// Mode switching
// ===========================================================================

async function setMode(newMode) {
  if (newMode !== "ask" && newMode !== "factcheck") return;
  mode = newMode;
  await chrome.storage.local.set({ mode });
  updateModeUI();
}

function updateModeUI() {
  els.modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
  els.input.placeholder =
    mode === "factcheck"
      ? "Paste a claim to verify against web sources…"
      : "Ask anything about this page…";
}

// ===========================================================================
// Smart scrolling
// ===========================================================================

function onMessagesScroll() {
  const m = els.messages;
  const atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < BOTTOM_THRESHOLD;
  stickToBottom = atBottom;
  els.scrollToBottom.classList.toggle("hidden", atBottom);
}

function maybeAutoScroll() {
  if (stickToBottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
  } else {
    els.scrollToBottom.classList.remove("hidden");
  }
}

// ===========================================================================
// Settings
// ===========================================================================

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function onSaveSettings() {
  settings = {
    ...settings,
    ollamaUrl:
      els.ollamaUrl.value.trim().replace(/\/$/, "") || DEFAULTS.ollamaUrl,
    modelName: els.modelName.value.trim() || DEFAULTS.modelName,
    maxChars:
      Math.max(1000, parseInt(els.maxChars.value, 10)) || DEFAULTS.maxChars,
  };
  await chrome.storage.local.set(settings);
  setStatus("Settings saved.", "ok");
  els.settings.classList.add("hidden");
}

async function onClearChat() {
  if (busy) {
    chrome.runtime
      .sendMessage({ type: "STOP_CHAT", tabKey: activeTabKey })
      .catch(() => {});
  }
  history = [];
  activeStreamEl = null;
  activeStreamMeta = null;
  setBusy(false);
  await chrome.storage.local.remove([
    activeTabKey,
    `pending:${activeTabKey}`,
  ]);
  renderHistory();
  setStatus("Chat cleared.", "ok");
}

// ===========================================================================
// Page extraction
// ===========================================================================

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractPageContext(tab) {
  if (!tab?.id) throw new Error("No active tab.");
  if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || "")) {
    throw new Error("Cannot read browser internal pages.");
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const clone = document.body.cloneNode(true);
      clone
        .querySelectorAll("script, style, noscript, iframe, svg")
        .forEach((el) => el.remove());
      const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
      return { title: document.title, url: location.href, text };
    },
  });
  const ctx = result?.result;
  if (!ctx) throw new Error("Script injection returned nothing.");
  ctx.text = ctx.text.slice(0, settings.maxChars);
  return ctx;
}

// ===========================================================================
// Sending / stopping
// ===========================================================================

async function onSend() {
  if (busy) return;
  const text = els.input.value.trim();
  if (!text) return;

  els.input.value = "";
  pushMessage("user", text);

  stickToBottom = true;
  els.scrollToBottom.classList.add("hidden");
  els.messages.scrollTop = els.messages.scrollHeight;

  // Persist user message
  const userEntry =
    mode === "factcheck"
      ? { role: "user", content: text, meta: { kind: "factcheck-claim" } }
      : { role: "user", content: text };
  history.push(userEntry);
  await chrome.storage.local.set({ [activeTabKey]: history });

  setBusy(true);

  // Set up the streaming bubble
  activeStreamMeta = {
    kind: mode === "factcheck" ? "factcheck" : "chat",
    text: "",
    sources: [],
  };
  activeStreamEl = pushAssistantBubble();
  activeStreamEl.classList.add("streaming");
  renderActiveStream();

  // Dispatch by mode
  if (mode === "factcheck") {
    setStatus("Searching the web…");
    chrome.runtime
      .sendMessage({
        type: "START_CHAT",
        mode: "factcheck",
        tabKey: activeTabKey,
        claim: text,
        pageContext,
        ollamaUrl: settings.ollamaUrl,
        modelName: settings.modelName,
      })
      .catch((err) => bgError(err));
  } else {
    setStatus("Thinking…");
    // Build chat messages — include prior history minus the just-added user msg
    const priorHistory = history.slice(0, -1).filter((m) => m.role !== "user" || !m.meta);
    const messages = buildAskMessages(text, priorHistory);
    chrome.runtime
      .sendMessage({
        type: "START_CHAT",
        mode: "ask",
        tabKey: activeTabKey,
        messages,
        ollamaUrl: settings.ollamaUrl,
        modelName: settings.modelName,
      })
      .catch((err) => bgError(err));
  }
}

function bgError(err) {
  if (activeStreamEl) {
    activeStreamMeta.text = `⚠ Could not reach background: ${err.message}`;
    activeStreamEl.classList.remove("streaming");
    renderActiveStream();
  }
  activeStreamEl = null;
  activeStreamMeta = null;
  setBusy(false);
  setStatus(err.message, "error");
}

function onStop() {
  if (!busy) return;
  setStatus("Stopping…");
  chrome.runtime
    .sendMessage({ type: "STOP_CHAT", tabKey: activeTabKey })
    .catch(() => {});
}

function setBusy(value) {
  busy = value;
  els.send.classList.toggle("hidden", value);
  els.stop.classList.toggle("hidden", !value);
}

function buildAskMessages(question, priorHistory) {
  const system = `You are a helpful assistant answering questions about a webpage the user is viewing.
Use ONLY the page content below as your source of truth. If the answer is not present, say so.
Be concise.

PAGE TITLE: ${pageContext?.title ?? "(unknown)"}
PAGE URL: ${pageContext?.url ?? "(unknown)"}
---
${pageContext?.text ?? "(no page content available)"}
---`;
  // Only include non-factcheck history turns for chat context
  const turns = priorHistory.filter((m) => !m.meta || m.meta.kind === undefined);
  return [
    { role: "system", content: system },
    ...turns.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];
}

// ===========================================================================
// Message rendering
// ===========================================================================

function pushMessage(role, text, meta) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (meta?.kind === "factcheck") {
    renderFactCheckInto(div, text, meta.sources || []);
  } else {
    div.textContent = text;
  }
  els.messages.appendChild(div);
  maybeAutoScroll();
  return div;
}

function pushAssistantBubble() {
  const div = document.createElement("div");
  div.className = "msg assistant";
  els.messages.appendChild(div);
  maybeAutoScroll();
  return div;
}

function renderActiveStream() {
  if (!activeStreamEl || !activeStreamMeta) return;
  if (activeStreamMeta.kind === "factcheck") {
    renderFactCheckInto(
      activeStreamEl,
      activeStreamMeta.text,
      activeStreamMeta.sources
    );
  } else {
    activeStreamEl.textContent = activeStreamMeta.text;
  }
}

function renderFactCheckInto(el, text, sources) {
  el.innerHTML = "";
  const parsed = parseVerdict(text);

  if (parsed.verdict) {
    const badge = document.createElement("div");
    badge.className = `verdict ${parsed.verdict.toLowerCase().replace(/\s+/g, "-")}`;
    badge.textContent = parsed.confidence
      ? `${parsed.verdict} · ${parsed.confidence} confidence`
      : parsed.verdict;
    el.appendChild(badge);
  }

  const body = document.createElement("div");
  body.textContent = parsed.body || text;
  el.appendChild(body);

  if (sources && sources.length) {
    const wrap = document.createElement("div");
    wrap.className = "sources";
    const label = document.createElement("div");
    label.className = "sources-label";
    label.textContent = "Sources";
    wrap.appendChild(label);
    const ol = document.createElement("ol");
    sources.forEach((s) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.textContent = s.title || s.url;
      li.appendChild(a);
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    el.appendChild(wrap);
  }
}

// Parse "VERDICT: ... / CONFIDENCE: ... / REASONING: ..." from streaming text.
// Forgiving — works even with partial output.
function parseVerdict(text) {
  const verdictMatch = text.match(
    /VERDICT:\s*(TRUE|FALSE|MIXED|UNVERIFIED|PARTIALLY TRUE)/i
  );
  const confMatch = text.match(/CONFIDENCE:\s*(HIGH|MEDIUM|LOW)/i);
  const reasonMatch = text.match(/REASONING:\s*([\s\S]*?)(?:\n[A-Z ]+:|$)/i);
  let verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;
  if (verdict === "PARTIALLY TRUE") verdict = "MIXED";
  return {
    verdict,
    confidence: confMatch ? confMatch[1].toUpperCase() : null,
    body: reasonMatch ? reasonMatch[1].trim() : text,
  };
}

function renderHistory() {
  els.messages.innerHTML = "";
  for (const m of history) {
    pushMessage(m.role, m.content, m.meta);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
  stickToBottom = true;
  els.scrollToBottom.classList.add("hidden");
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
