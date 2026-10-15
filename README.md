# Browser LLM Action Extension

**Fair warning: this is currently an early prototype and it's not published as a properly built extension yet, but I'm sharing this early build as it's already working as a proof-of-concept when running in development. Chrome only for now.**

**Security notice: There's currently no specific prompt injection attack mitigation implemented. The extension doesn't automatically read all content of websites, only in small bits through tool calls. So it starts out with absolutely no information on what you have open and will explore based on your instructions. DO NOT use it in your main browser with logged in sessions, please only test in a separate installation like Chrome Canary. For more information why is this a serious concern, read [Simon Willison's blog post summing up Anthropic's research](https://simonwillison.net/2025/Aug/26/piloting-claude-for-chrome/). Currently the [set of tools](./utils/llm-helper.ts) is intentionally limited and doesn't expose script eval, navigation or network call capabilities, so the main use case targeted is automating some tasks within the same page. Otherwise, at a minimum, this extension would need to implement the two layers of protection from the [CaMel paper](https://simonwillison.net/2025/Apr/11/camel/) – dual LLM architecture with a custom interpreter – plus website based permissions.**

A cross-browser extension that provides a simple chat interface for LLMs (including local models) to interact with web pages.

Real-time demo using qwen/qwen3-coder-30b MLX 6bit running on an M2 Max MBP:

https://github.com/user-attachments/assets/7a584180-e8dd-4c7f-838a-efd051fa2968

## Features

- 🌐 Cross-browser support (Chrome & Firefox (soon))  
- 💬 Simple chat interface via sidepanel
- ⚙️ Configurable LLM providers (OpenAI, LM Studio, Custom)
- 💾 Persistent chat history
- 🛠️ Javascript tools returning minimal responses to keep context small

## Quick Start

### Zero-config build (NVIDIA NIM, free)

There's a ready-to-use Chrome build that is **preconfigured** — no keys or settings
needed. Download the zip from the [latest release](../../releases/latest), unzip it,
then load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the unzipped folder
4. Open the extension side panel and start chatting

It ships with NVIDIA's **free** hosted API already configured (endpoint, a shared
demo API key, and `nvidia/nemotron-3.5-lightning-30b-a3b` as the model). The model
field stays editable in **Options**, so you can point it at any other model or
provider.

> The bundled NVIDIA key is a shared, free demo key — perfect for trying things out.
> It may be rate-limited, so grab your own free key at
> [build.nvidia.com/settings](https://build.nvidia.com/settings) for daily use.

For development setup, see [DEVELOPMENT.md](DEVELOPMENT.md).

Once you got the extension running, if you want to see a quick demo go to Google.com and type `click Reject All, search fluffy robots, and tell me which 3 are the most popular`

## Installation

### Chrome Installation

```sh
pnpm install
pnpm dev:chrome
```

This should install dependencies, build the extension, and launch Chrome in extension development mode.

## Configuration

### Initial Setup

1. **Open Settings**:
   - Click the gear icon (⚙️) in the extension sidepanel
   - Or right-click the extension icon → Options

2. **Start LM Studio**:
   - Launch LM Studio application
   - Load a chat model
   - Go to Developer tab
   - Start the local server (should show green indicator)

3. **Configure LM Studio** (recommended for local models):
   - Select "LM Studio" from the provider dropdown
   - Endpoint: `http://localhost:1234/v1/chat/completions` (default)
   - Model: Enter model API identifier (e.g., "qwen/qwen3-coder-30b")
   - API Key: Leave blank
   - Click "Test Connection" to verify
   - Click "Save Settings"

4. **Start Chatting**:
   - Open the extension sidepanel
   - Type your message and press Enter
   - The extension will communicate with your local LLM and interact with the open tab (each tab will have its own session)

### Alternative Providers

You can also configure:

- **NVIDIA NIM (default, preconfigured)**: Hosted, OpenAI-compatible, **free** demo key bundled
- **OpenAI API**: Requires API key
- **Custom endpoints**: Any OpenAI-compatible API

### Using NVIDIA NIM

NVIDIA's API is OpenAI-compatible, so it works through the built-in **NVIDIA NIM** provider preset:

1. Create an API key at [build.nvidia.com/settings](https://build.nvidia.com/settings)
2. Open the extension **Options** page
3. Provider: **NVIDIA NIM**
4. Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions` (pre-filled)
5. Model: pick a **Tool Use** capable model from the suggestions, or **type any model ID** the endpoint exposes. Default is `nvidia/nemotron-3.5-lightning-30b-a3b`, e.g.
   - `nvidia/nemotron-3.5-lightning-30b-a3b` (default, preconfigured)
   - `meta/llama-3.3-70b-instruct`
   - `nvidia/nemotron-3-super-120b-a12b` or `nvidia/nemotron-3-ultra-550b-a55b`
6. Paste the API key, click **Test Connection**, then **Save Settings**

The **Model** field is free text and always editable — selecting a provider just pre-fills a suggestion, it never locks the value. Type or paste any model ID to override it.

Tool calling drives this extension, so models without solid function calling will not use the browser tools reliably. Browse the full list at [build.nvidia.com/models](https://build.nvidia.com/models).

## Troubleshooting

- **Extension won't load**: Check browser console for errors
- **Can't connect to LM Studio**: Ensure server is running on localhost:1234
- **No response from LLM**: Check LM Studio logs and network requests in DevTools
- **Permissions issues**: Make sure developer mode is enabled

## Development

For development setup, testing, and contribution guidelines, see [DEVELOPMENT.md](DEVELOPMENT.md).

## API Compatibility

The extension uses Vercel AI SDK and currently implements OpenAI-compatible chat completions API format, supporting:

- OpenAI API
- NVIDIA NIM (integrate.api.nvidia.com)
- LM Studio local server
- Any OpenAI-compatible endpoint

## License

MIT
