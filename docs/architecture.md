# Architecture

How Growth Factory fits together, in five diagrams. The same diagrams, drawn for the web, are on the website's [architecture page](https://growth-factory-landing.vercel.app/architecture); their source is `landing-page/site/diagrams.mjs`. Keep the two in step when the system changes.

Deeper references: [cloud state](cloud-state.md), [posting server](posting-server.md), [billing](billing.md), and the [user guide](guide/README.md).

## System context

The app does the heavy work on your computer and keeps your library there. It talks to the Growth Factory cloud only for sign-in, posting and billing, and to cloud models only if you add your own key.

```mermaid
flowchart LR
  you(["You<br/>creator or team"])
  web["Website<br/>docs, pricing, Checkout pages"]
  subgraph computer["Your computer"]
    app["Growth Factory app<br/>window, engine, library"]
    local["Local AI and media<br/>Ollama, Whisper, FFmpeg"]
  end
  ai["Cloud models, optional<br/>OpenRouter, Groq; your own key"]
  cloud["Growth Factory cloud<br/>Supabase: sign-in, posting, billing"]
  stripe["Stripe<br/>Checkout, billing portal"]
  zernio["Zernio<br/>posting partner"]
  platforms["7 social platforms"]

  you -->|Approve and post| app
  you -->|Read, choose a plan| web
  app -->|Transcribe, see, render| local
  app -.->|Text; frames if allowed| ai
  app <-->|Session, plan, posts| cloud
  cloud <-->|Subscriptions| stripe
  cloud -->|Publish| zernio
  zernio --> platforms
```

## Containers

Inside the app, a native window shows the React interface, which calls the engine on `127.0.0.1` with a per-launch session. The engine runs one heavy job at a time. In the cloud, two Supabase Edge Functions hold the only Zernio and Stripe secrets, and every table has row-level security.

```mermaid
flowchart TB
  subgraph appbox["Growth Factory app, on your computer"]
    window["App window<br/>pywebview: Cocoa, WebView2, Qt"]
    ui["Interface<br/>React, one bundled page"]
    engine["Engine<br/>FastAPI on 127.0.0.1, session-gated<br/>job queue"]
    agents["Agents<br/>Listen, Watch, Scout, Editor,<br/>Critic, Strategist, Builder"]
    tools["Local tools<br/>Ollama, Whisper, FFmpeg"]
    store[("Library<br/>SQLite and media files")]
    keys[("Key store<br/>system keychain")]
  end
  subgraph cloudbox["Growth Factory cloud (Supabase)"]
    auth["Auth<br/>email and password"]
    posting["posting function<br/>plan check, ownership, Zernio key"]
    billing["billing function<br/>Checkout, portal, webhooks, plan"]
    db[("Postgres with row-level security<br/>workspaces, posts, subscriptions")]
  end
  zernio["Zernio"]
  stripe["Stripe"]

  window -->|Shows| ui
  ui -->|Same-origin API| engine
  engine --> agents
  agents --> tools
  agents -->|Save| store
  engine --> keys
  engine --> auth
  engine -->|HTTPS + session| posting
  engine --> billing
  billing --> db
  posting --> db
  posting --> zernio
  billing <--> stripe
```

## Posting flow

Only an approved clip can be posted. The engine asks the posting function, which checks the plan and ownership, uploads the media to Zernio and creates the post. Zernio's signed webhooks record the outcome, and the engine reads status and results back. Details: [posting server](posting-server.md).

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant App as App engine
  participant Fn as posting function
  participant DB as Postgres
  participant Z as Zernio
  participant P as Platform
  You->>App: Approve clip, choose accounts, post or schedule
  App->>Fn: Create post (session)
  Fn->>DB: Check plan, ownership, Posting Limits
  Fn->>Z: Presigned upload, then create post
  Z->>P: Publish
  Z-->>Fn: Signed webhook: published or failed
  Fn->>DB: Record status and link
  App->>Fn: Read status and results
  Fn-->>App: Status, link, metrics
```

Scheduled posts are sent by the app at their time, so the app must be open; a missed time waits for you instead of posting late.

## Learning loop

Every clip is checked before you see it, and nothing posts or changes your Style rules without your approval.

```mermaid
flowchart LR
  footage["Footage in"] --> listen["Listen<br/>transcript"] --> watch["Watch<br/>what is on screen"] --> scout["Scout swarm<br/>candidate moments"] --> editor["Editor<br/>hook, cut, captions"]
  editor --> critic["Critic + gate<br/>checks every clip"] --> approve(["You approve"]) --> post["Post<br/>7 platforms"] --> measure["Measure<br/>views, engagement"] --> strategist["Strategist<br/>patterns, not proof"]
  strategist --> rules(["Style rules<br/>you approve updates"])
  rules -->|Next clips| scout
  critic -.->|Missing skill| builder["Factory builder<br/>gap, work order, build, your review"]
```

## Billing flow

The app opens Stripe Checkout in your browser. Stripe's signed webhook is the only thing that changes a plan; the return pages on the website just tell you to go back to the app, which re-checks the plan. Details: [billing](billing.md).

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant App as App
  participant Fn as billing function
  participant S as Stripe Checkout
  participant Web as Website
  participant DB as Postgres
  You->>App: Upgrade
  App->>Fn: Start Checkout (session, plan, interval)
  Fn-->>App: Session URL
  App->>S: Open in browser
  S->>Web: Paid: /billing/success
  S-->>Fn: Signed webhook
  Fn->>DB: Record subscription and plan
  App->>Fn: Re-check plan on focus
  Fn-->>App: Plan and Plan Limits
```

## Principles

- **Local first.** Media, models and the library stay on your computer; cloud use is named before it happens.
- **Approval gates.** Export, posting and Style rules changes all need your approval of the exact revision.
- **Secrets stay server-side.** The Zernio and Stripe keys live only in the cloud functions; the app holds a publishable key and your session.
- **Row-level security everywhere.** Every cloud table is scoped to its workspace, with SQL probes in `supabase/tests/`.
- **Plans are data.** One catalog drives the app, the functions and the website, and tests keep them equal.
- **Nothing is deleted on a downgrade.** Limits block creating more, never what you already have.
