# Kenoki

Open-source relationship intelligence. Import your contacts, see your network as a graph, ask questions with AI.

**Live at [kenoki.app](https://kenoki.app)**

---

## What it does

You have thousands of contacts across LinkedIn, your phone, email, and events. You can't search them. You can't see how they connect. You can't ask "who should I follow up with?" and get an answer.

Kenoki fixes that.

1. **Import** — Upload contacts from LinkedIn, iPhone, Google, Outlook, Facebook, or any CSV. Drop the file, we handle the rest.
2. **Visualise** — Your entire network rendered as an interactive graph. Community detection clusters people who are connected. Hover for details.
3. **Query** — Ask questions in plain language. "Who works at Stripe?" "Who should I reconnect with?" "Who do Sarah and James both know?" Answers come from your data, not the internet.
4. **Add** — After any meeting, type what happened. AI extracts the person, company, relationship, and next action. You verify before saving. Or add manually — no AI required.

## Who it's for

Anyone who takes relationships seriously. Sales professionals, founders, recruiters, VCs, consultants, community builders.

## Stack

```
index.html     — app shell + landing page
app.css        — design system (CelesteOS tokens)
app.js         — all logic: auth, graph, chat, import, smart input
tokens.css     — design tokens (surfaces, text, brand, signals, borders)
```

No framework. No build step. No dependencies. 4 files.

- **Backend:** Supabase (auth + Postgres + row-level security)
- **Graph:** vis-network + label propagation community detection
- **AI:** Ollama (local, free) / OpenAI / Claude — or skip AI entirely

## Run locally

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

## Import sources

| Source | Format | What to upload |
|--------|--------|----------------|
| LinkedIn | CSV / ZIP | Settings → Data Privacy → Download Data. Upload the whole ZIP. |
| iPhone | vCard (.vcf) | icloud.com/contacts → Select all → Export vCard |
| Google | CSV | contacts.google.com → Export → Google CSV |
| Outlook | CSV | People → Manage → Export contacts |
| Facebook | JSON or HTML | Settings → Download Your Information → Friends. Upload the ZIP. |
| Any CSV | CSV | Any spreadsheet with a "Name" column |

Duplicate detection built in. Re-importing merges new data into existing contacts.

## AI providers

AI is optional. Kenoki works without it.

| Provider | Cost | Setup |
|----------|------|-------|
| Ollama | Free | Install locally, no API key |
| OpenAI | Pay per use | Paste API key |
| Claude | Pay per use | Paste API key |
| None | Free | Skip AI, add contacts manually |

## Privacy

- No tracking, no analytics, no data collection
- Your contacts stay in your Supabase instance
- AI calls go directly from your browser to the provider
- Open source — read every line
- Free forever

## Docs

- [Launch playbook](docs/launch-playbook.html) — where to post, what to say, in what order

## Repo structure

```
/              — Kenoki app (index.html, app.css, app.js, tokens.css)
/img/          — logos + LinkedIn guide screenshots
/docs/         — launch playbook + project docs
/archive/      — previous landing page (preserved)
```

## License

MIT

---

Built by [Alex Short](https://linkedin.com/in/short-alex). Free forever.
