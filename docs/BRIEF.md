# Kenoki — Project Brief

## One line

Free, open-source relationship intelligence tool that turns your contacts into a queryable knowledge graph.

## Problem

People accumulate thousands of contacts across LinkedIn, phone, email, and events. No system connects them. CRMs are built for pipelines, not people. Spreadsheets die after a week. Memory is unreliable.

Result: you lose the context of who introduced you to who, what they need, who they know, and when to follow up.

## Solution

Kenoki gives your network a system.

1. **Import** contacts from any source (LinkedIn, iPhone, Google, Outlook, Facebook, CSV)
2. **See** your entire network as an interactive graph with automatic community detection
3. **Query** in plain language: "Who should I follow up with?" "Who works in VC?"
4. **Add** interactions by typing what happened — AI extracts structured data, you verify before saving

## How it works

- User signs up (Supabase auth, email/password)
- Uploads contacts (CSV, vCard, JSON, ZIP — auto-detected)
- Contacts populate a Supabase Postgres database with per-user row-level security
- Graph renders with vis-network + label propagation community detection
- AI (optional): Ollama (local/free), OpenAI, or Claude
- All data stays in the user's Supabase instance

## What it is NOT

- Not a sales CRM (no pipeline, no deals, no forecasting)
- Not a social network (no public profiles, no feeds)
- Not AI-dependent (works fully without AI — manual entry + graph browsing)
- Not a SaaS business (no subscription, no pricing tiers, no investor agenda)

## Architecture

```
4 static files (HTML + CSS + JS + tokens)
         ↓
Supabase Cloud (auth + Postgres + RLS)
         ↓
Optional AI (Ollama / OpenAI / Claude)
```

No server. No framework. No build step. No dependencies.

## Business model

Free. Open source (MIT). No ads. No tracking. No data collection.

Future: package as macOS/iOS native app via Electron/React Native. Potentially freemium for team features (shared graphs, introductions). Not decided yet — the product needs to be excellent before monetisation matters.

## Target users

- Sales professionals (network = pipeline)
- Founders & VCs (warm intros, deal flow)
- Recruiters (candidate + client networks)
- Consultants (referral paths, industry maps)
- Community builders (ecosystem visibility)
- Anyone who meets people for a living

## Current state

- Live at kenoki.app (Vercel)
- GitHub: github.com/shortalex12333/unified-terminal
- Auth: working (Supabase email/password)
- Import: LinkedIn (ZIP), iPhone (vCard), Google (CSV), Outlook (CSV), Facebook (JSON/HTML), generic CSV
- Graph: vis-network with community detection, 2000+ nodes
- AI chat: Ollama / OpenAI / Claude streaming
- Smart input: freeform text → AI extraction → verify → save
- Landing page: Spline 3D hero, scrollable sections, live demo graph

## What's next

- Test all import sources end-to-end with real data
- Voice input (Whisper transcription → AI parsing)
- Package as macOS/iOS app
- Open source community + contributions
- Product Hunt launch
