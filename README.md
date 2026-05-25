# Lumina

A Chrome extension that lets you ask questions about any webpage and fact-check claims against web sources — powered entirely by a local AI model running on your machine. No data leaves your device.

## Architecture

```
[ Chrome popup ] ── extracts page text via chrome.scripting
       │
       └── POST /api/chat (streaming NDJSON) ──> [ Ollama on localhost:11434 ] ── runs ──> Qwen
```

- `manifest.json` — Manifest V3 config (popup + activeTab/scripting/storage perms, allows fetch to `localhost:11434`)
- `popup.html` / `popup.css` / `popup.js` — the chat UI. Pulls the page text on open, then streams answers from Ollama.

No background service worker, no content script — `chrome.scripting.executeScript` injects the extractor only when the popup opens.

## Prerequisites

1. **Install Ollama** — https://ollama.com/download (Windows installer available)
2. **Pull a Qwen model**, e.g.:
   ```powershell
   ollama pull qwen3
   ```
   (Or `qwen2.5`, `qwen2.5:14b`, etc. — whatever fits your machine. Note: there is no "Qwen 3.5" tag at the time of writing; use `qwen3` or `qwen2.5`.)
3. **Allow the Chrome extension origin** to call Ollama. Ollama blocks browser origins by default. Set this env var **before launching Ollama**:
   ```powershell
   setx OLLAMA_ORIGINS "chrome-extension://*"
   ```
   Then fully restart Ollama (quit from the tray icon and reopen). Without this, you'll see a CORS / 403 error in the extension.

## Load the extension in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `qwen-webpage-assistant` folder
5. Pin the extension to the toolbar (puzzle icon → pin)

## Use it

1. Browse to any normal webpage (not a `chrome://` page — those can't be scripted).
2. Click the extension icon.
3. The status bar shows "Loaded …" with the page title and character count.
4. Type a question, press Enter.

## Settings (gear icon)

- **Ollama URL** — default `http://localhost:11434`
- **Model** — default `qwen3`. Set to whatever you pulled.
- **Max page chars** — default 20000. The page text is truncated to this before being sent to the model, to keep context windows sane. Bump it up if your model can handle more.

Chat history is stored per-tab in `chrome.storage.session` and clears when you close the browser.

## Troubleshooting

- **"Cannot reach Ollama at …"** — Ollama isn't running, or the URL is wrong. Test with `curl http://localhost:11434/api/tags`.
- **403 / CORS error** — `OLLAMA_ORIGINS` is not set (see step 3). After `setx`, you must restart Ollama for it to pick up the env var.
- **"Cannot read browser internal pages"** — extensions can't script `chrome://`, `chrome-extension://`, or the Web Store. Try a normal site.
- **Model is slow / OOM** — switch to a smaller Qwen tag (e.g. `qwen2.5:3b`) in Settings.
- **Answers are cut off** — the model may have its own context limit. Reduce **Max page chars** in settings, or pull a model variant with a larger context.

## Files

```
qwen-webpage-assistant/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
└── README.md
```
