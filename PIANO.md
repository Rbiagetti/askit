# Piano di implementazione — Retrieval sul grafo

> Obiettivo: smettere di mandare l'intero corpus all'LLM ad ogni operazione.
> Il contesto inviato deve dipendere dal **vicinato nel grafo**, non dalla dimensione totale del database.
> Vincolo di progetto: restare dentro il free tier Groq (30 req/min, 8.000 token/min, 200.000 token/giorno).

Data: 12 settembre 2026 · Stato: approvato in linea di principio, non ancora implementato

---

## 1. Stato attuale verificato

Tutto quanto segue è stato verificato leggendo il codice e interrogando `secondbrain.db`, non è stimato.

### 1.1 Il grafo non è un grafo

```
sqlite> SELECT edge_type, source_type, target_type, COUNT(*) FROM edges GROUP BY 1,2,3;
MENTIONS|item|entity|13
```

L'unico tipo di arco che esiste è `item → entity (MENTIONS)`, scritto in
[`src/app/api/parse/route.ts`](src/app/api/parse/route.ts) e duplicato in
[`src/app/api/items/route.ts`](src/app/api/items/route.ts) (handler `PUT`).
**Non esiste un solo arco item↔item.** La topologia è una stella: ogni nota punta alle
sue entità e nessuna nota conosce le altre. Non c'è niente da attraversare.

### 1.2 Il retrieval semantico è finto e non è mai stato attivo

Tre difetti sovrapposti, in ordine di gravità:

| # | Dove | Problema |
|---|---|---|
| 1 | [`src/lib/groq.ts:128`](src/lib/groq.ts:128) | `getEmbedding()` chiede a un LLM di «generare 64 float che catturano il significato». Un modello generativo **non può** produrre embedding coerenti così: i numeri sono inventati e non confrontabili fra chiamate. |
| 2 | [`src/lib/groq.ts:154`](src/lib/groq.ts:154) | Il `catch` restituisce `Math.random()`. Un fallimento di parsing produce silenziosamente **rumore puro** indistinguibile da un vettore valido. |
| 3 | [`src/lib/db.ts:154`](src/lib/db.ts:154) | `saveEmbedding()` **non è mai chiamata da nessuna parte.** |

Conseguenza misurata: la tabella `embeddings` contiene **1 riga per 7 item**. Quindi in
[`src/app/api/search/route.ts:37-52`](src/app/api/search/route.ts:37) `getAllEmbeddings()` torna
sostanzialmente vuota, ogni `score` vale `0`, l'ordinamento non cambia nulla e il presunto
«pre-filtro semantico sopra le 60 note» degrada in silenzio a **«le prime 40 note per data»**.
Non è un pre-filtro degradato: è un `LIMIT 40` con un costo LLM sopra.

### 1.3 Il dump completo del corpus

- [`src/app/api/search/route.ts:34-36`](src/app/api/search/route.ts:34): sotto le 60 note viene
  passato **tutto** il corpus nel prompt. Sopra le 60, vedi 1.2 — sono comunque 40 note intere.
- [`src/app/api/ask/route.ts`](src/app/api/ask/route.ts): riceve l'array `memories` **dal client**.
  Era il browser a spedire l'intero elenco ad ogni domanda.

### 1.4 Bug di correttezza collaterali

- **Date relative non risolvibili.** `PARSE_SYSTEM` in [`src/lib/groq.ts:31`](src/lib/groq.ts:31)
  dice «assume current year 2026, current date context» ma **la data corrente non viene mai
  iniettata nel prompt**. «Domani alle 18» non è risolvibile: il modello non sa che giorno è oggi.
  Questo rende inaffidabile `time_ref`, e quindi la modalità calendario della UI.
- **Leak di entità orfane.** `deleteItem()` in [`src/lib/db.ts:201`](src/lib/db.ts:201) cancella
  item, archi ed embedding, e il `CASCADE` pulisce `item_entities` — ma le righe in `entities`
  restano per sempre. Riscontro: **47 entità per 7 item, con solo 13 link**. 34 entità sono orfane.
  Sporcano l'anchor lookup della Fase 2 e vanno pulite prima, non dopo.

### 1.5 Codice morto

