// background.js — service worker (persists independently of the popup)
// Handles all Ollama API calls so closing the popup doesn't kill the stream.
// Also supports stopping a stream mid-flight via AbortController.

// Track AbortControllers per active tabKey so STOP_CHAT can cancel.
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

async function handleChat({ tabKey, messages, ollamaUrl, modelName }) {
  const pendingKey = `pending:${tabKey}`;
  const controller = new AbortController();
  activeControllers.set(tabKey, controller);

  await chrome.storage.local.set({
    [pendingKey]: { text: "", done: false, error: null },
  });

  let full = "";
  let tokensSinceLastSave = 0;
  let stopped = false;

  try {
    let resp;
    try {
      resp = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, messages, stream: true }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        stopped = true;
      } else {
        throw new Error(
          `Cannot reach Ollama at ${ollamaUrl}. Is it running? (${e.message})`
        );
      }
    }

    if (!stopped) {
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
          // Try to release the underlying connection
          try {
            await reader.cancel();
          } catch (_) {
            /* ignore */
          }
        } else {
          throw e;
        }
      }
    }

    // Persist whatever we accumulated (full reply or partial if stopped)
    const stored = await chrome.storage.local.get(tabKey);
    const history = stored[tabKey] || [];
    if (full.trim()) {
      history.push({ role: "assistant", content: full });
    }
    await chrome.storage.local.set({
      [tabKey]: history,
      [pendingKey]: { text: full, done: true, error: null },
    });

    chrome.runtime
      .sendMessage({ type: stopped ? "STOPPED" : "DONE", tabKey })
      .catch(() => {});
  } catch (err) {
    // Save partial output even on error
    const stored = await chrome.storage.local.get(tabKey);
    const history = stored[tabKey] || [];
    if (full.trim()) {
      history.push({ role: "assistant", content: full });
    }
    await chrome.storage.local.set({
      [tabKey]: history,
      [pendingKey]: { text: full, done: true, error: err.message },
    });
    chrome.runtime
      .sendMessage({ type: "ERROR", tabKey, error: err.message })
      .catch(() => {});
  } finally {
    activeControllers.delete(tabKey);
  }
}
