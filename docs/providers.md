# LLM Providers & Costs (BYOK)

CoWork OS is **free and open source**. To run tasks, configure your own model credentials or use local models.

> **Zero-config start**: CoWork OS ships with [OpenRouter](https://openrouter.ai) selected as the default provider using its free model router (`openrouter/free`), which automatically picks from available free models. You can start using the app immediately without any API keys. To unlock the full range of models, create a free OpenRouter account at [openrouter.ai/keys](https://openrouter.ai/keys) (no credit card required) and paste the key in **Settings > LLM**. You can switch to any other provider at any time.

## Built-in Providers

| Provider | Configuration | Billing |
|----------|---------------|---------|
| Anthropic API | API key in Settings | Pay-per-token |
| Azure Anthropic | API key + endpoint + deployment in Settings | Pay-per-token via Azure |
| Google Gemini | API key in Settings | Pay-per-token (free tier available) |
| OpenRouter | API key in Settings (default provider) | Free tier available, pay-per-token for premium models |
| OpenAI (API Key) | API key in Settings | Pay-per-token |
| OpenAI (ChatGPT OAuth) | Sign in with ChatGPT account | Uses your ChatGPT subscription |
| AWS Bedrock | AWS credentials in Settings (auto-resolves inference profiles) | Pay-per-token via AWS |
| Azure OpenAI | API key + endpoint in Settings | Pay-per-token via Azure |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |
| HuggingFace Local AI | Install `hf-agents` and run `llama.cpp` locally | **Free** (runs locally) |
| Groq | API key in Settings | Pay-per-token |
| xAI (Grok) | API key in Settings | Pay-per-token |
| Kimi (Moonshot) | API key in Settings | Pay-per-token |
| Pi (Multi-LLM) | Unified API via pi-ai | Routes to multiple providers |

## Compatible / Gateway Providers

| Provider | Configuration | Billing |
|----------|---------------|---------|
| OpenCode Zen | API key + base URL in Settings | Provider billing |
| Google Vertex | Access token + base URL in Settings | Provider billing |
| Google Antigravity | Access token + base URL in Settings | Provider billing |
| Google Gemini CLI | Access token + base URL in Settings | Provider billing |
| Z.AI | API key + base URL in Settings | Provider billing |
| GLM | API key + base URL in Settings | Provider billing |
| Vercel AI Gateway | API key in Settings | Provider billing |
| Cerebras | API key in Settings | Provider billing |
| Mistral | API key in Settings | Provider billing |
| GitHub Copilot | GitHub token in Settings | Subscription-based |
| Moonshot (Kimi) | API key in Settings | Provider billing |
| Qwen Portal | API key in Settings | Provider billing |
| MiniMax | API key in Settings | Provider billing |
| MiniMax Portal | API key in Settings | Provider billing |
| Xiaomi MiMo | API key in Settings | Provider billing |
| Venice AI | API key in Settings | Provider billing |
| Synthetic | API key in Settings | Provider billing |
| Kimi Code | API key in Settings | Provider billing |
| Kimi Coding | API key in Settings | Provider billing |
| OpenAI-Compatible (Custom) | API key + base URL in Settings | Provider billing |
| Anthropic-Compatible (Custom) | API key + base URL in Settings | Provider billing |

**Your usage is billed directly by your provider.** CoWork OS does not proxy or resell model access.

---

## Ordered LLM Fallback Chains

CoWork OS can route a task through an explicit provider/model fallback chain instead of relying on a single primary provider.

Configure this in **Settings > LLM**:

- choose your primary provider/model
- add fallback providers in order
- optionally choose capability-based routing for workflow phases or specialized tasks

Fallback chains are used when a provider is unavailable, rate-limited, rejected by policy, or lacks the required capability for the task. Runtime surfaces in the app and Mission Control show the active provider, routing reason, and whether a fallback occurred.

---

## Azure Anthropic

Use Azure-hosted Claude models through your Azure subscription.

### Setup

1. Deploy a Claude model in your Azure AI Studio account.
2. Open **Settings** > **LLM** and select **Azure Anthropic**.
3. Enter your Azure API key, endpoint URL (e.g. `https://<resource>.services.ai.azure.com`), and deployment name.

### Notes

- Uses the Anthropic messages API format, not the Azure OpenAI format.
- Separate from the existing **Azure OpenAI** provider — use this for Claude models, Azure OpenAI for GPT models.
- All billing goes through your Azure subscription.

---

## Ollama (Local LLMs)

Run completely offline and free.

### Setup

```bash
brew install ollama
ollama pull llama3.2
ollama serve
```

### Recommended Models

| Model | Size | Best For |
|-------|------|----------|
| `llama3.2` | 3B | Quick tasks |
| `qwen2.5:14b` | 14B | Balanced performance |
| `deepseek-r1:14b` | 14B | Coding tasks |

---

## HuggingFace Local AI (`hf-agents` + `llama.cpp`)

Run compatible local models through CoWork's HuggingFace Local AI provider.

### Setup

```bash
pip install huggingface_hub
hf extensions install hf-agents
```

Then open **Settings** > **LLM**, choose **HuggingFace Local AI**, select or enter a model, and start the local `llama.cpp` server from the provider panel.

### Notes

- Default local endpoint: `http://localhost:8080`
- API key is optional for local runs
- Best fit when you want a private local provider but do not want to depend on Ollama

---

## Google Gemini

1. Get API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Configure in **Settings** > **Google Gemini**

Models: `gemini-2.0-flash` (default), `gemini-2.5-pro` (most capable), `gemini-2.5-flash` (fast)

---

## OpenRouter

Access multiple AI providers through one API.

1. Get API key from [OpenRouter](https://openrouter.ai/keys)
2. Configure in **Settings** > **OpenRouter**

Available: Claude, GPT-4, Gemini, Llama, Mistral, and more — see [openrouter.ai/models](https://openrouter.ai/models)

---

## OpenAI / ChatGPT

- **Option 1: API Key** — Standard pay-per-token access to GPT models
- **Option 2: ChatGPT OAuth** — Sign in with your ChatGPT subscription

---

## Web Search Providers

Multi-provider web search for research tasks with automatic retry and fallback. DuckDuckGo is built-in and requires no setup — it serves as a free fallback so web search always works, even without API keys.

| Provider | Types | API Key | Best For |
|----------|-------|---------|----------|
| **DuckDuckGo** | Web | Not required (built-in) | Zero-config free fallback |
| **Tavily** | Web, News | Required | AI-optimized results (recommended) |
| **Exa** | Web, News | Required | Semantic search and research-heavy retrieval |
| **Brave Search** | Web, News, Images | Required | Privacy-focused |
| **SerpAPI** | Web, News, Images | Required | Google results |
| **Google Custom Search** | Web, Images | Required | Direct Google integration |

DuckDuckGo is always available as the last-resort fallback. When paid providers are configured, they are tried first in the configured order, with DuckDuckGo only used if all others fail. Search settings also support explicit primary/fallback ordering and provider cooldown behavior after repeated failures.

Configure paid providers in **Settings** > **Web Search**.
