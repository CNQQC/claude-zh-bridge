<p align="center"><img src="docs/media/hero.svg" alt="Claude ZH Bridge — write in Chinese, send in English, read in Chinese" width="1200"></p>
<p align="center"><a href="README.md">简体中文</a> · <a href="#install">Install</a> · <a href="docs/privacy.md">Privacy</a> · <a href="CONTRIBUTING.md">Contribute</a></p>
<p align="center"><a href="https://github.com/CNQQC/claude-zh-bridge/actions/workflows/ci.yml"><img src="https://github.com/CNQQC/claude-zh-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-25251f" alt="MIT"></a> <img src="https://img.shields.io/badge/Chrome-Manifest_V3-25251f" alt="Chrome MV3"></p>

**Keep your existing Claude workflow. Write and read in Chinese.**

Claude ZH Bridge translates Chinese prompts into English before sending, displays completed English replies in Chinese in place, and translates conversation titles. It preserves code, links, math and native tool controls where possible. No persistent translation panel; completed translations are cached locally across reloads and restarts.

> Independent, unofficial project. No provider key is shipped. The reversible desktop patch is currently validated only with **Claude Desktop 3.1623.0** on Apple Silicon, macOS 14+.

## See it work

<img src="docs/media/claude-live.gif" alt="Actual Claude Desktop recording: Chinese input, English response translated in place, and restoration after reload" width="1200">

This is a recording of the actual patched Claude app in a dedicated demo conversation. It is cropped, resized, captioned and edited to shorten waiting time. Messages and UI are not replaced or synthesized. Account details, conversation history and local paths are excluded. [Still image](docs/media/claude-live.png) · [Recording notes](docs/demos/README.md)

## Where it helps

| Workflow | Behavior |
| --- | --- |
| Describe a task in Chinese | Click Send or press Enter normally. Translation finishes before submission; the sent message displays your original Chinese draft. |
| Read a long English answer | Completed prose appears in Chinese with paragraphs, lists and tables preserved. |
| Follow Desktop Code tool rounds | Translate explanatory prose around tool calls while keeping code, terminal output and approval controls intact. |
| Reopen an old conversation | Restore completed translations from the local cache instead of resubmitting them. |
| Browse recent conversations | Translate rendered session titles without changing their links, ordering or native actions. |

Hover or focus the small **EN / 中** control to inspect the original. Claude's native Copy action normally still copies the source; select the translated text to copy Chinese.

## Fewer requests, less repeated overhead

Stable reply blocks, Code paragraphs and titles are collected together. Cached text and duplicates are removed before an LLM request. Chinese-to-English input stays on a separate immediate path so sending does not wait for display jobs.

```text
Pending blocks + titles → cache lookup → in-flight deduplication
                                         ↓
                                 one request for new text
                                         ↓
                                  persist → display
```

A regression fixture verifies **70 short Code paragraphs + 1 title → 1 request**. A separate real-provider test confirmed three blocks in one request and zero additional requests after backend recreation. Very long pages are split at an approximately 6,000-character uncached-text budget to avoid truncated output.

Batching reduces repeated instructions and request overhead. It does not remove the cost of translating the text itself, and no fixed savings percentage is promised. [Validation scope](docs/verification.md)

## Install

### Chrome

1. Download `claude-zh-bridge-extension-*.zip` from [Releases](https://github.com/CNQQC/claude-zh-bridge/releases/latest) and extract it to a stable location.
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the folder containing `manifest.json`.
3. Open the extension's settings and verify **your own DeepSeek API key**.
4. Open or reload a saved Claude conversation.

The browser key lives in restricted **session storage**. Enter it again after restarting Chrome; completed translations and preferences remain local. Update the same extension directory and reload it to preserve its ID and cache. Do not uninstall it first.

### macOS

1. Download `claude-zh-bridge-macos-arm64-*.zip` from [Releases](https://github.com/CNQQC/claude-zh-bridge/releases/latest).
2. Open Claude 中文桥 and configure your own key. Defaults: `https://api.deepseek.com`, `deepseek-flash`, thinking disabled. Desktop supports a custom HTTPS endpoint, model and independent translation/scope switches.
3. Let active Claude tasks finish, quit Claude completely, then select **Install patch**. The tool backs up, validates and locally signs the selected app.
4. Reopen Claude. Handle any macOS identity or Keychain prompts yourself in the system dialog.

Requires **Apple Silicon, macOS 14+, Claude Desktop 3.1623.0**. Intel, Windows and Linux are not validated. Unsupported Claude versions are refused. The patcher is locally signed and not Apple-notarized.

<details>
<summary><strong>Desktop changes and rollback</strong></summary>

The patch replaces the selected app's vendor signature with a local signature and adds a library-validation exception only to that app. SIP, Gatekeeper, the sandbox and ASAR integrity checking remain enabled. Official updates are not disabled.

Original files and signatures are backed up. Hash checks, an installation lock, atomic replacement and interrupted-operation recovery protect the update path. **Restore original** restores the app while retaining account data, conversations and translation caches. Existing legacy patches must first import their own verified original-backup manifest. No Claude app bundle or personal backup is distributed. [Desktop guide](docs/desktop.md)

</details>

## Scope

| Surface | Support |
| --- | --- |
| Claude Chat in desktop Chrome | Supported, Chrome 120+, MV3. |
| Claude Desktop Chat and left-side Code | Supported on the validated desktop version. |
| Terminal `claude` CLI | Not supported; no CLI proxy. |
| Settings, project management and public share pages | Translation is inactive. |
| Images, voice, attachments and standalone Artifacts | Not translated. |

## Your data

- Bring your own key. Public source, builds and media contain no personal credentials.
- Text requiring translation goes to DeepSeek by default, or the endpoint you configure on desktop. No project-operated relay, analytics or telemetry service is used.
- Results stay on your machine. Caches may contain conversation text; protect them accordingly.
- Failed or interrupted paid requests are not silently resubmitted. Manual retry preserves completed results.
- Desktop endpoint/model changes use separate caches without deleting previous results.

See [storage and data flow](docs/privacy.md).

## Develop

```sh
git clone https://github.com/CNQQC/claude-zh-bridge.git
cd claude-zh-bridge
npm ci
npm test
npm run package:extension
```

On macOS with Xcode Command Line Tools:

```sh
sh scripts/test_native.sh
npm run build:mac
```

`extension/` is the shared runtime source; builds generate the desktop payload and isolated preload. Default tests use synthetic keys, mocked providers and temporary directories. They do not bill a live API or modify an installed Claude app.

Contributions with a minimal reproduction and meaningful regression coverage are welcome. Remove account information, local paths and secrets from reports. [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT License](LICENSE)

Claude and DeepSeek are trademarks of their respective owners. This project is not affiliated with or endorsed by either provider.
