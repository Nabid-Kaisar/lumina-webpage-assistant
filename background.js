// background.js — service worker (persists independently of the popup)
// Handles all Ollama API calls so closing the popup doesn't kill the stream.
// Supports two modes:
//   - "ask"       : answer question about the current webpage
//   - "factcheck" : verify a claim using web search + the current page

const activeControllers = new Map(); // tabKey -> AbortController

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_CHAT") {
    handleChat(msg).catch(console.error);
    sendResponse({ ok: true });
  } else if (msg.type === "STOP_CHAT") {
    const controller = activeControllers.get(msg.tabKey);
    if (controller) controller.abort();
    sendResponse({ ok: !!controller });
  }
  return false;
});

// ===========================================================================
// Main entry — dispatches by mode
// ===========================================================================

async function handleChat(payload) {
  const { tabKey, mode } = payload;
  const pendingKey = `pending:${tabKey}`;
  const controller = new AbortController();
  activeControllers.set(tabKey, controller);

  await chrome.storage.local.set({
    [pendingKey]: { text: "", done: false, error: null, mode },
  });

  try {
    if (mode === "factcheck") {
      await runFactCheck(payload, controller);
    } else {
      await runAsk(payload, controller);
    }
  } catch (err) {
    await chrome.storage.local.set({
      [pendingKey]: { text: "", done: true, error: err.message, mode },
    });
    chrome.runtime
      .sendMessage({ type: "ERROR", tabKey, error: err.message })
      .catch(() => {});
  } finally {
    activeControllers.delete(tabKey);
  }
}

// ===========================================================================
// Mode: ASK PAGE  (unchanged from previous version)
// ===========================================================================

async function runAsk({ tabKey, messages, ollamaUrl, modelName }, controller) {
  const result = await streamOllama({
    tabKey,
    ollamaUrl,
    modelName,
    messages,
    controller,
  });

  // Persist assistant message to history
  const stored = await chrome.storage.local.get(tabKey);
  const history = stored[tabKey] || [];
  if (result.text.trim()) {
    history.push({ role: "assistant", content: result.text });
  }
  await chrome.storage.local.set({
    [tabKey]: history,
    [`pending:${tabKey}`]: { text: result.text, done: true, error: null },
  });
  chrome.runtime
    .sendMessage({ type: result.stopped ? "STOPPED" : "DONE", tabKey })
    .catch(() => {});
}

// ===========================================================================
// Mode: FACT-CHECK
// ===========================================================================

async function runFactCheck(payload, controller) {
  const { tabKey, claim, pageContext, ollamaUrl, modelName } = payload;

  // Step 1: search the web
  chrome.runtime
    .sendMessage({ type: "FACTCHECK_STATUS", tabKey, text: "Searching the web…" })
    .catch(() => {});

  let sources = [];
  try {
    sources = await searchDuckDuckGo(claim, controller.signal);
  } catch (e) {
    if (e.name === "AbortError") {
      await finishFactCheck(tabKey, "", sources, true);
      return;
    }
    // Carry on with no sources — model can still flag as UNVERIFIED
    console.warn("Search failed:", e.message);
  }

  // Send found sources to popup so it can render them while the LLM thinks
  chrome.runtime
    .sendMessage({ type: "FACTCHECK_SOURCES", tabKey, sources })
    .catch(() => {});

  // Step 2: build prompt and stream from Ollama
  const messages = buildFactCheckMessages({ claim, pageContext, sources });
  chrome.runtime
    .sendMessage({ type: "FACTCHECK_STATUS", tabKey, text: "Cross-referencing…" })
    .catch(() => {});

  const result = await streamOllama({
    tabKey,
    ollamaUrl,
    modelName,
    messages,
    controller,
  });

  // Step 3: persist as a fact-check entry with metadata
  await finishFactCheck(tabKey, result.text, sources, result.stopped);
}

