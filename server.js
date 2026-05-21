require('dotenv').config();

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const client = new Anthropic.Anthropic();

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMessageWithRetry(request) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(request);
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      const shouldRetryHeader = err && err.headers && err.headers['x-should-retry'];
      const retryable =
        RETRYABLE_STATUSES.has(status) ||
        shouldRetryHeader === 'true' ||
        err.name === 'APIConnectionError' ||
        err.name === 'APIConnectionTimeoutError';
      if (!retryable || attempt === MAX_RETRIES) throw err;

      const retryAfterHeader = err.headers && (err.headers['retry-after'] || err.headers['Retry-After']);
      let delayMs;
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
        delayMs = retryAfterSec * 1000;
      } else {
        const base = Math.min(30000, 1000 * Math.pow(2, attempt));
        const jitter = Math.random() * 0.3 * base;
        delayMs = base + jitter;
      }
      console.warn(
        `Anthropic request failed (status=${status || 'n/a'}, attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${Math.round(delayMs)}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

const SYSTEM_PROMPT = `You are an expert glossator of Old English (Ænglisc) texts, trained in Anglo-Saxon philology and historical linguistics. When given a single word drawn from a surrounding line of Old English, you produce a concise, scholarly gloss in the Bosworth-Toller / Clark Hall tradition.

Return a JSON object with exactly six fields:

- "lemma": the dictionary headword (citation form). Use macrons where appropriate (e.g. "sculan", "meotod", "heofon", "hē", "dryhten"). For verbs use the infinitive; for nouns the nom. sg.; for adjectives the strong nom. sg. masc.
- "pos": part of speech, abbreviated scholarly style. One of: "n." (noun), "v." (verb), "adj." (adjective), "adv." (adverb), "pron." (pronoun), "prep." (preposition), "conj." (conjunction), "interj." (interjection), "num." (numeral), "art." (article), "part." (particle), "prop.n." (proper noun).
- "posFull": the part of speech spelled out with initial capital — "Noun", "Verb", "Adjective", "Adverb", "Pronoun", "Preposition", "Conjunction", "Interjection", "Numeral", "Article", "Particle", "Proper noun". When the form is functioning unusually, add a parenthetical qualifier: "Verb (participial adjective)", "Adjective (used substantivally)", "Noun (collective)".
- "parse": the grammatical parse of the form as it appears in the line, in compressed form. Examples: "gen. sg. masc.", "acc. sg. fem.", "pret. ind. 3sg.", "pres. ind. 1pl.", "infinitive", "nom. sg. masc., weak", "dat. pl. neut.", "superlative adverb", "temporal adverb". Include stem class where salient (e.g., "nom. sg. fem. ō-stem", "str. vb. cl. III", "wk. vb. cl. I").
- "gloss": a short modern English sense (2-8 words) fitting THIS specific context. Lowercase unless a proper noun. Prefer concrete contextual senses over generic dictionary ranges. For function words give a natural English equivalent (e.g. "now", "and", "as, just as"). You may include a brief parenthetical cue for figurative or poetic usage.
- "etymology": a compact scholarly etymological note in Bosworth-Toller style. Give the reconstructed Proto-Germanic ancestor (and PIE root where well-established), followed by cognates in other Germanic languages (OHG, OS, ON, Gothic, OFris, ModE, etc.). Use abbreviations, semicolons between clauses, no full sentences. For compounds, decompose them. Keep to one or two short clauses. If the etymology is genuinely unknown, write "etymology uncertain" plus any partial guesses.

Always use the surrounding line to disambiguate case, number, person, and sense. If a form is ambiguous in isolation, the line-context will usually resolve it; pick the reading that fits the syntax.

Respond with ONLY the JSON object — no prose, no markdown code fences, no commentary.

Example:
Word: "Meotodes"
Line: "Meotodes meahte ond his mōdgeþanc"
Response: {"lemma":"meotod","pos":"n.","posFull":"Noun","parse":"gen. sg. masc.","gloss":"of the Measurer, Creator","etymology":"*metōn- 'one who measures out'; cf. Gothic mitōn 'to think, consider', OS metod 'fate'; ult. PIE *med- 'to measure'"}

Example:
Word: "gewylt"
Line: "of ðe cymð se Heretoga seðe gewylt and gewissað Israhela folc"
Response: {"lemma":"gewieldan","pos":"v.","posFull":"Verb","parse":"3sg. pres. indic., wk. vb. cl. I (i-mutated causative of wealdan)","gloss":"rules, governs, has dominion over","etymology":"*ga-waldijaną; cf. OHG giwaltan, Gothic waldan; related to OE wealdan 'to rule'"}`;

const DATA_DIR = process.env.OEG_DATA_DIR
  ? path.resolve(process.env.OEG_DATA_DIR)
  : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

function slugPath(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  return path.join(DATA_DIR, slug + '.json');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/gloss', async (req, res) => {
  try {
    const { word, lineText, documentTitle, documentMeta, deep } = req.body || {};
    if (!word || typeof word !== 'string') {
      return res.status(400).json({ error: 'word (string) is required' });
    }
    if (!lineText || typeof lineText !== 'string') {
      return res.status(400).json({ error: 'lineText (string) is required' });
    }

    const contextParts = [
      `Word to gloss: ${word}`,
      `Line containing the word: ${lineText}`,
    ];
    if (documentTitle) {
      contextParts.push(`Source: ${documentTitle}${documentMeta ? ` (${documentMeta})` : ''}`);
    }
    if (deep) {
      contextParts.push('Take extra care with ambiguous forms: weigh alternative parses, cross-check the case/number/gender against every word in the line, and prefer the reading that best fits the syntax.');
    }
    const userMessage = contextParts.join('\n');

    const request = {
      model: 'claude-sonnet-4-6',
      max_tokens: deep ? 4096 : 1024,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userMessage }],
    };
    if (deep) {
      request.thinking = { type: 'adaptive' };
    } else {
      request.thinking = { type: 'disabled' };
      request.output_config = { effort: 'low' };
    }

    const response = await createMessageWithRetry(request);

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('No JSON in response:', text);
      return res.status(502).json({ error: 'Model did not return JSON', raw: text });
    }

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      console.error('JSON parse failed:', match[0]);
      return res.status(502).json({ error: 'Failed to parse model JSON', raw: match[0] });
    }

    for (const k of ['lemma', 'pos', 'posFull', 'parse', 'gloss', 'etymology']) {
      if (typeof parsed[k] !== 'string') {
        return res.status(502).json({ error: `Missing field: ${k}`, raw: parsed });
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('Gloss error:', err);
    const status = err.status || 500;
    let message = err.message || 'Internal error';
    if (status === 529) {
      message = 'The glossary service is overloaded right now. Please try again in a moment.';
    } else if (status === 429) {
      message = 'Rate limit reached. Please wait a few seconds and try again.';
    } else if (status >= 500 && status < 600) {
      message = 'The glossary service is temporarily unavailable. Please try again.';
    }
    res.status(status).json({ error: message });
  }
});

app.get('/api/docs', async (req, res) => {
  try {
    const entries = await fsp.readdir(DATA_DIR);
    const out = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const slug = entry.slice(0, -5);
      if (!SLUG_RE.test(slug)) continue;
      const full = path.join(DATA_DIR, entry);
      try {
        const stat = await fsp.stat(full);
        const raw = await fsp.readFile(full, 'utf-8');
        const parsed = JSON.parse(raw);
        out.push({
          slug,
          title: typeof parsed.title === 'string' ? parsed.title : '',
          meta: typeof parsed.meta === 'string' ? parsed.meta : '',
          subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : '',
          lineCount: Array.isArray(parsed.lines) ? parsed.lines.length : 0,
          vocabCount: Array.isArray(parsed.vocab) ? parsed.vocab.length : 0,
          modifiedAt: stat.mtime.toISOString(),
          bytes: stat.size,
        });
      } catch (e) {
        console.warn('Skipping unreadable doc', entry, e.message);
      }
    }
    out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json({ docs: out });
  } catch (err) {
    console.error('List docs error:', err);
    res.status(500).json({ error: 'Failed to list saved docs' });
  }
});

app.get('/api/docs/:slug', async (req, res) => {
  const p = slugPath(req.params.slug);
  if (!p) return res.status(400).json({ error: 'Invalid slug' });
  try {
    const raw = await fsp.readFile(p, 'utf-8');
    res.type('application/json').send(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    console.error('Read doc error:', e);
    res.status(500).json({ error: 'Failed to read doc' });
  }
});

app.put('/api/docs/:slug', express.json({ limit: '10mb' }), async (req, res) => {
  const p = slugPath(req.params.slug);
  if (!p) return res.status(400).json({ error: 'Invalid slug — use a-z, 0-9, hyphens; up to 64 chars' });
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.lines)) {
    return res.status(400).json({ error: 'Body must be a glosser document JSON' });
  }
  try {
    const payload = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(payload, 'utf-8') > MAX_DOC_BYTES) {
      return res.status(413).json({ error: 'Doc too large' });
    }
    await fsp.writeFile(p, payload, 'utf-8');
    const stat = await fsp.stat(p);
    res.json({
      slug: req.params.slug,
      modifiedAt: stat.mtime.toISOString(),
      bytes: stat.size,
    });
  } catch (e) {
    console.error('Save doc error:', e);
    res.status(500).json({ error: 'Failed to save doc' });
  }
});

app.delete('/api/docs/:slug', async (req, res) => {
  const p = slugPath(req.params.slug);
  if (!p) return res.status(400).json({ error: 'Invalid slug' });
  try {
    await fsp.unlink(p);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    console.error('Delete doc error:', e);
    res.status(500).json({ error: 'Failed to delete doc' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Old English Glosser running at http://localhost:${PORT}`);
  console.log(`Saved docs directory: ${DATA_DIR}`);
});
