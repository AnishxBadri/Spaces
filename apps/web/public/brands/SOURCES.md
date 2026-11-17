# Brand app icons

Each file is the brand's own icon, fetched once from the brand's own site and
served from here so no mark loads from another origin. `ProviderMark` draws
them; every other brand is an inline path in that component.

| File             | Source                                              |
| ---------------- | --------------------------------------------------- |
| `apollo.png`     | https://www.apollo.io/apple-icon.png                |
| `exa.png`        | https://exa.ai/favicon.ico (its 128px image)        |
| `granola.png`    | https://www.granola.ai/favicon/apple-touch-icon.png |
| `ollama.png`     | https://ollama.com/public/apple-touch-icon.png      |
| `openrouter.png` | https://openrouter.ai/apple-touch-icon.png          |

OpenAI's mark is inline in `ProviderMark`, from the logomark OpenAI serves at
https://chatgpt.com/cdn/assets/favicon.6a33781f61.svg (openai.com refuses
scripted requests).
