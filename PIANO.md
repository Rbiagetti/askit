# Piano di implementazione — Retrieval sul grafo

> Obiettivo: smettere di mandare l'intero corpus all'LLM ad ogni operazione.
> Il contesto inviato deve dipendere dal **vicinato nel grafo**, non dalla dimensione totale del database.
> Vincolo di progetto: restare dentro il free tier Groq (30 req/min, 8.000 token/min, 200.000 token/giorno).

Data: settembre 2026 · Stato: **completato e in produzione** (Fasi 0-5, backlog usabilità, migrazione Turso/Vercel/Gemini — vedi §8 e §9)

> Registro cronologico del progetto: decisioni, misure e anche i vicoli ciechi, scritto mentre il lavoro avveniva. Le sezioni più vecchie descrivono lo stato *di allora* (es. embedding locali, SQLite su file) e sono superate da §9.

| Fase | Stato | Verifica |
| :--- | :--- | :--- |
| 0 · Pulizia | ✅ | `tsc --noEmit` pulito, 37 entità orfane rimosse |
| 1 · Date + leak entità | ✅ | «domani alle 18» → `2026-09-13T18:00:00+02:00` |
| 2 · Embedding reali | ✅ | 384 dim, deterministici, 8/8 item con vettore |
| 3 · Grafo item↔item | ✅ | `SIMILAR_TO` su soglia adattiva; `DUPLICATES` a 0.95 |
| 4 · Retrieval sul grafo | ✅ | **20 note → 252 tok · 200 note → 253,6 tok (+0,6%)** |
| 5 · Mirror markdown | ✅ | 8 note + 11 stub entità, zero wikilink rotti |

Tre correzioni rispetto al piano originale, tutte documentate sotto:
soglia `SIMILAR_TO` adattiva anziché fissa (§Fase 3b), `PRAGMA user_version`
anziché confronto di COUNT per l'FTS (§Fase 4), e il limite OTPM del free tier (§4).

## 8. Backlog usabilità (sessione expert-team, 12 settembre 2026)

Dopo le Fasi 0-5, l'utente ha segnalato due gap reali: il flusso vocale richiedeva
5 interazioni manuali, e le note erano solo una lista piatta senza vista sul grafo
costruito. Un panel di 6 esperti (skill `expert-team`) ha prodotto un backlog di 12 task,
sviluppato in **3 worktree paralleli** e integrato con merge sequenziali:

| Fronte | Branch | Task | Esito |
|---|---|---|---|
| A · Backend manutenzione | `feat/backend-maintenance` | T-005, T-010, T-011 | ✅ merge pulito, zero conflitti |
| B · Vocale one-shot | `feat/voice-ux` | T-001→T-004 | ✅ merge pulito, zero conflitti |
| C · Vault UI | `feat/vault-ui` | T-006→T-009, T-012 | ✅ merge con 3 conflitti attesi, risolti |

**Risultato**: da 5 interazioni a 1 per salvare una nota vocale (VAD + auto-submit
annullabile + routing su `intent`); il grafo costruito nelle Fasi 3-4 è ora visibile
in UI (vista Vault, pannello dettaglio con archi tipizzati); manutenzione DB esposta
via `/api/reindex` (gratis) e `/api/reanalyze` (protetto da rate limit).

**Conflitti di merge**, tutti previsti perché dichiarati in anticipo nei prompt:
- `api/tree/route.ts` (add/add): due implementazioni indipendenti dello stesso
  contratto, concordato prima del lancio dei 3 agenti — tenuta quella del Fronte A
- `lib/db.ts`: entrambi A e C aggiungevano `domain_locked` — stessa colonna, commenti diversi, uniti
- `app/page.tsx`: B e C toccavano la stessa area (submitSearch / union type di `mode`) — uniti entrambi