async function finishFactCheck(tabKey, text, sources, stopped) {
  const stored = await chrome.storage.local.get(tabKey);
  const history = stored[tabKey] || [];
  if (text.trim()) {
    history.push({
      role: "assistant",
      content: text,
      meta: { kind: "factcheck", sources },
    });
  }
  await chrome.storage.local.set({
    [tabKey]: history,
    [`pending:${tabKey}`]: { text, done: true, error: null },
  });
  chrome.runtime
    .sendMessage({ type: stopped ? "STOPPED" : "DONE", tabKey })
    .catch(() => {});
}

function buildFactCheckMessages({ claim, pageContext, sources }) {
  const sourceBlock = sources.length
    ? sources
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    Snippet: ${s.snippet}`
        )
        .join("\n\n")
    : "(no web sources retrieved)";

  const pageBlock = pageContext
    ? `[Page] The webpage the user is currently reading\n    Title: ${pageContext.title}\n    URL: ${pageContext.url}\n    Excerpt:\n${pageContext.text.slice(0, 4000)}`
    : "(no current page context)";

  const system = `You are a careful fact-checker. Determine whether the CLAIM below is supported by the SOURCES.

Rules:
- Use only the sources provided. Do not rely on prior knowledge.
- Cross-reference. A claim is only TRUE if multiple independent sources agree.
- If sources disagree, the verdict is MIXED.
- If no source addresses the claim, the verdict is UNVERIFIED.

Respond in EXACTLY this format (the labels must appear on their own lines):

VERDICT: TRUE | FALSE | MIXED | UNVERIFIED
CONFIDENCE: HIGH | MEDIUM | LOW
REASONING: <2-4 sentences explaining your verdict>
KEY SOURCES: <comma-separated labels of the sources you relied on, e.g. "Page, 1, 3">`;

  const user = `CLAIM:
"${claim}"

SOURCES:

${pageBlock}

${sourceBlock}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ===========================================================================
// DuckDuckGo search + parse
// ===========================================================================

async function searchDuckDuckGo(query, signal, max = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    method: "GET",
    signal,
    headers: { Accept: "text/html" },
  });
  if (!resp.ok) throw new Error(`DuckDuckGo returned ${resp.status}`);
  const html = await resp.text();
  if (/Unfortunately, bots use DuckDuckGo too/i.test(html)) {
    throw new Error("DuckDuckGo rate-limited the request. Try again in a moment.");
  }
  return parseDdgResults(html, max);
}

function parseDdgResults(html, max) {
  const results = [];
  // Iterate by snippet anchors; each is preceded by a result__a anchor.
  const re =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && results.length < max) {
    const rawHref = m[1];
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    const url = decodeDdgUrl(rawHref);
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function decodeDdgUrl(href) {
  let normalized = href;
  if (normalized.startsWith("//")) normalized = "https:" + normalized;
  try {
    const u = new URL(normalized);
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : normalized;
  } catch {
    return normalized;
  }
}

function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ===========================================================================
// Ollama streaming (shared by both modes)
// ===========================================================================

async function streamOllama({
  tabKey,
  ollamaUrl,
  modelName,
  messages,
  controller,
}) {
  const pendingKey = `pending:${tabKey}`;
  let full = "";
  let tokensSinceLastSave = 0;
  let stopped = false;

  let resp;
  try {
    resp = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, messages, stream: true }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") return { text: "", stopped: true };
    throw new Error(
      `Cannot reach Ollama at ${ollamaUrl}. Is it running? (${e.message})`
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Ollama responded ${resp.status}: ${body.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.error) throw new Error(json.error);
          if (json.message?.content) {
            full += json.message.content;
            tokensSinceLastSave++;
            chrome.runtime
              .sendMessage({
                type: "TOKEN",
                tabKey,
                chunk: json.message.content,
              })
              .catch(() => {});
            if (tokensSinceLastSave >= 10) {
              chrome.storage.local.set({
                [pendingKey]: { text: full, done: false, error: null },
              });
              tokensSinceLastSave = 0;
            }
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      stopped = true;
      try {
        await reader.cancel();
      } catch (_) {}
    } else {
      throw e;
    }
  }

  return { text: full, stopped };
}
