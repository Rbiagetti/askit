# 🧠 Second Brain AI

Un secondo cervello personale, local-first e a comando vocale: parli, lui capisce, ricorda e
ritrova. Next.js 16 (App Router), React 19, SQLite, Groq per LLM e trascrizione, embedding
locali.

**Costo di esercizio: 0 €/mese.** Le app commerciali equivalenti chiedono 20-35 €/mese.

---

## 🚀 Cosa fa

- **Cattura vocale** — registri, `whisper-large-v3` su Groq trascrive, il testo viene
  strutturato automaticamente (tipo, dominio, entità, data, importanza).
- **Date relative risolte davvero** — «ricordami di chiamare Marco domani alle 18» diventa un
  timestamp assoluto con fuso orario, e finisce nella vista calendario.
- **Retrieval sul grafo** — la ricerca non manda mai tutte le note al modello: costruisce il
  vicinato rilevante e spedisce solo quello. Il costo per operazione **non cresce** con il
  numero di note (misurato: 252 token con 20 note, 253,6 con 200).
- **Grafo della conoscenza** — le note si collegano fra loro per entità condivise, similarità
  semantica e, opzionalmente, relazioni ragionate dal modello (`DUPLICATES`, `CONTINUES`,
  `CONTRADICTS`, `RELATES_TO`).
- **Mirror markdown per Obsidian** — ogni nota viene proiettata in un file `.md` con
  frontmatter e `[[wikilink]]`, apribile come vault Obsidian con tanto di graph view.
- **Estetica Nothing Phone** — dark mode ad alto contrasto, dot-grid.

---

## 🏗️ Come funziona il retrieval

Il punto centrale del progetto. Quattro generatori di candidati girano **in locale, a costo
zero token**; solo i sopravvissuti alla fusione vedono l'LLM.

```
              query o nota nuova
                      │
      ┌───────────────┼───────────────┬───────────────┐
      ▼               ▼               ▼               ▼
 ① ancore        ② espansione     ③ kNN          ④ FTS5
   entità          sul grafo       vettoriale      lessicale
      │               │               │               │
      └───────────────┴───────┬───────┴───────────────┘
                              ▼
                  fusione RRF · taglio a 12 nodi
                              ▼
                          prompt LLM
```

