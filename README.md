# 🧠 Second Brain AI

An intelligent, local-first, voice-enabled personal knowledge base and external memory. Built with Next.js 16 (App Router), React 19, SQLite, and powered by Groq LLM services (Llama-3.3-70b and Whisper-large-v3).

---

## 🚀 Key Features

- **Local-First & SQLite-Backed**: All notes, relationships, entities, and memories are stored locally in a SQLite database (`secondbrain.db`) with WAL journal mode enabled for high performance.
- **AI-Powered Memory Parsing**: Text input is automatically parsed using `Llama-3.3-70b-versatile` on Groq to extract structured attributes (importance, domain, entities, temporal metadata, and intent).
- **Voice Transcription**: Record audio memories directly from the UI. Voice is captured in WebM format and transcribed instantly using Groq's `whisper-large-v3`.
- **Hybrid Relevance Search & Q&A**: 
  - *Retrieval*: Query memories using a hybrid of client-side TF-IDF similarity and LLM-synthesized context responses.
  - *Ask Mode*: Converse with your personal external memory and receive concise, grounded answers.
- **Smart Duplicate Detection**: Run local TF-IDF cosine-similarity calculations to group similar or duplicate memories and merge or clean them up in one click.
- **Minimalist Nothing Phone Aesthetics**: Styled with a dark-mode, high-contrast, dot-grid layout reminiscent of Nothing Phone UI.

---

## 🛠️ Tech Stack & Architecture

- **Frontend**: React 19 (Hooks, custom swipe-to-delete behaviors, audio-recorder state), Tailwind CSS v4, Geist Mono font.
- **Backend (API)**: Next.js 16 App Router.
- **Database**: SQLite (`better-sqlite3`) with custom migrations and indexes.
- **AI Orchestration**: Groq SDK for chat completions (Llama-3.3) and transcription (Whisper).

```
second-brain/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── items/        # CRUD endpoints for memories (GET, PUT, PATCH, DELETE)
│   │   │   ├── parse/        # Text analysis & parsing
│   │   │   ├── search/       # Semantic embedding search (Pre-filtered)
│   │   │   └── transcribe/   # Audio file processing
│   │   ├── globals.css       # Nothing Phone dot-grid theme & custom keyframes
│   │   ├── layout.tsx        # Base App wrapper
│   │   └── page.tsx          # Main Single Page App (Input, list, search result, modals)
│   ├── components/
│   │   ├── MemoryCard.tsx    # Single memory card (swipe/long-press actions)
│   │   ├── DuplicateModal.tsx
│   │   ├── EditModal.tsx
│   │   └── types.ts
│   └── lib/
│       ├── db.ts             # SQLite helper and entity-linking logic
│       ├── groq.ts           # LLM interaction methods
│       ├── vector.ts         # cosine similarity (single source of truth)
│       └── tfidf.ts          # Client-side TF-IDF tokenization & duplicate detection
├── ingest_test.py            # Local bulk-import test script
└── secondbrain.db            # Local SQLite database
```

---

## 💾 Database Schema

The database consists of 5 main tables to support structured query, relational graphs, and vector-filtering:

| Table | Purpose | Main Columns |
| :--- | :--- | :--- |
| **`items`** | Holds parsed memories | `id`, `content`, `raw_text`, `type`, `domain`, `importance`, `usage_count`, `time_ref`, timestamps |
| **`entities`** | Extracted knowledge nodes | `id`, `name`, `normalized_name`, `type` (`place`, `person`, `concept`, `movie`) |
| **`item_entities`** | M-N links between items and entities | `item_id`, `entity_id`, `confidence` |
| **`edges`** | Relationships / Graph edges | `id`, `source_id`, `target_id`, `source_type`, `target_type`, `edge_type` |
| **`embeddings`** | Semantic vectors for memories | `id`, `owner_id`, `owner_type`, `vector` (64-dim float array), `model` |

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have Node.js (v18+) and npm installed.

### 2. Environment Setup
Create a `.env.local` file in the root directory and add your Groq API Key:
```env
GROQ_API_KEY=your_groq_api_key_here
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Running the App
Start the development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🧪 Testing Ingestion

You can run the ingestion script to populate your database with dummy memories:
```bash
python ingest_test.py
```

---

## 🔍 Quality Control & Audit Summary

A recent quality control audit was conducted on the project codebase, resulting in the following fixes and findings:

### 1. Fixed Critical React 19 & ESLint Errors
- **Ref access during render**: In the `MemoryCard` component, the `isTouchDevice.current` reference was read directly in the render path. This has been resolved by converting it to a standard React `useState` hook (`isTouchDevice`), ensuring UI updates are correctly tracked.
- **Synchronous setState in Effect**: In the `Home` component, `setTotalTokens` was being called synchronously inside `useEffect`. This was resolved by wrapping the invocation in a deferred `setTimeout` to avoid cascading render bottlenecks.

### 2. Fixed `ingest_test.py` Ingestion Script Bug
- The response keys returned by the `/api/parse` endpoint are top-level values (`type`, `domain`, `entities`). The python script was looking for a nested `"parsed"` object (i.e. `result.get("parsed")`), which resulted in `None | None | []` printed values.
- In addition, the script expected the `entities` array to contain dictionaries with a `"name"` key. The API actually returns an array of strings. The script has been updated to parse the fields directly and output the correct strings.

### 3. Known limitations (tracked in `PIANO.md`)
- **`/api/search`**'s embedding pre-filter is currently a stub: `getEmbedding()` asks the chat
  model to hallucinate a 64-float "semantic fingerprint" rather than using a real embedding
  model, so the vectors are not comparable across calls. Below 60 items the endpoint falls back
  to sending the entire corpus to the LLM either way. See `PIANO.md` Fase 2 for the fix
  (real local embeddings via transformers.js).
- The `edges` table currently only holds `item → entity (MENTIONS)` links; there are no
  item↔item edges yet, so graph traversal has nothing to traverse. See `PIANO.md` Fase 3.
- The old `/api/ask` endpoint (dead code, never called by the UI) has been removed.
