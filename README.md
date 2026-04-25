# Old English Glosser

An AI-powered glossing tool for Old English texts. Paste any passage, click any word, and get a scholarly gloss — headword, part of speech, grammatical parse, modern sense, and etymology — powered by Claude.

![screenshot placeholder](https://via.placeholder.com/800x450?text=Old+English+Glosser)

---

## Features

- **Click-to-gloss** — click any word in the loaded text to consult the glossary
- **Scholarly output** — lemma with macrons, abbreviated POS, full grammatical parse (case, number, gender, stem class, verb class), contextual gloss, Bosworth-Toller style etymology
- **Fast by default** — glosses return quickly with thinking disabled; use **⁂ Double-check** to re-run with extended reasoning for ambiguous forms
- **Editable glosses** — click **✎ Edit** on any gloss to correct the word form, meaning, parse, or etymology and save it back
- **Vocabulary list** — save words with **✦ Save**; the list persists across sessions
- **Export to Anki** — export the vocabulary list as a CSV ready to import into Anki (lemma front, bolded context sentence, HTML-formatted grammar back)
- **Import / Export JSON** — save and reload the full document state (text, glosses, vocabulary) as a JSON file
- **Sweet's Reader dot notation** — middle dots used as prefix separators (e.g. `ā · scēaf`) are treated as a single word for glossing and displayed with the dot intact
- **Paragraph breaks** — blank lines in the pasted text are preserved as visual paragraph separators in the folio
- **Editable header** — click the title, metadata, or subtitle to edit them in place

---

## Setup

### Prerequisites

- Node.js 18 or later
- An [Anthropic API key](https://console.anthropic.com/)

### Install

```bash
git clone https://github.com/dylanbright/OldEnglishGlosser3.git
cd OldEnglishGlosser3
npm install
```

### Configure

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## How it works

### Architecture

```
Browser (public/)
  └── app.js          — tokenizer, renderer, UI state, API calls
  └── index.html      — single-page layout
  └── styles.css      — manuscript-style CSS (EB Garamond, IM Fell English)

Server (server.js)
  └── Express static   — serves public/
  └── POST /api/gloss  — proxies to Claude, hides the API key
```

The browser never touches the Anthropic API directly. All calls go through `/api/gloss`, which keeps the key server-side.

### Tokenizer

`tokenizeText()` splits the input into lines, then tokenizes each line into word tokens `{ w }` and punctuation tokens `{ punct }`. Blank lines are recorded as paragraph break markers (`doc.paraBreaks`).

Sweet's Reader middle-dot notation (`·` U+00B7, `‧` U+2027, `⋅` U+22C5) is handled by a post-pass that fuses `word · word` chains into a single token. The `display` property preserves the dotted form for rendering; `w` holds the joined form sent to the API.

### Document model

Everything is stored in `localStorage` under the key `oeg-doc-v1`:

```js
{
  version: 1,
  title: "",
  meta: "",
  subtitle: "",
  lines: [],        // array of lines; each line = array of tokens
  lineText: [],     // raw string per line (used as context for the API)
  paraBreaks: [],   // line indices that open a new paragraph
  glosses: {},      // "lineIdx:tokenIdx" → gloss object
  vocab: []         // saved words [{key, w, lemma, pos, gloss}]
}
```

### Gloss API

`POST /api/gloss` accepts:

| Field | Type | Description |
|---|---|---|
| `word` | string | The word to gloss |
| `lineText` | string | The full line for grammatical context |
| `documentTitle` | string | Optional — helps the model identify the text |
| `documentMeta` | string | Optional — dialect, date, etc. |
| `deep` | boolean | If true, enables adaptive thinking and extra reasoning |

Returns a JSON object:

| Field | Description |
|---|---|
| `lemma` | Dictionary headword with macrons (infinitive for verbs, nom. sg. for nouns/adjectives) |
| `pos` | Abbreviated POS: `n.`, `v.`, `adj.`, `adv.`, `pron.`, `prep.`, `conj.`, `interj.`, `num.`, `art.`, `part.`, `prop.n.` |
| `posFull` | POS spelled out: `Noun`, `Verb`, `Adjective`, etc. Used in Anki export |
| `parse` | Grammatical parse: case, number, gender, person, tense, mood, stem/verb class |
| `gloss` | Short modern English sense (2–8 words) fitted to this specific context |
| `etymology` | Compact note: PGmc ancestor, PIE root where established, cognates in OHG/OS/ON/Gothic/OFris |

### Modes

**Standard gloss** — `thinking: disabled`, `effort: low`. Typically returns in 1–3 seconds.

**Double-check** — `thinking: { type: "adaptive" }`, `max_tokens: 4096`, plus an extra prompt nudge to weigh alternative parses. Used for genuinely ambiguous forms. The button turns red and shows **✓ Deep-verified** after completion.

The system prompt is cache-controlled (`cache_control: { type: "ephemeral" }`) so repeat requests in the same session avoid re-sending ~1 KB of prompt text.

### Anki CSV export

Each saved vocabulary entry becomes one card row:

| Column | Content |
|---|---|
| Lemma (Root) | The headword |
| Context Sentence (Front) | The raw source line with the target word wrapped in `<b>…</b>` |
| Definition & Grammar (Back) | HTML: `<p><b>Meaning:</b> …</p><p><b>Grammar:</b> …</p><p><i>POS</i></p><small>etymology</small>` |

The file is UTF-8 with BOM so Anki and Excel handle macrons correctly.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `→` or `Space` | Next word |
| `Escape` | Clear selection (or cancel edit mode) |
| `Ctrl/Cmd + S` | Save current word to vocabulary |
| `Ctrl/Cmd + Enter` | Load text (inside the New Text modal) |

---

## Project structure

```
OldEnglishGlosser3/
├── public/
│   ├── index.html      Single-page UI
│   ├── app.js          All client-side logic (~800 lines)
│   └── styles.css      Manuscript-style design system
├── server.js           Express server + Claude API proxy
├── package.json
├── .env                API key (not committed)
└── .gitignore
```