**Incidente e correzione**: il Fronte C, testando `POST /api/vault` su un server locale
con DB isolato, ha usato per errore il `VAULT_PATH` di default — la vault Obsidian
**reale** dell'utente, non isolata dal worktree — sovrascrivendola con 5 note di test.
`secondbrain.db` (fonte di verità) non è mai stato toccato. Rilevato dall'agente stesso,
verificato prima del merge (`sqlite3 secondbrain.db` → 9 item reali intatti), corretto
con `npm run vault:export`: vault reale rigenerata, nessuna perdita. Lezione per il
futuro: quando un worktree di test tocca risorse esterne al repo (filesystem fuori
dalla working dir, non solo il DB), va isolato esplicitamente anche quello, non solo `SB_DB_PATH`.

**Limite scoperto, non un bug**: il routing su `intent` dipende dalla classificazione
di `qwen/qwen3.6-27b`, che su frasi genuinamente ambigue («cosa devo comprare domani?»
— domanda o promemoria?) può classificare come `save` invece di `explore`. Verificato
che la logica di routing stessa è corretta; il limite è nella classificazione, non nel
codice. Non corretto in questa sessione — richiede una decisione di prodotto su come
trattare l'ambiguità, non un fix tecnico.

## 9. Migrazione a Turso + deploy Vercel (host cloud gratuito)

**Stato: completato** (esito reale in §9.8) · Data: 12 settembre 2026

### 9.1 Perché

L'utente vuole usare l'app dal telefono **senza dipendere da un computer sempre acceso**.
Tre strade erano sul tavolo (Raspberry Pi, hosting cloud a pagamento, hosting cloud gratuito) —
scelta: **hosting cloud gratuito (Vercel + Turso)**, accettando il costo in lavoro di
migrazione a fronte di zero costo ricorrente.

Un tentativo intermedio con **Tailscale** (rete privata Mac↔iPhone + `tailscale serve` per
avere HTTPS, necessario perché iOS blocca `getUserMedia` fuori da un contesto sicuro) ha
funzionato per la connettività ma si è rivelato inutilizzabile in pratica: l'app restava
bloccata sul telefono con i tab non responsivi, sintomo compatibile con un problema di
streaming React Server Components attraverso il proxy di `tailscale serve` (non
diagnosticato a fondo, abbandonato in favore della soluzione definitiva). Tailscale è stato
disinstallato.

### 9.2 Perché è un refactor vero, non un cambio di configurazione

`better-sqlite3` (in uso da inizio progetto) è **sincrono**: ogni query blocca finché non
risponde, perché il file è locale. Turso è un DB remoto — ogni query è per forza una
chiamata di rete, quindi **asincrona**. Questo obbliga a convertire da sincrono ad asincrono
l'intero strato dati: `lib/db.ts`, `lib/graph.ts`, `lib/retrieve.ts`, `lib/markdown.ts`, e le
8 route API che li usano (`parse`, `items` con tutti i verbi, `items/[id]`, `search`, `tree`,
`reindex`, `reanalyze`, `vault`). Non è opzionale: non esiste un modo di parlare con Turso
in modo sincrono.

### 9.3 Design: un solo client per locale e remoto

Per non forzare Turso anche sullo sviluppo locale (o su un eventuale Raspberry Pi futuro),
il client si sceglie in base alle variabili d'ambiente:

```ts
const url = process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`;
const client = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN, // ignorato per url "file:"
  intMode: "number",
});
```

Senza le variabili `TURSO_*` impostate, il comportamento resta **identico a oggi** (stesso
file `secondbrain.db`, via `@libsql/client` invece di `better-sqlite3` ma stesso risultato).
Con le variabili impostate (solo su Vercel), si connette a Turso. Il refactor sync→async
paga quindi una sola volta, indipendentemente da dove poi si decide di ospitare l'app.

### 9.4 Cosa cambia concretamente

- `getDb()` diventa asincrona e garantisce (con una Promise memoizzata) che le migrazioni
  girino una sola volta anche con richieste concorrenti
- `db.prepare(sql).all(...)` / `.get(...)` / `.run(...)` → `await client.execute({sql, args})`,
  risultato in `.rows` (accesso sia per indice che per nome colonna)
- `db.transaction(() => {...})()` → array di statement costruito dinamicamente + `client.batch(arr, "write")`
- `db.exec(sqlMultiStatement)` → `client.executeMultiple(...)` per i blocchi CREATE TABLE,
  loop di singole `execute()` guardate per gli ALTER TABLE (stesso pattern try/catch di oggi)
- `db.pragma("user_version", ...)` non esiste in libsql → `PRAGMA user_version` letto/scritto
  via `execute()` normale

### 9.5 Punti di rischio

- **FTS5 su Turso**: da verificare che il supporto sia completo. Il codice ha già un
  try/catch attorno a `lexicalMatches()` (Fase 4) che degrada a 0 risultati FTS senza
  rompere gli altri 3 generatori del retrieval — questa resilienza deve sopravvivere
  identica nella versione async.
- **Cold start serverless per l'embedding locale**: il modello `multilingual-e5-small`
  (~120MB, Fase 2) su una funzione Vercel che riparte a freddo rischia di dover essere
  riscaricato spesso. Mitigazione valutata: bundlare il modello nel deploy invece di
  scaricarlo a runtime (`env.localModelPath` + `env.allowRemoteModels = false` di
  transformers.js). Non bloccante per il merge del refactor, ma da chiudere prima del
  deploy reale se la latenza risulta un problema.

### 9.6 Cosa serve dall'utente (non delegabile)

- Creare l'account Turso e il database (richiede login via browser, non automatizzabile):
  ```bash
  curl -sSfL https://get.tur.so/install.sh | bash
  turso auth login
  turso db create secondbrain
  turso db show secondbrain --url        # -> TURSO_DATABASE_URL
  turso db tokens create secondbrain     # -> TURSO_AUTH_TOKEN
  ```
  Le due variabili vanno aggiunte a `.env.local` in locale e alle variabili d'ambiente
  del progetto Vercel per il deploy — sono credenziali, non passano per la chat.
- Account Vercel (probabilmente già collegato a questa sessione via MCP) per il deploy vero.

### 9.8 Esito finale (12 settembre 2026, sera)

Deploy completato e verificato su Vercel (protetto da Vercel Authentication, come scelto). Percorso reale, non quello previsto
a tavolino:

1. **`PRAGMA journal_mode = WAL`** rifiutata da Turso ("SQL not allowed statement"),
   dentro un blocco che si ferma al primo errore → bloccava silenziosamente la
   creazione di ogni tabella. Spostata fuori, condizionata a `url.startsWith("file:")`.
2. **Modello Groq ritirato**: `qwen/qwen3.6-27b` non esisteva più, sostituito con
   `qwen/qwen3.8-27b` — i modelli preview di Groq cambiano id senza preavviso.
3. **Regione GitHub App / permessi del connettore Vercel**: due cause distinte di
   403 "You don't have permission to create the project", risolte separatamente
   (autorizzazione repo su GitHub, poi riconnessione del connettore Vercel).
4. **`libonnxruntime.so.1` mancante**: onnxruntime-node (motore di transformers.js)
   fa `dlopen()` della sua libreria nativa a runtime, invisibile al file-tracing
   statico di Next — `serverExternalPackages` da solo non basta.
5. **`outputFileTracingIncludes` sfora il tetto di 12 funzioni di Vercel Hobby**:
   ogni route toccata dalla regola sembra costare funzioni aggiuntive in modo non
   lineare (base 2 → 4 con 1 route → 10 con 3 route → sfora con 5). Soluzione
   temporanea: limitato a 3 route (parse/items/search), reindex/reanalyze rotte.
6. **Cache di transformers.js su `node_modules/` di sola lettura** — spostata su
   `os.tmpdir()`.
7. **Lentezza segnalata dall'utente**: regione Vercel (Washington) e Turso
   (Dublino) disallineate — ogni query attraversava l'Atlantico — più
   `retrieve()` che awaitava in sequenza query indipendenti. Fix:
   `vercel.json` con `regions: ["dub1"]` + `Promise.all` in `retrieve()`.
8. **Svolta finale**: sostituiti gli embedding locali (transformers.js +
   onnxruntime-node) con la **Gemini embeddings API**
   (`gemini-embedding-001`, 768 dim via `outputDimensionality`, `taskType`
   `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY` come equivalente dei prefissi E5).
   Elimina i punti 4-6 alla radice: niente più binario nativo, niente più
   cold-start del modello, niente più tetto di funzioni — `reindex` e
   `reanalyze` di nuovo funzionanti su Vercel. Verificato che Groq **non**
   ha un endpoint di embedding (una ricerca web l'aveva erroneamente
   affermato, smentito contro l'API reale) prima di scegliere Gemini.

Ogni dettaglio tecnico sopra (endpoint, formati, il bug di `outputDimensionality`
ignorato dentro `embedContentConfig`) è stato verificato contro le API reali con
chiavi vere prima di scrivere codice, non assunto dalla documentazione.

### 9.7 Verifica prevista

Il refactor va provato **in locale senza credenziali Turso** (modalità file, vedi §9.3) come
prova che l'astrazione funziona; il collaudo contro Turso vero avviene solo quando le
credenziali sono disponibili, prima del deploy su Vercel. Criterio di accettazione: l'intero
ciclo (creare nota → comparire in lista → trovarla in ricerca → modificarne il dominio →
cancellarla) deve produrre lo stesso risultato di oggi, in entrambe le modalità.

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
  Coerente con il local-first del progetto *all'epoca* — superato in §9.8: gli
  embedding locali si sono rivelati impossibili da impacchettare in modo
  affidabile su Vercel, sostituiti con Gemini API.
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

Creare `SIMILAR_TO` verso i top-3 vicini per cosine.

> **Calibrazione misurata (Fase 2, 45 coppie di frasi eterogenee).** Una soglia assoluta qui
> **non funziona** e la prima stesura di questo piano diceva 0.75, che è sbagliato.
> `multilingual-e5-small` produce embedding in un cono stretto: tutte le similarità cadono in
> **[0.808, 0.920]**, media 0.871, std 0.025 — anche fra testi totalmente scorrelati
> («comprare latte e pane» vs «rivedere Interstellar» = 0.808). Con soglia 0.75 ogni nota
> risulterebbe simile a ogni altra.
>
> Gli **z-score** invece separano correttamente: parafrasi z=+1.95, scorrelato z=−2.56.
> Quindi la soglia è **adattiva**: per ogni item si calcola media e deviazione standard delle sue
> similarità verso tutto il corpus, e si tengono i vicini con **z ≥ 1.5**, comunque al massimo 3.
> Sotto ~5 item nel corpus la statistica non è affidabile e `SIMILAR_TO` va semplicemente saltato.
>
> Questo non tocca la Fase 4: RRF è rank-based e non usa valori assoluti.

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

**Misurato** dopo l'implementazione (5 query, `dryRun`, DB sintetici):

| Corpus | Token di contesto | Note inviate |
|---|---|---|
| 20 note | 252 | 12 |
| 200 note | **253,6** | 12 |

Corpus 10×, costo +0,6%: il retrieval è disaccoppiato dalla dimensione del database.
Prima, a 200 note ne sarebbero state inviate 40 e a 60 l'intero corpus.
Il costo del retrieval in sé (embedding, FTS, traversata) è **0 token**: gira tutto in locale.

> **Limite del free tier scoperto in corsa: OTPM = 1000 output token al minuto**, separato
> dagli 8.000 TPM. E `max_tokens` è una **prenotazione** contro quel limite, non solo un tetto:
> `searchWithLLM` chiedeva 2000 e ogni ricerca veniva rifiutata con 429 *prima di girare*.
> Ora 900 per la ricerca, 500 per il parsing, 400 per il linking ragionato.
> È anche il motivo per cui la Fase 3c è opt-in: i token di reasoning contano sull'OTPM.

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