| Simbolo | File | Nota |
|---|---|---|
| tutto l'endpoint | [`src/app/api/ask/route.ts`](src/app/api/ask/route.ts) | mai chiamato; la UI dichiara «ask mode eliminated» in [`page.tsx:257`](src/app/page.tsx:257). Istanzia un proprio client Groq. |
| `getRelatedItems()` | [`src/lib/db.ts:208`](src/lib/db.ts:208) | mai chiamata — ironicamente è l'unica traversata di grafo già scritta |
| `getItemById()` | [`src/lib/db.ts:187`](src/lib/db.ts:187) | mai chiamata |
| `saveEmbedding()` | [`src/lib/db.ts:154`](src/lib/db.ts:154) | mai chiamata (vedi 1.2) |
| `rankByRelevance()` | [`src/lib/tfidf.ts:44`](src/lib/tfidf.ts:44) | mai chiamata |
| `cosineSimilarity()` | [`groq.ts:157`](src/lib/groq.ts:157) + [`tfidf.ts:33`](src/lib/tfidf.ts:33) | duplicata in due file |

---

## 2. Architettura target

### 2.1 Il principio

Oggi il costo per operazione cresce con la dimensione del corpus. Deve invece crescere con la
**densità del vicinato**, che è limitata per costruzione.

```
                    OGGI                              TARGET
        ┌─────────────────────────┐        ┌──────────────────────────┐
input → │ TUTTE le note (o top 40)│ → LLM  │ recupero vicinato (SQL)  │
        └─────────────────────────┘        │   ≤ 12 nodi rilevanti    │ → LLM
        costo ∝ dimensione corpus          └──────────────────────────┘
                                            costo ≈ costante
```

### 2.2 La pipeline di retrieval

Quattro generatori di candidati che girano **in SQL/locale a costo zero token**, fusi e troncati.
Solo il risultato finale vede l'LLM.

```
              query o nota nuova
                      │
      ┌───────────────┼───────────────┬───────────────┐
      ▼               ▼               ▼               ▼
 ① ancore        ② espansione     ③ kNN          ④ FTS5
   entità          sul grafo       vettoriale      lessicale
 normalized_name   1–2 hop su      embedding       match esatto
 → item_entities   edges           reale, locale   (nomi, sigle)
      │               │               │               │
      └───────────────┴───────┬───────┴───────────────┘
                              ▼
                   fusione RRF  score = Σ 1/(60 + rank)
                              ▼
                    taglio a K = 12 nodi
                              ▼
                        prompt LLM
```

Perché tutti e quattro:

- **① ancore entità** — precisione alta: se la nota nomina «Interstellar», le note su Interstellar
  sono rilevanti con certezza, senza margine di errore semantico.
- **② espansione sul grafo** — è il punto dell'intera richiesta: raggiunge note che non condividono
  né parole né entità con la query, ma sono a un hop da qualcosa che le condivide.
- **③ kNN vettoriale** — copre la parafrasi: «voglio rivedere Interstellar» ↔ «mi è piaciuto
  Inception» non condividono entità ma sono vicine nello spazio semantico.
- **④ FTS5** — copre il caso opposto, dove gli embedding sono deboli: nomi propri rari, sigle,
  numeri, termini fuori distribuzione.

La fusione è **Reciprocal Rank Fusion**: `score(d) = Σᵢ 1/(60 + rankᵢ(d))`. Si sceglie perché
combina ranking con scale di punteggio incomparabili (cosine vs BM25 vs hop count) senza
normalizzazioni né pesi da tarare a mano.

### 2.3 Embedding reali, locali, a zero token

Groq non espone un endpoint di embedding. Si usa **`@huggingface/transformers`** (transformers.js v3)
in-process nel runtime Node di Next.

- Modello: **`Xenova/multilingual-e5-small`** — 384 dimensioni, multilingue.
  La scelta multilingue non è opzionale: le note sono in italiano e i modelli
  solo-inglese (`all-MiniLM-L6-v2`) degradano molto fuori dall'inglese.
- Convenzione E5, obbligatoria e facile da sbagliare: i documenti vanno prefissati
  `"passage: "`, le query `"query: "`. Senza prefissi la qualità crolla.
- Costo: **0 token Groq**, nessuna rete a runtime, ~120 MB scaricati una volta sola.
  Coerente con il local-first del progetto.
