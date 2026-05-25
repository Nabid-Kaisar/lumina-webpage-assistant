const DEFAULTS = {
  ollamaUrl: "http://localhost:11434",
  modelName: "qwen3:8b",
  maxChars: 20000,
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
};

let settings = { ...DEFAULTS };
let pageContext = null;
let history = [];
let busy = false;
let activeTabKey = null;
let activeStreamEl = null;

// Smart-scroll: only auto-scroll if the user is already pinned at the bottom.
let stickToBottom = true;
const BOTTOM_THRESHOLD = 24; // px from bottom counts as "at bottom"

// Register listener BEFORE any async work so we never miss a message
// sent by background while init() is awaiting.
chrome.runtime.onMessage.addListener(handleBackgroundMessage);

init();

// ---------------------------------------------------------------------------
// Background message handler
// ---------------------------------------------------------------------------

function handleBackgroundMessage(msg) {
  if (!activeTabKey || msg.tabKey !== activeTabKey) return;

  if (msg.type === "TOKEN") {
    if (activeStreamEl) {
      activeStreamEl.textContent += msg.chunk;
      maybeAutoScroll();
    }
  } else if (msg.type === "DONE") {
    finalizeStream("ok", "Done.");
  } else if (msg.type === "STOPPED") {
    finalizeStream("ok", "Stopped.");
  } else if (msg.type === "ERROR") {
    if (activeStreamEl) {
      activeStreamEl.textContent =
        (activeStreamEl.textContent || "") + `\n⚠ ${msg.error}`;
    }
    finalizeStream("error", msg.error);
  }
}

function finalizeStream(kind, statusText) {
  if (activeStreamEl) activeStreamEl.classList.remove("streaming");
  activeStreamEl = null;
  setBusy(false);
  // Sync history from storage (background appended assistant message)
  chrome.storage.local.get(activeTabKey).then((stored) => {
    history = stored[activeTabKey] || [];
  });
  setStatus(statusText, kind);
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  settings = await loadSettings();
  els.ollamaUrl.value = settings.ollamaUrl;
  els.modelName.value = settings.modelName;
  els.maxChars.value = settings.maxChars;

  const tab = await getActiveTab();
  activeTabKey = `chat:${tab?.id ?? "unknown"}`;
  const pendingKey = `pending:${activeTabKey}`;

  // Load persisted history (chrome.storage.local survives popup close)
  const stored = await chrome.storage.local.get([activeTabKey, pendingKey]);
  history = stored[activeTabKey] || [];
  renderHistory();

  // If a stream is in progress, resume the visual
  const pending = stored[pendingKey];
  if (pending && !pending.done) {
    activeStreamEl = pushMessage("assistant", pending.text || "");
    activeStreamEl.classList.add("streaming");
    setBusy(true);
    setStatus("Response in progress…");
  } else if (pending?.error) {
    setStatus(`Last request failed: ${pending.error}`, "error");
  }

  // Extract page text
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

  // Listeners
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

  // Smart-scroll detection
  els.messages.addEventListener("scroll", onMessagesScroll);
  els.scrollToBottom.addEventListener("click", () => {
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
    stickToBottom = true;
    els.scrollToBottom.classList.add("hidden");
  });

  // Initial scroll state
  els.messages.scrollTop = els.messages.scrollHeight;
  stickToBottom = true;
}

// ---------------------------------------------------------------------------
// Smart scrolling
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function onSaveSettings() {
  settings = {
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
  // If a stream is running, stop it first
  if (busy) {
    chrome.runtime
      .sendMessage({ type: "STOP_CHAT", tabKey: activeTabKey })
      .catch(() => {});
  }
  history = [];
  activeStreamEl = null;
  setBusy(false);
  await chrome.storage.local.remove([
    activeTabKey,
    `pending:${activeTabKey}`,
  ]);
  renderHistory();
  setStatus("Chat cleared.", "ok");
}

// ---------------------------------------------------------------------------
// Page extraction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sending / stopping a message
// ---------------------------------------------------------------------------

async function onSend() {
  if (busy) return;
  const question = els.input.value.trim();
  if (!question) return;

  els.input.value = "";
  pushMessage("user", question);

  // Sending a new message means the user wants to see the reply — re-pin
  stickToBottom = true;
  els.scrollToBottom.classList.add("hidden");
  els.messages.scrollTop = els.messages.scrollHeight;

  // Build messages BEFORE pushing current question to history array
  const messages = buildMessages(question);

  // Persist user message immediately
  history.push({ role: "user", content: question });
  await chrome.storage.local.set({ [activeTabKey]: history });

  setBusy(true);
  setStatus("Thinking…");

  activeStreamEl = pushMessage("assistant", "");
  activeStreamEl.classList.add("streaming");

  chrome.runtime
    .sendMessage({
      type: "START_CHAT",
      tabKey: activeTabKey,
      messages,
      ollamaUrl: settings.ollamaUrl,
      modelName: settings.modelName,
    })
    .catch((err) => {
      if (activeStreamEl) {
        activeStreamEl.textContent = `⚠ Could not reach background: ${err.message}`;
        activeStreamEl.classList.remove("streaming");
      }
      activeStreamEl = null;
      setBusy(false);
      setStatus(err.message, "error");
    });
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

function buildMessages(question) {
  const system = `You are a helpful assistant answering questions about a webpage the user is viewing.
Use ONLY the page content below as your source of truth. If the answer is not present, say so.
Be concise.

PAGE TITLE: ${pageContext?.title ?? "(unknown)"}
PAGE URL: ${pageContext?.url ?? "(unknown)"}
---
${pageContext?.text ?? "(no page content available)"}
---`;
  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: question },
  ];
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function pushMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.appendChild(div);
  // Auto-scroll only if the user is pinned at bottom
  maybeAutoScroll();
  return div;
}

function renderHistory() {
  els.messages.innerHTML = "";
  for (const m of history) pushMessage(m.role, m.content);
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
