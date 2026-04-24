require('dotenv').config();

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const client = new Anthropic.Anthropic();

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

    const response = await client.messages.create(request);

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
    res.status(status).json({ error: err.message || 'Internal error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Old English Glosser running at http://localhost:${PORT}`);
});