- Il runtime deve essere `nodejs`, non `edge`.

---

## 3. Fasi

Ordine obbligato: la Fase 1 pulisce il terreno, la 2 sostituisce le fondamenta finte,
la 3 costruisce il grafo, la 4 lo usa. Non si può invertire 3 e 4 — senza archi item↔item
il retrieval sul grafo non ha nulla da attraversare.

---

### Fase 0 — Pulizia repository

Nessuna modifica funzionale. Serve a non portarsi dietro rumore nelle fasi successive.

**Da eliminare:**

- `src/app/api/ask/route.ts` — endpoint morto (§1.5)
- `getRelatedItems()`, `getItemById()` da `src/lib/db.ts` — morte. *Nota:* la logica di
  `getRelatedItems` non va buttata, va riusata come base per `expandNeighborhood()` in Fase 4.
- `rankByRelevance()` da `src/lib/tfidf.ts` — morta
- `cosineSimilarity` da `src/lib/groq.ts` — tenere una sola copia, in `src/lib/vector.ts` (Fase 2)
- `public/next.svg`, `public/vercel.svg`, `public/file.svg`, `public/globe.svg`, `public/window.svg`
  — boilerplate Next.js, nessuno referenziato

**Da correggere:**

- `README.md` — dichiara `components/` «currently empty» (sono 4 componenti), documenta la
  Ask Mode rimossa, pubblicizza la ricerca semantica che non funziona (§1.2), indica
  Llama-3.3-70b mentre il codice usa `qwen/qwen3.6-27b`, documenta `ingest_test.py` che è gitignored.
  Riscrivere dopo la Fase 4, non ora, per non doverlo fare due volte.
- `secondbrain.db-wal` è **4,0 MB** contro un DB di 256 KB: WAL mai checkpointato.
  `PRAGMA wal_checkpoint(TRUNCATE);` una tantum.
- `.claude/` non tracciata: decidere se committarla o aggiungerla a `.gitignore`.

**Manutenzione dati (una tantum, prima della Fase 2):**

```sql
DELETE FROM entities
WHERE id NOT IN (SELECT entity_id FROM item_entities);   -- attese ~34 righe
DELETE FROM embeddings;                                   -- l'unica riga è rumore inventato
```

---

### Fase 1 — Correttezza: date ed entità orfane

Due bug indipendenti dal retrieval, ma che lo inquinano se lasciati.

**1a. Iniettare la data corrente nel parsing** — `src/lib/groq.ts`

Rimuovere l'anno hardcoded dal system prompt e passare il contesto temporale reale:

```ts
export async function parseMemory(text: string, now = new Date()): Promise<ParsedMemory> {
  // nel messaggio user, non nel system prompt (cache-friendly):
  // `Current datetime: ${now.toISOString()} (${tz})\nWeekday: ${...}\n\n${text}`
}
```

Il modello deve restituire `time.datetime` come **ISO 8601 assoluto**, mai relativo.

**1b. Chiudere il leak di entità** — `src/lib/db.ts`

In `deleteItem()`, dopo la cancellazione, rimuovere le entità rimaste senza link:

```sql
DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM item_entities);
```

**1c. Deduplicare la logica di entity-linking**

`parse/route.ts` e l'handler `PUT` di `items/route.ts` contengono lo stesso blocco copiaincollato.
Estrarre in `src/lib/db.ts`:

```ts
export function syncItemEntities(
  itemId: string,
  entities: Array<{ name: string; type: string }>
): string[]   // ritorna i nomi, sostituendo i link preesistenti
```

**Criterio di accettazione:** salvare «ricordami di chiamare Marco domani alle 18» produce un
`time_ref` ISO che cade effettivamente domani alle 18:00; cancellare quella nota non lascia
l'entità «Marco» orfana in tabella.

---

### Fase 2 — Embedding reali

Sostituisce integralmente il meccanismo finto di §1.2.

**Nuovo file `src/lib/embed.ts`:**

```ts
// singleton della pipeline: il modello si carica una volta sola per processo
export async function embed(text: string, kind: "query" | "passage"): Promise<Float32Array>
export async function embedBatch(texts: string[], kind: "passage"): Promise<Float32Array[]>
```