Ogni risultato porta la propria *provenance* (quale generatore l'ha trovato e a che rank), utile
quando un risultato sorprende.

---

## 🛠️ Stack

- **Frontend**: React 19, Tailwind CSS v4, Geist Mono
- **Backend**: Next.js 16 App Router (route handlers)
- **Database**: SQLite via `better-sqlite3`, con FTS5 per la ricerca lessicale
- **LLM**: Groq SDK — `qwen/qwen3.6-27b` per parsing e ricerca, `openai/gpt-oss-120b` per il
  linking ragionato (opzionale), `whisper-large-v3` per la trascrizione
- **Embedding**: `@huggingface/transformers` in-process, modello
  `Xenova/multilingual-e5-small` (384 dim, multilingue). Nessuna chiamata di rete, 0 token.

```
second-brain/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── items/        # CRUD memorie (GET, PUT, PATCH, DELETE)
│   │   │   ├── parse/        # analisi, salvataggio, embedding, archi
│   │   │   ├── search/       # retrieval sul grafo + risposta LLM
│   │   │   ├── transcribe/   # audio -> testo
│   │   │   └── vault/        # rigenerazione del mirror markdown
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/           # MemoryCard, EditModal, DuplicateModal, types
│   └── lib/
│       ├── db.ts             # SQLite, migrazioni, entità
│       ├── embed.ts          # embedding locali (transformers.js)
│       ├── graph.ts          # archi item<->item
│       ├── groq.ts           # chiamate LLM
│       ├── markdown.ts       # export vault Obsidian
│       ├── retrieve.ts       # i 4 generatori + fusione RRF
│       ├── tfidf.ts          # duplicati lato client
│       └── vector.ts         # cosine similarity
├── scripts/
│   ├── backfill-embeddings.mjs
│   ├── export-vault.mjs
│   ├── rebuild-graph.mjs
│   └── seed-synthetic.mjs    # corpus sintetico per i benchmark
└── PIANO.md                  # progetto del refactor, con le misure
```

---

## 💾 Schema

| Tabella | Scopo | Colonne principali |
| :--- | :--- | :--- |
| **`items`** | Le memorie | `id`, `content`, `raw_text`, `type`, `domain`, `importance`, `usage_count`, `time_ref` |
| **`entities`** | Nodi entità | `id`, `name`, `normalized_name`, `type` |
| **`item_entities`** | Legami M-N | `item_id`, `entity_id`, `confidence` |
| **`edges`** | Archi del grafo | `source_id`, `target_id`, `edge_type`, `weight` — `MENTIONS`, `CO_OCCURS`, `SIMILAR_TO`, e i tipi ragionati |
| **`embeddings`** | Vettori | `owner_id`, `vector` (384 float), `model`, `dim` |
| **`items_fts`** | Indice FTS5 | tabella virtuale external-content su `items` |

---

## 🚀 Avvio

### 1. Requisiti
Node.js 18+ e npm.

### 2. Variabili d'ambiente
Crea `.env.local`:

```env
GROQ_API_KEY=la_tua_chiave

# opzionali
SB_TIMEZONE=Europe/Rome           # fuso per risolvere le date relative
VAULT_PATH=~/second-brain-vault   # dove generare il mirror markdown
SB_REASONED_LINKING=0             # 1 per attivare gli archi ragionati (vedi sotto)
SB_DB_PATH=                       # per puntare a un DB diverso (benchmark)
```

### 3. Installazione e avvio

```bash
npm install
npm run dev
```

Al primo avvio il modello di embedding (~120 MB) viene scaricato una volta sola.

### 4. Se hai già un database

```bash
npm run embeddings:backfill   # genera i vettori mancanti
npm run graph:rebuild         # costruisce gli archi item<->item
npm run vault:export          # genera la vault markdown (serve l'app avviata)
```

---

## ⚙️ Limiti del free tier Groq

| Limite | Valore | Conseguenza |
| :--- | :--- | :--- |
| Richieste/minuto | 30 | mai raggiunto in uso personale |
| Token/minuto | 8.000 | il retrieval sul grafo tiene il contesto a ~250 token |
| **Output token/minuto** | **1.000** | il più stringente: `max_tokens` è una *prenotazione* contro questo limite, non solo un tetto |
| Token/giorno | 200.000 | ~135 operazioni al giorno |

Per questo `SB_REASONED_LINKING` è disattivato di default: i token di reasoning contano
sull'OTPM, e il parsing di una nota ne prenota già 500. `CO_OCCURS` e `SIMILAR_TO` producono
comunque un grafo utilizzabile a costo zero.

---

## 📝 La vault markdown

È un **mirror in sola lettura**: la fonte di verità è SQLite. Modificare un file a mano non ha
effetto, viene sovrascritto al prossimo export. In cambio non c'è nessun sistema di
sincronizzazione da mantenere, e ottieni portabilità, `git diff` leggibili e la graph view di
Obsidian gratis.

Le note vengono rispecchiate a ogni scrittura; `npm run vault:export` fa la rigenerazione
completa. Puoi versionare la vault con un `git init` al suo interno, separato da questo repo.

---

## 🧪 Benchmark

Il criterio di progetto è che il costo del retrieval non dipenda dalla dimensione del corpus:

```bash
sqlite3 secondbrain.db "VACUUM INTO '/tmp/bench.db'"
SB_DB_PATH=/tmp/bench.db node scripts/seed-synthetic.mjs 200
SB_DB_PATH=/tmp/bench.db node scripts/rebuild-graph.mjs
# poi punta l'app a /tmp/bench.db e interroga /api/search con {"dryRun": true}
```
