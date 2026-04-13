# Valley Open

**Local AI by MeTal Labs** — runs Gemma 4 entirely on your device. No data sent anywhere.

## Models

| Name | Base Model | RAM | Context |
|------|-----------|-----|---------|
| Valley Open .5 | Gemma 4 E2B | ~2GB | 128K |
| Valley Open 1 | Gemma 4 E2B | ~3GB | 128K |
| Valley Open 2 | Gemma 4 E4B | ~5GB | 128K |
| Valley Open 3 | Gemma 4 26B A4B (MoE) | ~18GB | 256K |
| Valley Open 4 | Gemma 4 31B | ~20GB | 256K |

## Features

- **Fully local** — models run via llama-server (llama.cpp), no internet required after download
- **Agentic mode** — run PowerShell/CMD commands, open files, browse the web headlessly, read/write files
- **Streaming** — token-by-token output
- **Auto system prompt** — Valley's identity injected automatically
- **MeTal dark theme** — Space Mono + Syne, red accent

## Setup (Dev)

### Prerequisites

1. **Node.js** (v18+) + npm
2. **llama-server.exe** — grab a prebuilt Windows binary from [llama.cpp releases](https://github.com/ggerganov/llama.cpp/releases) and place it at `bin/llama-server.exe`
3. Models are downloaded automatically via the app's Models page (from HuggingFace)

### Install & Run

```bash
npm install
npm start
```

### Build (Windows EXE)

```bash
npm run build
```

Output goes to `dist/`.

> **Note:** The app requests admin elevation via the NSIS installer manifest. This is required for Agentic mode (PowerShell access, file writes outside user dirs, etc).

## Agentic Mode

When you run the app as Administrator, the Agentic toggle unlocks. Valley can then:

- `run_command` — execute PowerShell/CMD and return stdout
- `open_file` — open any file or app with the default handler
- `browse_web` — headless Playwright Chromium, returns page text
- `read_file` — read any file as text
- `write_file` — write text to any path

Valley decides when to use tools based on your message. Tool calls and results are shown inline in the chat.

## Project Structure

```
valley-open/
├── src/
│   ├── main/
│   │   ├── main.js        # Electron main process
│   │   └── preload.js     # Context bridge
│   └── renderer/
│       ├── index.html     # App UI
│       ├── style.css      # Styles
│       └── app.js         # Renderer logic
├── bin/
│   └── llama-server.exe   # (you provide this)
├── assets/
│   └── icon.ico
└── package.json
```

## Notes

- llama-server runs on `127.0.0.1:8765` while a model is loaded
- Models stored in `%AppData%\ValleyOpen\models\`
- Config stored in `%AppData%\ValleyOpen\config.json`