**Nuovo file `src/lib/vector.ts`:** unica implementazione di `cosineSimilarity`, più
`serializeVector` / `deserializeVector`.

**Modifiche a `src/lib/db.ts`:**

- `saveEmbedding()` va effettivamente **chiamata**: in `parse/route.ts` dopo `createItem`,
  e nel `PUT` di `items/route.ts` dopo l'update (con `DELETE` del vettore precedente).
- Salvare `model: "multilingual-e5-small"` e una colonna `dim`, per poter invalidare in blocco
  se un giorno si cambia modello.

**Script di backfill** `scripts/backfill-embeddings.ts`: rigenera i vettori per tutti gli item
esistenti. Da eseguire una volta dopo il `DELETE FROM embeddings` della Fase 0.

**Dipendenza:** `npm i @huggingface/transformers`.
Verificare in `node_modules/next/dist/docs/` come questa versione di Next tratta i pacchetti nativi
lato server (`serverExternalPackages` in `next.config.ts`) — vale già per `better-sqlite3`.

**Criterio di accettazione:** due note parafrasi l'una dell'altra hanno cosine > 0.8; due note su
argomenti scorrelati < 0.4. Ripetere l'embedding dello stesso testo dà lo stesso vettore
(oggi, con `Math.random()`, non è vero).

---

### Fase 3 — Costruire archi item↔item

Senza questa fase la Fase 4 non ha grafo da percorrere (§1.1).

**3a. Archi automatici, zero costo LLM**

Alla scrittura di una nota, creare `CO_OCCURS` fra item che condividono **≥ 2 entità**,
con `weight` = numero di entità condivise. È puro SQL, deterministico, gratis.

**3b. Archi semantici, zero costo LLM**

Creare `SIMILAR_TO` verso i top-3 vicini per cosine, se sopra soglia (~0.75), con `weight` = score.

**3c. Archi ragionati, costo LLM controllato**

Solo qui interviene il modello, e **solo sui ≤ 12 candidati** già selezionati dalla pipeline §2.2 —
mai sull'intero corpus. Il modello decide quali candidati sono davvero collegati e con che
relazione: `RELATES_TO`, `CONTINUES`, `CONTRADICTS`, `DUPLICATES`.

Qui `reasoning_effort` va alzato (oggi è `"none"` ovunque, [`groq.ts:47`](src/lib/groq.ts:47)):
è l'unico punto del sistema dove serve ragionamento strutturale vero. Modello consigliato:
`openai/gpt-oss-120b`, che ha reasoning nativo, oppure `qwen/qwen3.6-27b` con thinking attivo.

**Nuovo file `src/lib/graph.ts`:**

```ts
export function linkCoOccurring(itemId: string): number
export function linkSimilar(itemId: string, vec: Float32Array): number
export async function linkReasoned(itemId: string, candidates: Candidate[]): Promise<Edge[]>
```

**Migrazione:** aggiungere `UNIQUE(source_id, target_id, edge_type)` su `edges` — altrimenti
rieseguire il linking duplica gli archi ad ogni `PUT`. Serve anche un indice su
`item_entities(entity_id)` per la traversata inversa, oggi assente
([`db.ts:71-76`](src/lib/db.ts:71) indicizza solo `edges.source_id`/`target_id`).

**Criterio di accettazione:** `SELECT edge_type, COUNT(*) FROM edges GROUP BY 1` mostra archi
`item→item`, non solo `MENTIONS`. Da 7 note con temi sovrapposti devono emergere almeno alcuni
`CO_OCCURS`.

---

### Fase 4 — Retrieval sul grafo

Il cuore. Sostituisce §1.3.

**Nuovo file `src/lib/retrieve.ts`:**

```ts
export interface RetrievalResult {
  items: RetrievedItem[];      // ≤ K, ciascuno con provenance
  tokenEstimate: number;
  sources: { anchors: number; graph: number; vector: number; fts: number };
}

export async function retrieve(
  input: string,
  opts: { k?: number; hops?: 1 | 2; forItemId?: string } = {}
): Promise<RetrievalResult>
```

Implementazione dei quattro generatori di §2.2:

1. **Ancore** — estrarre entità dall'input, match su `entities.normalized_name`,
   risalire a `item_entities`.
