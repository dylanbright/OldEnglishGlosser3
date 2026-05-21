(function () {
  'use strict';

  const STORAGE_KEY = 'oeg-doc-v1';
  const EXPORT_VERSION = 1;

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const folioTitle = $('folio-title');
  const folioMeta  = $('folio-meta');
  const folioSub   = $('folio-sub');
  const poem       = $('poem');
  const folioEmpty = $('folio-empty');
  const panelEmpty = $('panel-empty');
  const panelLoading = $('panel-loading');
  const panelError = $('panel-error');
  const panelErrorMsg = $('panel-error-msg');
  const detail     = $('detail');
  const hint       = $('panel-hint');
  const dForm      = $('d-form');
  const dPos       = $('d-pos');
  const dLemma     = $('d-lemma');
  const dGloss     = $('d-gloss');
  const dParse     = $('d-parse');
  const dLine      = $('d-line');
  const dContext   = $('d-context');
  const dEtym      = $('d-etym');
  const actSave       = $('act-save');
  const actDeep       = $('act-deep');
  const actNext       = $('act-next');
  const actEdit       = $('act-edit');
  const actEditSave   = $('act-edit-save');
  const actEditCancel = $('act-edit-cancel');
  const btnRetry   = $('btn-retry');
  const vocabList  = $('vocab-list');
  const vCount     = $('v-count');
  const modal      = $('paste-modal');
  const inTitle    = $('in-title');
  const inMeta     = $('in-meta');
  const inSub      = $('in-sub');
  const inText     = $('in-text');
  const btnLoad    = $('btn-load');
  const btnPasteEmpty = $('btn-paste-empty');
  const btnNew     = $('btn-new');
  const btnLibrary = $('btn-library');
  const btnExportCsv = $('btn-export-csv');
  const btnReset   = $('btn-reset');
  const fileInput  = $('file-input');
  const libModal   = $('lib-modal');
  const libSaveSlug = $('lib-save-slug');
  const libSaveHint = $('lib-save-hint');
  const btnLibSave = $('btn-lib-save');
  const libList    = $('lib-list');
  const libEmpty   = $('lib-empty');
  const libError   = $('lib-error');
  const btnLibImport = $('btn-lib-import');
  const btnLibExport = $('btn-lib-export');

  // Empty document template
  function emptyDoc() {
    return {
      version: EXPORT_VERSION,
      title: '',
      meta: '',
      subtitle: '',
      lines: [],       // [[{ w, punctBefore?, punctAfter? } | { punct }, ...], ...]
      lineText: [],    // cached raw line strings for context
      paraBreaks: [],  // line indices that open a new paragraph (preceded by blank line)
      glosses: {},     // "li:idx" -> { lemma, pos, parse, gloss }
      vocab: [],       // [{ key, w, lemma, pos, gloss }]
      serverSlug: null,// last known server filename, if any
    };
  }

  let doc = loadDoc() || emptyDoc();
  let activeLine = null;
  let activeIdx  = null;
  let pendingRequests = 0;
  let editMode = false;

  function loadDoc() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return migrate(parsed);
    } catch (e) {
      console.warn('Failed to load saved doc:', e);
      return null;
    }
  }

  function migrate(d) {
    const base = emptyDoc();
    return {
      ...base,
      ...d,
      glosses: d.glosses || {},
      vocab: Array.isArray(d.vocab) ? d.vocab : [],
      lines: Array.isArray(d.lines) ? d.lines : [],
      lineText: Array.isArray(d.lineText) ? d.lineText : [],
      paraBreaks: Array.isArray(d.paraBreaks) ? d.paraBreaks : [],
      serverSlug: typeof d.serverSlug === 'string' ? d.serverSlug : null,
    };
  }

  // —————— Slug helpers ——————
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

  function slugify(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || '';
  }

  function defaultSlug() {
    return doc.serverSlug || slugify(doc.title) || 'untitled';
  }

  function saveDoc() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch (e) {
      console.warn('Failed to save doc:', e);
    }
  }

  // —————— Tokenizer ——————
  // A word = run of letters (incl. diacritics/macrons), apostrophes, hyphens.
  // Everything else non-whitespace = punctuation string.
  const TOKEN_RE = /[\p{L}\p{M}'\u2019-]+|[^\s\p{L}\p{M}]/gu;
  // Sweet's Reader and similar editions insert a middle dot between prefix and
  // stem as a reading aid (e.g., "ā · scēaf" for āscēaf). We treat these as
  // single words: display keeps the dots, `w` drops them for gloss lookup.
  const WORD_DOTS = new Set(['\u00B7', '\u2027', '\u22C5']); // · ‧ ⋅
  const WORD_DOT_RE = /[\u00B7\u2027\u22C5]/g;

  function tokenizeText(text) {
    const rawLines = text.split(/\r?\n/);
    const lines = [];
    const lineText = [];
    const paraBreaks = [];
    let prevBlank = false;
    for (const raw of rawLines) {
      const trimmed = raw.trim();
      if (!trimmed) { prevBlank = true; continue; }
      const matches = trimmed.match(TOKEN_RE) || [];
      const initial = [];
      for (const m of matches) {
        if (/[\p{L}]/u.test(m)) initial.push({ w: m });
        else initial.push({ punct: m });
      }
      // Post-pass: fuse "word · word (· word …)" chains into one token.
      const tokens = [];
      for (let j = 0; j < initial.length; j++) {
        const cur = initial[j];
        if (
          cur.w &&
          initial[j + 1] && initial[j + 1].punct && WORD_DOTS.has(initial[j + 1].punct) &&
          initial[j + 2] && initial[j + 2].w
        ) {
          let combined = cur.w;
          let display = cur.w;
          let k = j + 1;
          while (
            initial[k] && initial[k].punct && WORD_DOTS.has(initial[k].punct) &&
            initial[k + 1] && initial[k + 1].w
          ) {
            display += ' ' + initial[k].punct + ' ' + initial[k + 1].w;
            combined += initial[k + 1].w;
            k += 2;
          }
          tokens.push({ w: combined, display });
          j = k - 1;
          continue;
        }
        tokens.push(cur);
      }
      if (tokens.length) {
        if (prevBlank && lines.length > 0) paraBreaks.push(lines.length);
        lines.push(tokens);
        lineText.push(trimmed);
        prevBlank = false;
      }
    }
    return { lines, lineText, paraBreaks };
  }

  function stripWordDots(s) {
    return (s || '').replace(WORD_DOT_RE, '').replace(/\s+/g, ' ').trim();
  }

  // —————— Render ——————
  function renderFolio() {
    poem.innerHTML = '';
    folioTitle.textContent = doc.title || 'Old English Glosser';
    folioMeta.textContent  = doc.meta  || (doc.lines.length ? '' : '— no text loaded —');
    folioSub.textContent   = doc.subtitle || (doc.lines.length ? '' : 'Paste a text to begin');

    const hasText = doc.lines.length > 0;
    folioEmpty.classList.toggle('hidden', hasText);
    [folioTitle, folioMeta, folioSub].forEach(el => {
      el.setAttribute('contenteditable', hasText ? 'true' : 'false');
    });

    if (!hasText) return;

    const paraBreakSet = new Set(doc.paraBreaks || []);
    doc.lines.forEach((tokens, i) => {
      const line = document.createElement('div');
      line.className = 'line';
      if (paraBreakSet.has(i)) line.classList.add('para-break');
      line.dataset.line = String(i + 1);

      const num = document.createElement('span');
      num.className = 'linenum';
      num.textContent = String(i + 1).padStart(2, '0');
      line.appendChild(num);

      const verse = document.createElement('span');
      verse.className = 'verse';

      let firstWordRendered = false;
      tokens.forEach((t, j) => {
        if (t.punct) {
          const p = document.createElement('span');
          p.className = 'punct';
          p.textContent = t.punct + ' ';
          verse.appendChild(p);
          return;
        }
        const displayForm = t.display || t.w;
        // Drop cap on the very first word of line 1
        if (i === 0 && !firstWordRendered) {
          firstWordRendered = true;
          const drop = document.createElement('span');
          drop.className = 'drop';
          drop.textContent = displayForm[0];
          verse.appendChild(drop);
          if (displayForm.length > 1) {
            const rest = document.createElement('span');
            rest.className = 'w';
            rest.textContent = displayForm.slice(1);
            rest.dataset.line = String(i);
            rest.dataset.idx = String(j);
            verse.appendChild(rest);
          } else {
            drop.dataset.line = String(i);
            drop.dataset.idx = String(j);
            drop.classList.add('drop-clickable');
          }
          verse.appendChild(document.createTextNode(' '));
          return;
        }
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = displayForm;
        span.dataset.line = String(i);
        span.dataset.idx = String(j);
        verse.appendChild(span);
        const nextTok = tokens[j + 1];
        if (!nextTok || !nextTok.punct || !/^[.,;:!?)\]›»\u203a]/.test(nextTok.punct)) {
          verse.appendChild(document.createTextNode(' '));
        }
      });
      line.appendChild(verse);
      poem.appendChild(line);
    });

    refreshGlossedMarkers();
    refreshSavedMarkers();
  }

  function refreshGlossedMarkers() {
    document.querySelectorAll('.w.glossed').forEach(el => el.classList.remove('glossed'));
    Object.keys(doc.glosses).forEach(key => {
      const [li, idx] = key.split(':');
      document.querySelectorAll(`.w[data-line="${li}"][data-idx="${idx}"]`).forEach(el => {
        el.classList.add('glossed');
      });
    });
  }

  function refreshSavedMarkers() {
    document.querySelectorAll('.w.saved').forEach(el => el.classList.remove('saved'));
    doc.vocab.forEach(v => {
      const [li, idx] = v.key.split(':');
      document.querySelectorAll(`.w[data-line="${li}"][data-idx="${idx}"]`).forEach(el => {
        el.classList.add('saved');
      });
    });
  }

  // —————— Panel state ——————
  function showPanel(which) {
    [panelEmpty, panelLoading, panelError, detail].forEach(el => {
      el.classList.remove('on');
      el.classList.remove('hidden');
    });
    if (which === 'empty')   { panelEmpty.classList.remove('hidden'); panelLoading.classList.add('hidden'); panelError.classList.add('hidden'); detail.classList.remove('on'); }
    if (which === 'loading') { panelEmpty.classList.add('hidden'); panelLoading.classList.add('on'); panelError.classList.add('hidden'); detail.classList.remove('on'); }
    if (which === 'error')   { panelEmpty.classList.add('hidden'); panelLoading.classList.add('hidden'); panelError.classList.add('on'); detail.classList.remove('on'); }
    if (which === 'detail')  { panelEmpty.classList.add('hidden'); panelLoading.classList.add('hidden'); panelError.classList.add('hidden'); detail.classList.add('on'); }
  }

  function fmtParse(parse) {
    return (parse || '').split(',').map(seg => {
      const t = seg.trim();
      if (!t) return '';
      return '<span class="chip">' + escapeHtml(t) + '</span>';
    }).join(' ');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function vocabKey(li, idx) { return li + ':' + idx; }

  // —————— Selection ——————
  async function selectWord(li, idx, opts) {
    if (editMode) exitEditMode(false);
    const token = doc.lines[li] && doc.lines[li][idx];
    if (!token || !token.w) return;
    const force = !!(opts && opts.force);
    const deep  = !!(opts && opts.deep);

    document.querySelectorAll('.w.active').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`.w[data-line="${li}"][data-idx="${idx}"]`).forEach(el => el.classList.add('active'));

    activeLine = li;
    activeIdx  = idx;
    hint.textContent = `Line ${li + 1}, word ${idx + 1}`;

    const key = vocabKey(li, idx);
    const cached = doc.glosses[key];
    if (cached && !force) {
      renderDetail(token, cached, li, idx);
      return;
    }

    const wEls = document.querySelectorAll(`.w[data-line="${li}"][data-idx="${idx}"]`);
    wEls.forEach(el => el.classList.add('loading'));
    showPanel('loading');
    if (deep) {
      document.getElementById('panel-loading').querySelector('.mark-sub').textContent = 'Double-checking with extended reasoning…';
    } else {
      document.getElementById('panel-loading').querySelector('.mark-sub').textContent = 'Consulting the glossary…';
    }

    const reqId = ++pendingRequests;
    try {
      const gloss = await fetchGloss(token.w, li, deep);
      if (reqId !== pendingRequests) return;
      if (deep) gloss.deep = true;
      doc.glosses[key] = gloss;
      saveDoc();
      refreshGlossedMarkers();
      renderDetail(token, gloss, li, idx);
    } catch (err) {
      if (reqId !== pendingRequests) return;
      panelErrorMsg.textContent = err.message || 'Gloss request failed.';
      btnRetry.onclick = () => selectWord(li, idx, { force, deep });
      showPanel('error');
    } finally {
      wEls.forEach(el => el.classList.remove('loading'));
    }
  }

  // —————— Edit mode ——————
  function enterEditMode() {
    if (activeLine === null) return;
    const key = vocabKey(activeLine, activeIdx);
    const gloss = doc.glosses[key];
    if (!gloss) return;
    editMode = true;
    detail.classList.add('editing');

    dForm.contentEditable = 'true';
    dPos.contentEditable  = 'true';
    dLemma.contentEditable = 'true';
    dGloss.contentEditable = 'true';
    dEtym.contentEditable  = 'true';
    // Replace parse chips with raw comma-separated text for editing
    dParse.innerHTML = '';
    dParse.textContent = gloss.parse || '';
    dParse.contentEditable = 'true';

    actSave.hidden = true;
    actDeep.hidden = true;
    actNext.hidden = true;
    actEdit.hidden = true;
    actEditSave.hidden = false;
    actEditCancel.hidden = false;

    dForm.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(dForm);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function exitEditMode(save) {
    editMode = false;
    detail.classList.remove('editing');

    if (save && activeLine !== null) {
      const key = vocabKey(activeLine, activeIdx);
      const gloss = doc.glosses[key];
      const token = doc.lines[activeLine] && doc.lines[activeLine][activeIdx];
      if (gloss && token) {
        const newForm  = dForm.textContent.trim();
        const newPos   = dPos.textContent.trim();
        const newLemma = dLemma.textContent.trim();
        const newGloss = dGloss.textContent.trim();
        const newParse = dParse.textContent.trim();
        const newEtym  = dEtym.textContent.trim();
        const wordChanged = newForm && newForm !== token.w;

        if (newPos)   gloss.pos   = newPos;
        if (newLemma) gloss.lemma = newLemma;
        if (newGloss) gloss.gloss = newGloss;
        gloss.parse     = newParse;
        gloss.etymology = newEtym;

        if (wordChanged) {
          token.w = newForm;
          delete token.display;
          const ve = doc.vocab.find(v => v.key === key);
          if (ve) { ve.w = newForm; ve.gloss = newGloss || ve.gloss; }
          renderVocab();
        }
        saveDoc();
        if (wordChanged) {
          renderFolio();
          document.querySelectorAll(`.w[data-line="${activeLine}"][data-idx="${activeIdx}"]`)
            .forEach(el => el.classList.add('active'));
        }
      }
    }

    [dForm, dPos, dLemma, dGloss, dParse, dEtym].forEach(el => {
      el.contentEditable = 'false';
    });
    actSave.hidden = false;
    actDeep.hidden = false;
    actNext.hidden = false;
    actEdit.hidden = false;
    actEditSave.hidden = true;
    actEditCancel.hidden = true;

    // Re-render detail to restore chips and proper formatting
    if (activeLine !== null) {
      const key = vocabKey(activeLine, activeIdx);
      const gloss = doc.glosses[key];
      const token = doc.lines[activeLine] && doc.lines[activeLine][activeIdx];
      if (gloss && token) renderDetail(token, gloss, activeLine, activeIdx);
    }
  }

  function deepCheckCurrent() {
    if (activeLine === null) return;
    selectWord(activeLine, activeIdx, { force: true, deep: true });
  }

  function renderDetail(token, gloss, li, idx) {
    dForm.textContent  = token.w;
    dPos.textContent   = gloss.pos || '—';
    dLemma.textContent = gloss.lemma || '—';
    dGloss.textContent = (gloss.gloss || '—').replace(/^./, c => c.toUpperCase());
    dParse.innerHTML   = fmtParse(gloss.parse);
    dLine.textContent  = `${li + 1} of ${doc.lines.length}`;
    dContext.textContent = doc.lineText[li] || '';
    dContext.className = 'context-line';
    dEtym.textContent = gloss.etymology || '—';

    const saved = doc.vocab.some(v => v.key === vocabKey(li, idx));
    actSave.textContent = saved ? '✓ Saved' : '✦ Save';
    actSave.classList.toggle('saved-on', saved);

    actDeep.textContent = gloss.deep ? '✓ Deep-verified' : '⁂ Double-check';
    actDeep.classList.toggle('verified-on', !!gloss.deep);

    showPanel('detail');
  }

  async function fetchGloss(word, lineIdx, deep) {
    const res = await fetch('/api/gloss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        word,
        lineText: stripWordDots(doc.lineText[lineIdx] || ''),
        documentTitle: doc.title || '',
        documentMeta: doc.meta || '',
        deep: !!deep,
      }),
    });
    if (!res.ok) {
      let msg = `Server returned ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return await res.json();
  }

  function clearSelection() {
    document.querySelectorAll('.w.active').forEach(el => el.classList.remove('active'));
    activeLine = activeIdx = null;
    hint.textContent = '— select a word —';
    showPanel('empty');
  }

  function nextWord() {
    const lines = doc.lines;
    if (!lines.length) return;
    let i = activeLine ?? 0;
    let j = activeIdx !== null ? activeIdx + 1 : 0;
    while (i < lines.length) {
      while (j < lines[i].length) {
        if (lines[i][j] && lines[i][j].w) { selectWord(i, j); return; }
        j++;
      }
      i++; j = 0;
    }
    selectWord(0, firstWordIdx(0));
  }

  function firstWordIdx(li) {
    const tokens = doc.lines[li] || [];
    for (let j = 0; j < tokens.length; j++) {
      if (tokens[j].w) return j;
    }
    return 0;
  }

  // —————— Vocabulary ——————
  function renderVocab() {
    vocabList.innerHTML = '';
    if (doc.vocab.length === 0) {
      const li = document.createElement('li');
      li.className = 'vocab-empty';
      li.textContent = 'Tap ✦ on any gloss to collect words here.';
      vocabList.appendChild(li);
      vCount.textContent = 'nil saved';
      return;
    }
    doc.vocab.forEach(v => {
      const li = document.createElement('li');
      li.className = 'vocab-item';
      li.innerHTML = `
        <span class="v-word"></span>
        <span class="v-gloss"></span>
        <button class="v-del" title="Remove">×</button>
      `;
      li.querySelector('.v-word').textContent = v.w;
      li.querySelector('.v-gloss').textContent = v.gloss;
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('v-del')) return;
        const [li2, idx2] = v.key.split(':').map(Number);
        selectWord(li2, idx2);
        const el = document.querySelector(`.w[data-line="${li2}"][data-idx="${idx2}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      li.querySelector('.v-del').addEventListener('click', (e) => {
        e.stopPropagation();
        doc.vocab = doc.vocab.filter(x => x.key !== v.key);
        saveDoc();
        refreshSavedMarkers();
        renderVocab();
        if (activeLine !== null) {
          const k = vocabKey(activeLine, activeIdx);
          const saved = doc.vocab.some(x => x.key === k);
          actSave.textContent = saved ? '✓ Saved' : '✦ Save';
          actSave.classList.toggle('saved-on', saved);
        }
      });
      vocabList.appendChild(li);
    });
    const n = doc.vocab.length;
    vCount.textContent = n + (n === 1 ? ' word saved' : ' words saved');
  }

  function toggleSave() {
    if (activeLine === null) return;
    const key = vocabKey(activeLine, activeIdx);
    const token = doc.lines[activeLine][activeIdx];
    const gloss = doc.glosses[key];
    if (!gloss) return;
    const existing = doc.vocab.findIndex(v => v.key === key);
    if (existing >= 0) {
      doc.vocab.splice(existing, 1);
    } else {
      doc.vocab.unshift({
        key,
        w: token.w,
        lemma: gloss.lemma,
        pos: gloss.pos,
        gloss: gloss.gloss,
      });
    }
    saveDoc();
    refreshSavedMarkers();
    renderVocab();
    const saved = doc.vocab.some(v => v.key === key);
    actSave.textContent = saved ? '✓ Saved' : '✦ Save';
    actSave.classList.toggle('saved-on', saved);
  }

  // —————— Modal / New text ——————
  function openModal() {
    inTitle.value = doc.title || '';
    inMeta.value  = doc.meta  || '';
    inSub.value   = doc.subtitle || '';
    inText.value  = linesToPlainText(doc.lines, doc.paraBreaks);
    modal.classList.add('on');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => inText.focus(), 50);
  }
  function closeModal() {
    modal.classList.remove('on');
    modal.setAttribute('aria-hidden', 'true');
  }

  function linesToPlainText(lines, paraBreaks) {
    const breakSet = new Set(paraBreaks || []);
    return (lines || []).map((tokens, i) => {
      const text = tokens.map((t, j) => {
        if (t.w) return (j > 0 ? ' ' : '') + (t.display || t.w);
        return t.punct || '';
      }).join('').replace(/\s+([,.;:!?])/g, '$1').trim();
      return breakSet.has(i) ? '\n' + text : text;
    }).join('\n');
  }

  function loadNewText() {
    const title = inTitle.value.trim();
    const meta  = inMeta.value.trim();
    const sub   = inSub.value.trim();
    const text  = inText.value;
    if (!text.trim()) {
      toast('Paste some text first', true);
      return;
    }
    const { lines, lineText, paraBreaks } = tokenizeText(text);
    if (!lines.length) {
      toast('No readable words found', true);
      return;
    }
    doc = emptyDoc();
    doc.title = title;
    doc.meta  = meta;
    doc.subtitle = sub;
    doc.lines = lines;
    doc.lineText = lineText;
    doc.paraBreaks = paraBreaks;
    activeLine = activeIdx = null;
    saveDoc();
    renderFolio();
    renderVocab();
    showPanel('empty');
    closeModal();
    toast('Text loaded');
  }

  // —————— Import / Export ——————
  function exportDoc() {
    if (!doc.lines.length) {
      toast('Nothing to export', true);
      return;
    }
    syncHeaderFromDom();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeTitle = (doc.title || 'old-english-text').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'text';
    a.download = safeTitle + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Exported');
  }

  // —————— Anki CSV export ——————
  const POS_FULL = {
    'n.': 'Noun', 'v.': 'Verb', 'adj.': 'Adjective', 'adv.': 'Adverb',
    'pron.': 'Pronoun', 'prep.': 'Preposition', 'conj.': 'Conjunction',
    'interj.': 'Interjection', 'num.': 'Numeral', 'art.': 'Article',
    'part.': 'Particle', 'prop.n.': 'Proper noun',
  };

  function csvEscape(s) {
    const str = String(s == null ? '' : s);
    return '"' + str.replace(/"/g, '""') + '"';
  }

  function wordOccurrenceIdx(lineTokens, idx) {
    const target = lineTokens[idx] && lineTokens[idx].w;
    if (!target) return 0;
    let count = 0;
    for (let j = 0; j < idx; j++) {
      if (lineTokens[j] && lineTokens[j].w === target) count++;
    }
    return count;
  }

  function boldNthOccurrence(context, needle, occurrenceIdx) {
    if (!context || !needle) return context || '';
    // Escape regex metachars, then relax whitespace-around-middle-dot so both
    // "ā · scēaf" and "ā·scēaf" in the source match a single display form.
    let pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = pattern.replace(/\s*[\u00B7\u2027\u22C5]\s*/g, '\\s*[\\u00B7\\u2027\\u22C5]\\s*');
    let re;
    try {
      re = new RegExp('(?<![\\p{L}\\p{M}])' + pattern + '(?![\\p{L}\\p{M}])', 'gu');
    } catch (_) {
      re = new RegExp(pattern, 'g');
    }
    let count = 0;
    let replaced = false;
    const out = context.replace(re, (m) => {
      if (!replaced && count === occurrenceIdx) {
        replaced = true;
        count++;
        return '<b>' + m + '</b>';
      }
      count++;
      return m;
    });
    if (!replaced) {
      try {
        const fallback = new RegExp(pattern, 'u');
        return context.replace(fallback, (m) => '<b>' + m + '</b>');
      } catch (_) {
        return context;
      }
    }
    return out;
  }

  function buildAnkiRows() {
    const rows = [];
    for (const v of doc.vocab) {
      const [liStr, idxStr] = v.key.split(':');
      const li = Number(liStr), idx = Number(idxStr);
      const gloss = doc.glosses[v.key] || {};
      const token = (doc.lines[li] && doc.lines[li][idx]) || { w: v.w };
      const context = doc.lineText[li] || token.w || '';
      const occ = wordOccurrenceIdx(doc.lines[li] || [], idx);
      const needle = token.display || token.w || v.w;
      const frontCtx = boldNthOccurrence(context, needle, occ);

      const lemma = gloss.lemma || v.lemma || '';
      const meaning = gloss.gloss || v.gloss || '';
      const grammar = gloss.parse || '';
      const posFull = gloss.posFull || POS_FULL[gloss.pos || v.pos] || (gloss.pos || v.pos || '');
      const etymology = gloss.etymology || '';

      const back =
        '<p><b>Meaning:</b> ' + meaning + '</p>' +
        '<p><b>Grammar:</b> ' + grammar + '</p>' +
        '<p><i>' + posFull + '</i></p>' +
        (etymology ? '<small>' + etymology + '</small>' : '');

      rows.push([lemma, frontCtx, back]);
    }
    return rows;
  }

  function exportAnkiCsv() {
    if (!doc.vocab.length) {
      toast('Vocabulary is empty', true);
      return;
    }
    const header = ['Lemma (Root)', 'Context Sentence (Front)', 'Definition & Grammar (Back)'];
    const rows = buildAnkiRows();
    const lines = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
    // UTF-8 BOM so Excel / Anki open macrons correctly
    const csv = '\uFEFF' + lines + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeTitle = (doc.title || 'old-english-vocab').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vocab';
    a.download = safeTitle + '-anki.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Exported ' + rows.length + ' cards');
  }

  function importDoc(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.lines)) throw new Error('Invalid file');
        doc = migrate(parsed);
        activeLine = activeIdx = null;
        saveDoc();
        renderFolio();
        renderVocab();
        showPanel('empty');
        toast('Imported');
      } catch (e) {
        toast('Import failed: ' + (e.message || 'bad JSON'), true);
      }
    };
    reader.onerror = () => toast('Could not read file', true);
    reader.readAsText(file);
  }

  function syncHeaderFromDom() {
    if (!doc.lines.length) return;
    doc.title    = folioTitle.textContent.trim();
    doc.meta     = folioMeta.textContent.trim();
    doc.subtitle = folioSub.textContent.trim();
    saveDoc();
  }

  // —————— Server library ——————
  async function apiRequest(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = `Server returned ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error) msg = body.error;
      } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  function serverListDocs()        { return apiRequest('/api/docs'); }
  function serverLoadDoc(slug)     { return apiRequest('/api/docs/' + encodeURIComponent(slug)); }
  function serverDeleteDoc(slug)   { return apiRequest('/api/docs/' + encodeURIComponent(slug), { method: 'DELETE' }); }
  function serverSaveDoc(slug, d)  {
    return apiRequest('/api/docs/' + encodeURIComponent(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
  }

  function openLibrary() {
    libSaveSlug.value = defaultSlug();
    libSaveHint.textContent = 'Lowercase letters, digits, and hyphens.';
    libSaveHint.classList.remove('err');
    btnLibExport.disabled = !doc.lines.length;
    btnLibSave.disabled = !doc.lines.length;
    libModal.classList.add('on');
    libModal.setAttribute('aria-hidden', 'false');
    refreshLibrary();
    setTimeout(() => libSaveSlug.focus(), 50);
  }

  function closeLibrary() {
    libModal.classList.remove('on');
    libModal.setAttribute('aria-hidden', 'true');
  }

  async function refreshLibrary() {
    libError.hidden = true;
    libError.textContent = '';
    libList.innerHTML = '';
    libEmpty.hidden = true;
    try {
      const data = await serverListDocs();
      const docs = (data && data.docs) || [];
      if (!docs.length) {
        libEmpty.hidden = false;
        return;
      }
      for (const d of docs) {
        libList.appendChild(renderLibraryItem(d));
      }
    } catch (e) {
      libError.hidden = false;
      libError.textContent = 'Could not load library: ' + (e.message || 'error');
    }
  }

  function renderLibraryItem(entry) {
    const li = document.createElement('li');
    li.className = 'lib-item';

    const main = document.createElement('div');
    main.className = 'lib-item-main';
    const title = document.createElement('div');
    title.className = 'lib-item-title';
    title.textContent = entry.title || entry.slug;
    const sub = document.createElement('div');
    sub.className = 'lib-item-sub';
    const parts = [entry.slug];
    if (entry.lineCount) parts.push(entry.lineCount + ' lines');
    if (entry.vocabCount) parts.push(entry.vocabCount + ' saved');
    parts.push(relativeTime(entry.modifiedAt));
    sub.textContent = parts.join(' · ');
    main.appendChild(title);
    main.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'lib-item-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'foot-btn';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); loadFromServer(entry.slug); });
    const delBtn = document.createElement('button');
    delBtn.className = 'foot-btn lib-item-del';
    delBtn.textContent = 'Delete';
    delBtn.title = 'Delete from server';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteFromServer(entry); });
    actions.appendChild(openBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    li.addEventListener('click', () => loadFromServer(entry.slug));
    return li;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diffSec = Math.round((Date.now() - then) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
    if (diffSec < 86400 * 30) return Math.floor(diffSec / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  async function saveToServer() {
    if (!doc.lines.length) { toast('Nothing to save', true); return; }
    syncHeaderFromDom();
    const slug = (libSaveSlug.value || '').trim();
    if (!SLUG_RE.test(slug)) {
      libSaveHint.textContent = 'Use only a-z, 0-9, and hyphens (max 64 chars, must start alphanumeric).';
      libSaveHint.classList.add('err');
      libSaveSlug.focus();
      return;
    }
    btnLibSave.disabled = true;
    try {
      await serverSaveDoc(slug, doc);
      doc.serverSlug = slug;
      saveDoc();
      libSaveHint.textContent = 'Saved as ' + slug + '.json';
      libSaveHint.classList.remove('err');
      toast('Saved to server');
      refreshLibrary();
    } catch (e) {
      libSaveHint.textContent = 'Save failed: ' + (e.message || 'error');
      libSaveHint.classList.add('err');
    } finally {
      btnLibSave.disabled = false;
    }
  }

  async function loadFromServer(slug) {
    try {
      const loaded = await serverLoadDoc(slug);
      if (!loaded || !Array.isArray(loaded.lines)) throw new Error('Invalid document');
      doc = migrate(loaded);
      doc.serverSlug = slug;
      activeLine = activeIdx = null;
      saveDoc();
      renderFolio();
      renderVocab();
      showPanel('empty');
      closeLibrary();
      toast('Opened ' + slug);
    } catch (e) {
      libError.hidden = false;
      libError.textContent = 'Open failed: ' + (e.message || 'error');
    }
  }

  async function deleteFromServer(entry) {
    if (!confirm('Delete "' + (entry.title || entry.slug) + '" from the server?')) return;
    try {
      await serverDeleteDoc(entry.slug);
      if (doc.serverSlug === entry.slug) {
        doc.serverSlug = null;
        saveDoc();
      }
      toast('Deleted ' + entry.slug);
      refreshLibrary();
    } catch (e) {
      libError.hidden = false;
      libError.textContent = 'Delete failed: ' + (e.message || 'error');
    }
  }

  // —————— Toast ——————
  let toastEl = null;
  let toastTimer = null;
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isError);
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2200);
  }

  // —————— Event wiring ——————
  poem.addEventListener('click', (e) => {
    const w = e.target.closest('.w, .drop-clickable');
    if (!w || !w.dataset.line) return;
    selectWord(+w.dataset.line, +w.dataset.idx);
  });

  btnReset.addEventListener('click', clearSelection);
  actSave.addEventListener('click', toggleSave);
  actDeep.addEventListener('click', deepCheckCurrent);
  actNext.addEventListener('click', nextWord);
  actEdit.addEventListener('click', enterEditMode);
  actEditSave.addEventListener('click', () => exitEditMode(true));
  actEditCancel.addEventListener('click', () => exitEditMode(false));
  btnNew.addEventListener('click', openModal);
  btnPasteEmpty.addEventListener('click', openModal);
  btnLoad.addEventListener('click', loadNewText);
  btnExportCsv.addEventListener('click', exportAnkiCsv);
  btnLibrary.addEventListener('click', openLibrary);
  btnLibSave.addEventListener('click', saveToServer);
  btnLibImport.addEventListener('click', () => fileInput.click());
  btnLibExport.addEventListener('click', () => { closeLibrary(); exportDoc(); });
  libSaveSlug.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveToServer(); }
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) { importDoc(file); closeLibrary(); }
    fileInput.value = '';
  });

  modal.addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined) closeModal();
  });
  libModal.addEventListener('click', (e) => {
    if (e.target.dataset.closeLib !== undefined) closeLibrary();
  });

  [folioTitle, folioMeta, folioSub].forEach(el => {
    el.addEventListener('blur', syncHeaderFromDom);
  });

  document.addEventListener('keydown', (e) => {
    if (libModal.classList.contains('on')) {
      if (e.key === 'Escape') closeLibrary();
      return;
    }
    if (modal.classList.contains('on')) {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); loadNewText(); }
      return;
    }
    if (editMode) {
      if (e.key === 'Escape') { e.preventDefault(); exitEditMode(false); }
      return;
    }
    if (e.target && (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape') clearSelection();
    if (e.key === 'ArrowRight' || e.key === ' ') {
      if (doc.lines.length) { nextWord(); e.preventDefault(); }
    }
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleSave(); }
  });

  // Initial render
  renderFolio();
  renderVocab();
  showPanel('empty');
})();
