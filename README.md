# JuriScan

Chrome extension that analyzes invoice compliance using a Claude AI agent. Upload a PDF or paste document text → the agent flags each required legal mention as present or missing → returns a compliance score + a ready-to-send follow-up email.

## Demo

![JuriScan](extension/icons/icon128.png)

- Score: 0–100 based on mandatory mentions (SIRET, TVA, payment terms, etc.)
- Status: Compliant / Non-compliant / Litigious
- Follow-up email drafted automatically when mentions are missing
- Scan history saved per user

## Architecture

```
Chrome Extension (popup.js)
        │
        │  POST /functions/v1/analyze
        ▼
Supabase Edge Function (Deno)
        │
        ├─ Claude Agent Loop (tool use)
        │     ├─ flag_mention()   × N   → flags each legal mention as present/missing
        │     └─ finalize()             → score, status, summary, relance_email
        │
        └─ Saves scan to scan_history table (Postgres + RLS)
```

The agent runs a **tool use loop** (up to 25 turns). In practice, Claude batches all `flag_mention()` calls + `finalize()` in a single turn (~11s latency). No regex, no JSON parsing — structured output via function calling.

## Tech Stack

- **Chrome Extension** — MV3, vanilla JS
- **Supabase Edge Functions** — Deno/TypeScript, deployed serverlessly
- **Claude Haiku** — agent loop with two tools: `flag_mention` + `finalize`
- **Supabase Postgres** — scan history with Row Level Security
- **LangSmith (EU)** — observability, latency tracking per run

## Project Structure

```
├── extension/
│   ├── manifest.json      # MV3 Chrome extension config
│   ├── popup.html         # Extension UI
│   ├── popup.js           # Main logic: upload, call Edge Fn, render results
│   └── content.js         # PDF text extraction from active tab
│
├── supabase/
│   ├── functions/
│   │   └── analyze/
│   │       └── index.ts   # Edge Function — Claude agent loop
│   └── schema.sql         # scan_history table + RLS policies
│
└── slides.html            # Architecture presentation (keyboard navigable)
```

## Setup

### 1. Supabase

```bash
# Deploy the Edge Function
supabase functions deploy analyze --project-ref <your-ref>

# Run schema in SQL editor
# → supabase/schema.sql
```

Set these secrets in Supabase Dashboard → Edge Functions → Secrets:
- `ANTHROPIC_API_KEY`
- `LANGSMITH_API_KEY` (optional)

### 2. Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder

## Key Design Decisions

**Tool use over prompt engineering** — instead of asking Claude to return JSON, the agent calls typed tools: `flag_mention(mention, present, detail)` and `finalize(score, status, summary, relance_email)`. This eliminates parsing failures.

**Batched tool calls** — Claude calls all 13+ `flag_mention()` tools + `finalize()` in a single response (turn=0). The agent loop exists as a safety net but is rarely needed.

**LangSmith EU endpoint** — traces go to `eu.api.smith.langchain.com` (required for EU-region accounts).

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Supabase secret | Required |
| `LANGSMITH_API_KEY` | Supabase secret | Optional — observability |

## Author

Soufiane Mejahed — built as a demonstration of Claude agent architecture in a real product context.