2. **Espansione** — da quegli item, 1–2 hop su `edges` (riusare la query di `getRelatedItems`
   salvata in Fase 0), pesando per `weight` e penalizzando per distanza (`weight / hop`).
3. **kNN** — `embed(input, "query")`, cosine su tutti i vettori. A scala personale (< ~10k note)
   la forza bruta in JS è più che sufficiente; `sqlite-vec` solo se un giorno servirà.
4. **FTS5** — nuova tabella virtuale, mantenuta da trigger:

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  content, raw_text, content='items', content_rowid='rowid', tokenize='unicode61'
);
-- + trigger AFTER INSERT/UPDATE/DELETE ON items
```

Poi fusione RRF, taglio a `k = 12`, ritorno con provenance (utile per capire *perché* una nota
è stata pescata quando il risultato sorprende).

**Riscrittura di `src/app/api/search/route.ts`:** eliminare la soglia delle 60 note e il
top-40 finto. Diventa `retrieve(query)` → `searchWithLLM(query, result.items)`, **sempre**,
indipendentemente dalla dimensione del corpus.

**Aggancio in `parse/route.ts`:** prima di rispondere, `retrieve(text, { forItemId })`, poi
Fase 3c sui candidati. Questo dà in regalo il rilevamento duplicati **al momento
dell'inserimento**, che oggi richiede invece un passaggio manuale O(n²) TF-IDF nel browser
([`page.tsx:155`](src/app/page.tsx:155)).

**Criterio di accettazione, misurabile:** con 200 note sintetiche, i token del prompt per una
ricerca devono restare entro ±20% rispetto agli stessi con 20 note. Se crescono
proporzionalmente, la fase è fallita.

---

### Fase 5 — Mirror markdown per Obsidian *(scelta: opzione C)*

**Decisione presa:** SQLite resta la **fonte di verità**; la vault markdown è un **mirror in sola
lettura**, rigenerato dall'app. Nessun file watcher, nessuna scrittura di ritorno, nessuna
risoluzione di conflitti. Si guadagna portabilità, backup con `git diff` leggibili e la graph view
di Obsidian gratis, senza la tassa permanente della sincronizzazione bidirezionale.

Se un giorno emergesse il bisogno reale di editare da Obsidian, l'upgrade a bidirezionale è
incrementale: lo schema dei file è già definito qui.

**Posizione della vault:** fuori dal repo, via `VAULT_PATH` in `.env.local`
(default `~/second-brain-vault`). Motivo: è dato personale, come `secondbrain.db` che è già
gitignored. Così l'utente può versionarla con un `git init` suo, separato dal repo dell'app.
Aggiungere comunque `vault/` a `.gitignore` per sicurezza.

**Nuovo file `src/lib/markdown.ts`:**

```ts
export async function exportItem(itemId: string): Promise<void>   // incrementale, su ogni scrittura
export async function exportAll(): Promise<{ written: number; deleted: number }>
```

**Struttura della vault:**

```
~/second-brain-vault/
├── README.md                    ← "generata automaticamente, non editare qui"
├── .index.json                  ← mappa itemId → filename corrente
├── notes/
│   └── vorrei-rivedere-interstellar--a3f2b81c.md
└── entities/
    └── Interstellar.md          ← stub, rende le entità nodi hub nel grafo
```

**Nome file:** `{slug(content, 60)}--{id[0:8]}.md`. Lo slug lo rende leggibile in Obsidian, il
suffisso con l'id lo rende univoco. `.index.json` traccia il nome corrente di ogni item, così un
`PUT` che cambia il summary provoca un **rename** (non un duplicato) e un `DELETE` rimuove il file
giusto.

**Formato di un file:**

```markdown
---
id: a3f2b81c-...
type: wishlist
domain: cinema
importance: 0.7
created: 2026-09-12T18:04:00Z
updated: 2026-09-12T18:04:00Z
time_ref: null
entities: [Interstellar, Nolan]
---

Vorrei rivedere Interstellar.

> [!quote] Testo originale
> mi sa che mi rivedo interstellar sto weekend

## Collegate
- [[ho-adorato-inception--7b2e91f0]] — SIMILAR_TO (0.84)
- [[maratona-nolan--1c8d4a22]] — RELATES_TO

