---
name: ai-models
description: Route queries to external AI models (Kimi K2, Minimax, Gemini, GLM-4.7, GLM-5) via ai_query and ai_image MCP tools. Handles auto-routing, user overrides ("use kimi:"), and fallback when Claude limits are hit.
allowed-tools: mcp__nanoclaw__ai_query, mcp__nanoclaw__ai_image
---

# Multi-Model AI Routing

You have access to external AI models via the `ai_query` and `ai_image` MCP tools. Use these to distribute workload, get second opinions, or leverage model-specific strengths.

## Available Models

| Model | Key | Best For |
|-------|-----|----------|
| **Kimi K2** | `kimi` | Ideation, brainstorming, creative angles, strategic thinking |
| **Minimax M1** | `minimax` | Code generation overflow, long-form code tasks |
| **Gemini 2.5 Flash** | `gemini` | Research, factual queries, summarization, image generation |
| **GLM-4.7** | `glm` | Research, analysis, knowledge tasks |
| **GLM-5 (Reasoning)** | `glm-reason` | Complex reasoning, math, logic, step-by-step problem solving |

## User Override Syntax

When the user says **"use kimi:"**, **"use minimax:"**, **"use gemini:"**, **"use glm:"**, or **"use glm-reason:"** at the start of their message, route the query to that specific model using `ai_query` with the `model` parameter.

Examples:
- "use kimi: give me 3 angles for positioning Ethnobot" → `ai_query(model: "kimi", prompt: "...")`
- "use gemini: research the latest on RAG architectures" → `ai_query(model: "gemini", prompt: "...")`
- "use glm: analyze this market report" → `ai_query(model: "glm", prompt: "...")`
- "use glm-reason: solve this optimization problem step by step" → `ai_query(model: "glm-reason", prompt: "...")`

## Auto-Routing

When no model is specified, use your own judgment (Claude) by default. Call `ai_query` without a `model` parameter only when:
1. You want a second opinion or alternative perspective
2. The task benefits from a different model's strengths
3. You're generating many variants and want to parallelize

For reasoning-heavy tasks (math, logic, multi-step analysis), consider routing to `glm-reason` (GLM-5) which has dedicated reasoning capabilities.

## Fallback Chain

When you hit rate limits or capacity issues, the fallback order is:
1. **Minimax** (first fallback)
2. **Kimi K2** (second fallback)
3. **GLM-4.7** (third fallback)

Omit the `model` parameter in `ai_query` to auto-select the first available model from the fallback chain.

## Image Generation

Use `ai_image` for any visual content needs. Requires Gemini API key.

```
ai_image(prompt: "A clean diagram showing microservice architecture with 3 services")
```

## Guidelines

- Always present external model responses clearly attributed: "[Kimi K2]", "[Minimax]", "[GLM-4.7]", "[GLM-5]", etc.
- You can synthesize or critique external model responses — you're the orchestrator.
- For brainstorming, consider calling multiple models in parallel via the Task tool.
- Never send API keys or secrets to external models in prompts.