## Entità
- [[Interstellar]]
- [[Nolan]]
```

Gli archi item↔item della Fase 3 diventano `[[wikilink]]`, e le entità diventano pagine stub: è
questo che dà a Obsidian un grafo vero da disegnare, con le entità come hub. I metadati che il
wikilink non può portare (`edge_type`, `weight`) restano annotati in chiaro accanto al link e in
forma autorevole in SQLite.

**Aggancio:** `exportItem()` chiamata dopo ogni scrittura in `parse/route.ts` e negli handler
`PUT`/`DELETE` di `items/route.ts` — è I/O su un solo file, costo trascurabile. Più uno script
`npm run vault:export` che invoca `exportAll()` per la rigenerazione completa.

**Criterio di accettazione:** aprire `VAULT_PATH` come vault in Obsidian mostra le note collegate
fra loro nella graph view; modificare una nota nell'app e riesportare produce un `git diff` di
poche righe leggibili, non un file riscritto da capo.

---

## 4. Budget token

Stima per una ricerca, con 12 candidati da ~60 token l'uno:

| Voce | Oggi (60 note) | Dopo |
|---|---|---|
| Retrieval (embedding, FTS, traversata) | ~200 tok LLM finti | **0** (tutto locale) |
| Contesto nel prompt | ~4.000 tok, in crescita | ~750 tok, **costante** |
| System prompt + risposta | ~700 tok | ~700 tok |
| **Totale per operazione** | **~4.900 tok** | **~1.450 tok** |

Con 8.000 token/minuto: da ~1 operazione al minuto a ~5. Con 200.000 token/giorno: da ~40
operazioni a ~135. E soprattutto quei numeri **non peggiorano** quando il corpus cresce, che è
il punto vero — oggi a 300 note una singola ricerca sfonderebbe il limite al minuto da sola.

---

## 5. Ordine di esecuzione

```
Fase 0  pulizia + manutenzione dati        ~30 min   nessun rischio
Fase 1  date + entità orfane + dedup       ~1 h      bug fix indipendenti
Fase 2  embedding reali + backfill         ~2 h      sostituisce fondamenta finte
Fase 3  archi item↔item + migrazione       ~2 h      richiede Fase 2 per SIMILAR_TO
Fase 4  pipeline retrieval + riscrittura   ~3 h      richiede Fase 3
Fase 5  markdown vault                      —        opzionale, dopo la 4
```

Ogni fase è un commit separato e lascia l'app funzionante.

---

## 6. Decisioni

1. ~~**Fase 5 markdown**~~ → **decisa: opzione C**, mirror in sola lettura. Vedi Fase 5.
2. **Modello per la Fase 3c** — default assunto: `openai/gpt-oss-120b` per il solo linking
   ragionato (reasoning nativo), `qwen/qwen3.6-27b` resta per parsing e ricerca. Rivedibile
   quando si arriva alla Fase 3.
3. **`.claude/`** — committata: è configurazione di progetto, utile e versionabile.
4. **`ingest_test.py`** — tenuto come utility locale (resta gitignored): serve a generare le 200
   note sintetiche del criterio di accettazione della Fase 4.
5. **Reminder** — ci si ferma alla Fase 1a: `time_ref` affidabile e modalità calendario corretta.
   Nessun sistema di notifiche.

## 7. Hosting *(non nel percorso critico)*

Da affrontare **dopo la Fase 4**, mai durante: accoppiare il refactor a una migrazione di deploy
è il modo più rapido per non finire né l'uno né l'altra.

Vincolo tecnico da tenere presente fin d'ora: **su Vercel questa app non gira così com'è.**
`better-sqlite3` scrive su un file locale che il filesystem serverless non conserva fra le
invocazioni, e il modello di embedding della Fase 2 (~120 MB) è pesante per un cold start serverless.

Due strade coerenti, da valutare a Fase 4 conclusa:

- **Render / Fly.io** — container persistente con disco. `better-sqlite3` e transformers.js
  funzionano invariati, zero migrazioni. La strada di minor attrito.
- **Vercel + Turso** — richiede di sostituire `better-sqlite3` con il client Turso (~1 h) e di
  spostare l'embedding fuori dal serverless o accettare i cold start.
