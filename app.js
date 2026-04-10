/* ═══════════════════════════════════════════════════════════════
   KENOKI — app.js
   Single-file app logic: Supabase → vis-network + chat + smart input
   ═══════════════════════════════════════════════════════════════ */

const SB_URL = 'https://verhpfznevahwxfawnwn.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlcmhwZnpuZXZhaHd4ZmF3bnduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTczODIsImV4cCI6MjA5MTE3MzM4Mn0.b9RyBQ6UbJQRZ3VZp4xzHr4HIFnG-MHnyoaDnx2eXxk';
const OLLAMA_URL = 'http://localhost:11434/api/chat';

const sb = supabase.createClient(SB_URL, SB_ANON);

// ── User state ──
let currentUser = null;
let userPrefs = null; // { ai_provider, ai_api_key }

function getModel() {
  if (!userPrefs || userPrefs.ai_provider === 'ollama') return 'ministral-3:8b';
  if (userPrefs.ai_provider === 'openai') return 'gpt-4o-mini';
  if (userPrefs.ai_provider === 'claude') return 'claude-sonnet-4-20250514';
  return 'ministral-3:8b';
}

async function chatWithProvider(messages, onToken, onDone) {
  const provider = userPrefs?.ai_provider || 'ollama';

  if (provider === 'ollama') {
    // Stream from Ollama
    const res = await fetch(OLLAMA_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getModel(), messages, stream: true }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.message?.content) onToken(j.message.content); } catch {}
      }
    }
    onDone();
  } else if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userPrefs.ai_api_key },
      body: JSON.stringify({ model: getModel(), messages, stream: true }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try { const j = JSON.parse(line.slice(6)); if (j.choices?.[0]?.delta?.content) onToken(j.choices[0].delta.content); } catch {}
      }
    }
    onDone();
  } else if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': userPrefs.ai_api_key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: getModel(), max_tokens: 2048, stream: true,
        system: messages.find(m => m.role === 'system')?.content || '',
        messages: messages.filter(m => m.role !== 'system'),
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const j = JSON.parse(line.slice(6));
          if (j.type === 'content_block_delta' && j.delta?.text) onToken(j.delta.text);
        } catch {}
      }
    }
    onDone();
  }
}

async function chatWithProviderSync(messages) {
  const provider = userPrefs?.ai_provider || 'ollama';
  if (provider === 'ollama') {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: getModel(), messages, stream: false, options: { temperature: 0.1 } }),
    });
    const d = await res.json();
    return d.message?.content || '';
  } else if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userPrefs.ai_api_key },
      body: JSON.stringify({ model: getModel(), messages, temperature: 0.1 }),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content || '';
  } else if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': userPrefs.ai_api_key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: getModel(), max_tokens: 2048,
        system: messages.find(m => m.role === 'system')?.content || '',
        messages: messages.filter(m => m.role !== 'system'),
        temperature: 0.1,
      }),
    });
    const d = await res.json();
    return d.content?.[0]?.text || '';
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

let authMode = 'signin'; // 'signin' | 'signup'

function setupAuth() {
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-password');
  const submitEl = document.getElementById('auth-submit');
  const toggleEl = document.getElementById('auth-toggle');
  const errorEl = document.getElementById('auth-error');

  toggleEl.addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    submitEl.textContent = authMode === 'signin' ? 'Sign in' : 'Sign up';
    toggleEl.innerHTML = authMode === 'signin'
      ? 'No account? <span>Sign up</span>'
      : 'Already have an account? <span>Sign in</span>';
    errorEl.classList.add('hidden');
  });

  submitEl.addEventListener('click', async () => {
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) return;

    errorEl.classList.add('hidden');
    submitEl.disabled = true;
    submitEl.textContent = 'Loading...';

    try {
      if (authMode === 'signup') {
        const { error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        // Show confirmation message
        document.getElementById('auth-form').classList.add('hidden');
        document.getElementById('auth-confirm').classList.remove('hidden');
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        currentUser = data.user;
        hide('auth-overlay');
        await onAuthenticated();
      }
    } catch (e) {
      errorEl.textContent = e.message || 'Authentication failed.';
      errorEl.classList.remove('hidden');
    }

    submitEl.disabled = false;
    submitEl.textContent = authMode === 'signin' ? 'Sign in' : 'Sign up';
  });

  // Enter key
  [emailEl, passEl].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') submitEl.click(); });
  });

  // Back to sign in from confirmation
  document.getElementById('auth-back').addEventListener('click', () => {
    document.getElementById('auth-form').classList.remove('hidden');
    document.getElementById('auth-confirm').classList.add('hidden');
    authMode = 'signin';
    document.getElementById('auth-submit').textContent = 'Sign in';
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });
}

async function onAuthenticated() {
  // Load preferences
  const { data: prefs } = await sb.from('user_preferences').select('*').eq('user_id', currentUser.id).single();
  userPrefs = prefs;

  if (!userPrefs) {
    // First-time user — show provider selection
    show('provider-overlay');
  } else {
    // Check if user has any contacts
    const { count } = await sb.from('people').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id);
    if (count === 0) {
      // Skip LinkedIn guide — go straight to upload
      document.getElementById('import-step-1')?.classList.add('hidden');
      document.getElementById('import-step-2')?.classList.remove('hidden');
      show('import-overlay');
    } else {
      await startApp();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER SELECTION
// ═══════════════════════════════════════════════════════════════

function setupProvider() {
  let selectedProvider = null;

  document.querySelectorAll('.provider-option').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.provider-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedProvider = btn.dataset.provider;

      const keyArea = document.getElementById('provider-key-area');
      if (selectedProvider === 'ollama') {
        keyArea.classList.add('hidden');
      } else {
        keyArea.classList.remove('hidden');
        document.getElementById('provider-key').placeholder =
          selectedProvider === 'openai' ? 'sk-...' : 'sk-ant-...';
      }
      document.getElementById('provider-save').classList.remove('hidden');
    });
  });

  document.getElementById('provider-save').addEventListener('click', async () => {
    if (!selectedProvider) return;
    const apiKey = selectedProvider !== 'ollama' ? document.getElementById('provider-key').value.trim() : null;

    if (selectedProvider !== 'ollama' && !apiKey) {
      document.getElementById('provider-key').style.borderColor = 'var(--red)';
      return;
    }

    await sb.from('user_preferences').insert({
      user_id: currentUser.id,
      ai_provider: selectedProvider,
      ai_api_key: apiKey,
    });

    userPrefs = { ai_provider: selectedProvider, ai_api_key: apiKey };
    hide('provider-overlay');

    // Check if user has contacts
    const { count } = await sb.from('people').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id);
    if (count === 0) {
      show('import-overlay');
    } else {
      await startApp();
    }
  });

  // Skip AI provider — go straight to import or app
  document.getElementById('provider-skip').addEventListener('click', async () => {
    // Save default (no AI) so we don't ask again
    await sb.from('user_preferences').insert({
      user_id: currentUser.id,
      ai_provider: 'none',
      ai_api_key: null,
    });
    userPrefs = { ai_provider: 'none', ai_api_key: null };
    hide('provider-overlay');

    const { count } = await sb.from('people').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id);
    if (count === 0) {
      show('import-overlay');
    } else {
      await startApp();
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// CONTACT IMPORT — Multi-source parser
// ═══════════════════════════════════════════════════════════════

let importRows = [];
let detectedFormat = '';

// ── Find real CSV header (skip LinkedIn preamble/disclaimer lines) ──
function findHeaderLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('first name') || lower.includes('given name') ||
        (lower.includes('name') && lower.includes(','))) {
      return { headerIndex: i, lines };
    }
  }
  return { headerIndex: 0, lines };
}

// ── Format detection ──
function detectFormat(text, fileName) {
  const fn = fileName.toLowerCase();
  if (fn.endsWith('.vcf') || text.trimStart().startsWith('BEGIN:VCARD')) return 'vcard';
  if (fn.endsWith('.json') && (text.includes('friends_v2') || text.includes('"friends"'))) return 'facebook-json';
  if (fn.endsWith('.json')) return 'facebook-json'; // fallback for any JSON
  if (fn.endsWith('.html') && text.includes('Your friends')) return 'facebook-html';
  // Search first 10 lines for header (LinkedIn has 3 lines of preamble)
  const { headerIndex, lines } = findHeaderLine(text);
  const headerLine = (lines[headerIndex] || '').toLowerCase();
  if ((headerLine.includes('given name') && headerLine.includes('family name')) ||
      headerLine.includes('organization name') || headerLine.includes('e-mail 1 - value') ||
      headerLine.includes('phone 1 - value')) return 'google-csv';
  if (headerLine.includes('business phone') || headerLine.includes('business street')) return 'outlook-csv';
  if (headerLine.includes('first name') && headerLine.includes('connected on')) return 'linkedin-csv';
  return 'generic-csv';
}

const FORMAT_LABELS = {
  'vcard': 'vCard (iPhone / iCloud)',
  'facebook-json': 'Facebook JSON',
  'facebook-html': 'Facebook HTML',
  'google-csv': 'Google Contacts CSV',
  'outlook-csv': 'Outlook CSV',
  'linkedin-csv': 'LinkedIn CSV',
  'generic-csv': 'CSV',
};

// Tags that describe the import pipeline, not the person — never shown to users
const IMPORT_SOURCE_TAGS = new Set([
  'linkedin-import', 'google-import', 'outlook-import',
  'vcard-import', 'facebook-import', 'csv-import', 'import',
]);

// ── Unified parse entry point ──
function parseContactFile(text, fileName) {
  detectedFormat = detectFormat(text, fileName);
  switch (detectedFormat) {
    case 'vcard': return parseVCard(text);
    case 'facebook-json': return parseFacebookJSON(text);
    case 'facebook-html': return parseFacebookHTML(text);
    case 'google-csv': return parseGoogleCSV(text);
    case 'outlook-csv': return parseOutlookCSV(text);
    case 'linkedin-csv': return parseLinkedInCSV(text);
    default: return parseGenericCSV(text);
  }
}

// ── Shared utilities ──

function stripBOM(text) { return text.replace(/^\uFEFF/, ''); }

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  // LinkedIn "DD Mon YYYY" (e.g. "08 Apr 2026")
  const ddMonYYYY = str.match(/^(\d{1,2})\s+(\w{3,})\s+(\d{4})$/);
  if (ddMonYYYY) {
    const d = new Date(`${ddMonYYYY[2]} ${ddMonYYYY[1]}, ${ddMonYYYY[3]}`);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function unescapeVCard(str) {
  if (!str) return str;
  return str.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
}

// Exact match first, then substring fallback
function findCol(header, ...keywords) {
  for (const k of keywords) {
    const exact = header.findIndex(h => h === k);
    if (exact >= 0) return exact;
  }
  return header.findIndex(h => keywords.some(k => h.includes(k)));
}

// ── LinkedIn CSV ──
function parseLinkedInCSV(text) {
  // Skip preamble (LinkedIn puts 2-3 disclaimer lines before the header)
  const { headerIndex, lines } = findHeaderLine(text);
  const dataLines = lines.slice(headerIndex).filter(l => l.trim());
  if (dataLines.length < 2) return [];

  const header = parseCSVLine(dataLines[0]).map(h => h.trim().toLowerCase());
  const fnIdx = findCol(header, 'first name');
  const lnIdx = findCol(header, 'last name');
  const urlIdx = findCol(header, 'url');
  const emailIdx = findCol(header, 'email');
  const compIdx = findCol(header, 'company');
  const posIdx = findCol(header, 'position');
  const dateIdx = findCol(header, 'connected');

  const rows = [];
  for (let i = 1; i < dataLines.length; i++) {
    const cols = parseCSVLine(dataLines[i]);
    const first = (cols[fnIdx] || '').trim();
    const last = (cols[lnIdx] || '').trim();
    if (!first && !last) continue;
    const url = (cols[urlIdx] || '').trim();
    rows.push({
      full_name: (first + ' ' + last).trim(),
      email: (cols[emailIdx] || '').trim() || null,
      phone: null,
      company: (cols[compIdx] || '').trim() || null,
      position: (cols[posIdx] || '').trim() || null,
      connected_on: (cols[dateIdx] || '').trim() || null,
      linkedin_url: url || null,
    });
  }
  return rows;
}

// ── Google Contacts CSV ──
function parseGoogleCSV(text) {
  text = stripBOM(text);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  // Google uses "First Name"/"Last Name" or "Given Name"/"Family Name"
  const fnIdx = findCol(header, 'first name', 'given name');
  const lnIdx = findCol(header, 'last name', 'family name');
  // Exact match for value columns (not labels)
  const emailIdx = findCol(header, 'e-mail 1 - value');
  const phoneIdx = findCol(header, 'phone 1 - value');
  const orgIdx = findCol(header, 'organization name', 'organization 1 - name');
  const titleIdx = findCol(header, 'organization title', 'organization 1 - title');
  const notesIdx = findCol(header, 'notes');
  const groupIdx = findCol(header, 'labels', 'group membership');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const first = (cols[fnIdx] || '').trim();
    const last = (cols[lnIdx] || '').trim();
    const name = (first + ' ' + last).trim();
    if (!name) continue;
    rows.push({
      full_name: name,
      email: (cols[emailIdx] || '').trim() || null,
      phone: (cols[phoneIdx] || '').trim() || null,
      company: (cols[orgIdx] || '').trim() || null,
      position: (cols[titleIdx] || '').trim() || null,
      connected_on: null,
      notes: (cols[notesIdx] || '').trim() || null,
      tags_raw: (cols[groupIdx] || '').trim() || null,
    });
  }
  return rows;
}

// ── Outlook CSV ──
function parseOutlookCSV(text) {
  text = stripBOM(text);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const fnIdx = findCol(header, 'first name');
  const lnIdx = findCol(header, 'last name');
  const emailIdx = findCol(header, 'e-mail address', 'email address');
  const phoneIdx = findCol(header, 'mobile phone', 'business phone');
  const compIdx = findCol(header, 'company');
  const titleIdx = findCol(header, 'job title');
  const notesIdx = findCol(header, 'notes');
  const catIdx = findCol(header, 'categories');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const first = cols[fnIdx]?.trim() || '';
    const last = cols[lnIdx]?.trim() || '';
    if (!first && !last) continue;
    rows.push({
      full_name: (first + ' ' + last).trim(),
      email: cols[emailIdx]?.trim() || null,
      phone: cols[phoneIdx]?.trim() || null,
      company: cols[compIdx]?.trim() || null,
      position: cols[titleIdx]?.trim() || null,
      connected_on: null,
      notes: cols[notesIdx]?.trim() || null,
      tags_raw: cols[catIdx]?.trim() || null,
    });
  }
  return rows;
}

// ── Generic CSV (fuzzy header matching) ──
function parseGenericCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  // Fuzzy match columns
  const nameIdx = findCol(header, 'full name', 'name', 'contact name', 'full_name');
  const fnIdx = findCol(header, 'first name', 'first_name', 'given name');
  const lnIdx = findCol(header, 'last name', 'last_name', 'family name', 'surname');
  const emailIdx = findCol(header, 'email', 'e-mail', 'email address');
  const phoneIdx = findCol(header, 'phone', 'mobile', 'telephone', 'tel', 'phone number');
  const compIdx = findCol(header, 'company', 'organization', 'org', 'organisation');
  const posIdx = findCol(header, 'title', 'job title', 'position', 'role', 'occupation');
  const notesIdx = findCol(header, 'notes', 'comments', 'remarks', 'description');
  const tagsIdx = findCol(header, 'tags', 'categories', 'groups', 'labels');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    let name = '';
    if (nameIdx >= 0) name = cols[nameIdx]?.trim() || '';
    if (!name && fnIdx >= 0) name = ((cols[fnIdx]?.trim() || '') + ' ' + (cols[lnIdx]?.trim() || '')).trim();
    if (!name) continue;
    rows.push({
      full_name: name,
      email: cols[emailIdx]?.trim() || null,
      phone: cols[phoneIdx]?.trim() || null,
      company: cols[compIdx]?.trim() || null,
      position: cols[posIdx]?.trim() || null,
      connected_on: null,
      notes: cols[notesIdx]?.trim() || null,
      tags_raw: cols[tagsIdx]?.trim() || null,
    });
  }
  return rows;
}

// ── vCard parser ──
function parseVCard(text) {
  // Unfold continuation lines (RFC 6350: line starting with space/tab is continuation)
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const cards = unfolded.split('BEGIN:VCARD').slice(1);
  const rows = [];
  for (const card of cards) {
    const lines = card.split(/\r?\n/);
    let name = '', org = '', title = '', email = '', phone = '', notes = '';
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.substring(0, colonIdx);
      const val = line.substring(colonIdx + 1).trim();
      const keyBase = key.split(';')[0].toUpperCase();
      if (keyBase === 'FN') name = unescapeVCard(val);
      else if (keyBase === 'ORG' && !org) org = unescapeVCard(val).replace(/;+$/, '').replace(/;/g, ', ').trim();
      else if (keyBase === 'TITLE' && !title) title = unescapeVCard(val);
      else if (keyBase === 'EMAIL' && !email) email = val;
      else if (keyBase === 'TEL' && !phone) phone = val;
      else if (keyBase === 'NOTE' && !notes) notes = unescapeVCard(val);
    }
    if (!name) continue;
    rows.push({
      full_name: name.trim(),
      email: email || null,
      phone: phone || null,
      company: org || null,
      position: title || null,
      connected_on: null,
      notes: notes || null,
    });
  }
  return rows;
}

// ── Facebook JSON ──
function parseFacebookJSON(text) {
  try {
    const data = JSON.parse(text);
    const friends = data.friends_v2 || data.friends || data;
    if (!Array.isArray(friends)) return [];
    return friends.filter(f => f.name).map(f => ({
      full_name: f.name,
      email: null, phone: null, company: null, position: null,
      connected_on: f.timestamp ? new Date(f.timestamp * 1000).toISOString().split('T')[0] : null,
    }));
  } catch { return []; }
}

// ── Facebook HTML (alternative export format) ──
function parseFacebookHTML(text) {
  const rows = [];
  // Extract names from <h2> tags and dates from <div class="_a72d">
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');
  const sections = doc.querySelectorAll('section');
  sections.forEach(section => {
    const h2 = section.querySelector('h2');
    const dateDiv = section.querySelector('div._a72d, footer div');
    if (!h2) return;
    const name = h2.textContent.trim();
    if (!name) return;
    rows.push({
      full_name: name,
      email: null, phone: null, company: null, position: null,
      connected_on: dateDiv ? parseDate(dateDiv.textContent.trim()) : null,
    });
  });
  return rows;
}

function setupImport() {
  let guideStep = 1;

  // ── Guide navigation ──
  function showGuideStep(n) {
    guideStep = n;
    document.querySelectorAll('.guide-step').forEach(el => el.classList.remove('active'));
    document.querySelector(`.guide-step[data-step="${n}"]`).classList.add('active');
    document.querySelectorAll('.guide-dot').forEach(el => el.classList.remove('active'));
    document.querySelector(`.guide-dot[data-dot="${n}"]`).classList.add('active');
    document.getElementById('guide-prev').disabled = n === 1;
    document.getElementById('guide-next').textContent = n === 3 ? 'Upload file' : 'Next';
  }

  document.getElementById('guide-next').addEventListener('click', () => {
    if (guideStep < 3) { showGuideStep(guideStep + 1); }
    else {
      // Go to upload step
      document.getElementById('import-step-1').classList.add('hidden');
      document.getElementById('import-step-2').classList.remove('hidden');
    }
  });

  document.getElementById('guide-prev').addEventListener('click', () => {
    if (guideStep > 1) showGuideStep(guideStep - 1);
  });

  document.querySelectorAll('.guide-dot').forEach(dot => {
    dot.addEventListener('click', () => showGuideStep(+dot.dataset.dot));
  });

  document.getElementById('import-back-to-guide').addEventListener('click', () => {
    document.getElementById('import-step-2').classList.add('hidden');
    document.getElementById('import-step-1').classList.remove('hidden');
    // Reset upload state
    document.getElementById('import-preview').classList.add('hidden');
    document.getElementById('import-drop').classList.remove('hidden');
    document.getElementById('import-submit').classList.add('hidden');
    importRows = [];
    importDupes = new Set();
  });

  // ── File upload + duplicate detection ──
  const fileInput = document.getElementById('import-file');
  const preview = document.getElementById('import-preview');
  const tbody = document.getElementById('import-tbody');
  const countEl = document.getElementById('import-count');
  const dupesEl = document.getElementById('import-dupes');
  const submitBtn = document.getElementById('import-submit');
  const dropArea = document.getElementById('import-drop');

  // ── Read file (handles ZIP or text) ──
  async function readUploadedFile(file) {
    const fn = file.name.toLowerCase();
    if (fn.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(file);
      // LinkedIn ZIP — look for Connections.csv
      const linkedinFile = zip.file('Connections.csv');
      if (linkedinFile) {
        const text = await linkedinFile.async('string');
        return { text, fileName: 'Connections.csv' };
      }
      // Facebook ZIP — look for friends.json or your_friends.json or your_friends.html
      const fbJson = zip.file(/your_friends\.json$/i)[0] || zip.file(/friends\.json$/i)[0];
      if (fbJson) {
        const text = await fbJson.async('string');
        return { text, fileName: fbJson.name };
      }
      const fbHtml = zip.file(/your_friends\.html$/i)[0];
      if (fbHtml) {
        const text = await fbHtml.async('string');
        return { text, fileName: fbHtml.name };
      }
      // Fallback — first CSV or JSON found
      const anyFile = zip.file(/\.(csv|json|vcf)$/i)[0];
      if (!anyFile) { showToast('No contacts file found in ZIP.'); return null; }
      const text = await anyFile.async('string');
      return { text, fileName: anyFile.name };
    }
    // Regular text file
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => resolve({ text: ev.target.result, fileName: file.name });
      reader.readAsText(file);
    });
  }

  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    const result = await readUploadedFile(file);
    if (!result) return;

    importRows = parseContactFile(result.text, result.fileName);

    // Show detected format
    const detectedEl = document.getElementById('import-detected');
    detectedEl.textContent = 'Detected: ' + (FORMAT_LABELS[detectedFormat] || detectedFormat);
    detectedEl.classList.remove('hidden');
    if (!importRows.length) {
      showToast('No contacts found in file.');
      return;
    }

    // Check for duplicates — match by LinkedIn URL first, then by name
    const { data: existing } = await sb.from('people')
      .select('full_name, linkedin_url')
      .eq('user_id', currentUser.id);
    const existingNames = new Set((existing || []).map(p => p.full_name.toLowerCase()));
    const existingUrls = new Set((existing || []).filter(p => p.linkedin_url).map(p => p.linkedin_url));

    importDupes = new Set();
    importRows.forEach((r, i) => {
      if (r.linkedin_url && existingUrls.has(r.linkedin_url)) { importDupes.add(i); return; }
      if (existingNames.has(r.full_name.toLowerCase())) importDupes.add(i);
    });

    const newCount = importRows.length - importDupes.size;
    countEl.textContent = `${importRows.length} contacts found`;

    if (importDupes.size > 0) {
      dupesEl.textContent = `${importDupes.size} already exist`;
      dupesEl.classList.remove('hidden');
    } else {
      dupesEl.classList.add('hidden');
    }

    tbody.innerHTML = importRows.slice(0, 150).map((r, i) => {
      const isDupe = importDupes.has(i);
      return `<tr class="${isDupe ? 'row-dupe' : 'row-new'}">
        <td>${r.full_name}</td>
        <td>${r.position || ''}</td>
        <td>${r.company || ''}</td>
        <td>${r.connected_on || ''}</td>
        <td>${isDupe ? 'exists' : 'new'}</td>
      </tr>`;
    }).join('');
    if (importRows.length > 150) {
      tbody.innerHTML += `<tr><td colspan="5" style="color:var(--txt-ghost)">+${importRows.length - 150} more</td></tr>`;
    }

    preview.classList.remove('hidden');
    dropArea.classList.add('hidden');
    submitBtn.classList.remove('hidden');
    submitBtn.textContent = newCount > 0
      ? `Import ${newCount} new contact${newCount !== 1 ? 's' : ''}`
      : 'All contacts already exist';
    submitBtn.disabled = newCount === 0;
  });

  // ── Import execution with conflict handling ──
  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing...';

    let inserted = 0;
    let skipped = 0;
    let merged = 0;

    try {
      // Filter out pre-detected duplicates
      const newRows = importRows.filter((_, i) => !importDupes.has(i));

      // Dedupe companies — find or create
      const companyNames = [...new Set(newRows.map(r => r.company).filter(Boolean))];
      const companyMap = new Map();

      for (const name of companyNames) {
        try {
          const { data: existing } = await sb.from('companies')
            .select('id').eq('user_id', currentUser.id).ilike('name', name).limit(1);
          if (existing?.length) {
            companyMap.set(name, existing[0].id);
          } else {
            const { data: created, error } = await sb.from('companies')
              .insert({ name, user_id: currentUser.id }).select('id').single();
            if (created) companyMap.set(name, created.id);
            // 409 = company already exists (race condition), try to find it
            if (error?.code === '23505') {
              const { data: found } = await sb.from('companies')
                .select('id').eq('user_id', currentUser.id).ilike('name', name).limit(1);
              if (found?.length) companyMap.set(name, found[0].id);
            }
          }
        } catch { /* skip company, continue */ }
      }

      // Insert people — handle 409 conflicts by merging
      for (const r of newRows) {
        try {
          const noteParts = [];
          if (r.email) noteParts.push('Email: ' + r.email);
          if (r.notes) noteParts.push(r.notes);

          const row = {
            full_name: r.full_name,
            role: r.position || null,
            phone: r.phone || null,
            linkedin_url: r.linkedin_url || null,
            notes: noteParts.length ? noteParts.join(' | ') : null,
            last_contact: parseDate(r.connected_on),
            company_id: r.company ? companyMap.get(r.company) || null : null,
            user_id: currentUser.id,
          };

          const { data: person, error } = await sb.from('people')
            .insert(row).select('id').single();

          if (error) {
            if (error.code === '23505') {
              // 409 Conflict — person exists. Merge: update fields that are currently null.
              const { data: existing } = await sb.from('people')
                .select('id, phone, role, linkedin_url, notes, company_id')
                .eq('user_id', currentUser.id)
                .ilike('full_name', r.full_name).limit(1);

              if (existing?.length) {
                const updates = {};
                const ex = existing[0];
                if (!ex.phone && row.phone) updates.phone = row.phone;
                if (!ex.role && row.role) updates.role = row.role;
                if (!ex.linkedin_url && row.linkedin_url) updates.linkedin_url = row.linkedin_url;
                if (!ex.company_id && row.company_id) updates.company_id = row.company_id;
                // Append notes if new data exists
                if (row.notes && (!ex.notes || !ex.notes.includes(row.notes))) {
                  updates.notes = ex.notes ? ex.notes + ' | ' + row.notes : row.notes;
                }
                if (Object.keys(updates).length) {
                  await sb.from('people').update(updates).eq('id', ex.id);
                  merged++;
                } else {
                  skipped++;
                }
              } else {
                skipped++;
              }
            } else {
              skipped++;
            }
            continue;
          }

          if (person) {
            inserted++;

            // Additional tags from CSV groups/categories
            if (r.tags_raw) {
              const extraTags = r.tags_raw.split(/[;,:]/).map(t => t.trim().toLowerCase()).filter(t => t && t !== '*');
              for (const t of extraTags) {
                await sb.from('tags')
                  .insert({ person_id: person.id, tag: t, user_id: currentUser.id });
              }
            }
          }
        } catch {
          skipped++;
        }

        // Progress update every 50 contacts
        if ((inserted + skipped + merged) % 50 === 0) {
          submitBtn.textContent = `Importing... ${inserted + merged}/${newRows.length}`;
        }
      }
    } catch (e) {
      console.error('Import error:', e);
    }

    // ALWAYS show completion
    const parts = [];
    if (inserted) parts.push(`${inserted} imported`);
    if (merged) parts.push(`${merged} merged`);
    if (skipped) parts.push(`${skipped} skipped`);
    const msg = parts.join(', ') || 'No changes';

    submitBtn.textContent = msg;
    submitBtn.disabled = false;
    showToast(msg);

    setTimeout(async () => {
      hide('import-overlay');
      resetImportState();
      await loadData();
      buildGraph();
      inferEdges(); // background — generates inferred edges, refreshes graph when done
      startEmbeddingQueue(); // background — computes embeddings for semantic search
    }, 2000);
  });

  // ── Skip / close ──
  document.getElementById('import-skip').addEventListener('click', async () => {
    hide('import-overlay');
    resetImportState();
    if (!data.people.length) await startApp();
  });

  document.getElementById('import-backdrop').addEventListener('click', () => {
    // Only allow closing via backdrop if app is already loaded (not onboarding)
    if (!document.body.classList.contains('loading')) {
      hide('import-overlay');
      resetImportState();
    }
  });

  // ── Import button in topbar (for returning users) ──
  document.getElementById('import-btn').addEventListener('click', () => {
    resetImportState();
    // Go straight to upload step (skip guide for returning users)
    document.getElementById('import-step-1').classList.add('hidden');
    document.getElementById('import-step-2').classList.remove('hidden');
    show('import-overlay');
  });
}

let importDupes = new Set();

function resetImportState() {
  importRows = [];
  importDupes = new Set();
  document.getElementById('import-step-1').classList.remove('hidden');
  document.getElementById('import-step-2').classList.add('hidden');
  document.getElementById('import-preview').classList.add('hidden');
  document.getElementById('import-drop').classList.remove('hidden');
  document.getElementById('import-submit').classList.add('hidden');
  document.getElementById('import-file').value = '';
}

function showToast(msg) {
  const toast = document.getElementById('import-toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

async function startApp() {
  document.body.classList.remove('loading');
  await loadData();

  // Show empty state if no contacts
  if (data.people.length === 0) {
    show('empty-state');
    document.getElementById('graph').style.display = 'none';
  } else {
    hide('empty-state');
    document.getElementById('graph').style.display = '';
    buildGraph();
    startEmbeddingQueue(); // background — semantic embeddings
  }
}

// ═══════════════════════════════════════════════════════════════
// EMPTY STATE + EXPORT GUIDES
// ═══════════════════════════════════════════════════════════════

const EXPORT_GUIDES = {
  linkedin: {
    title: 'Export from LinkedIn',
    body: `<ol>
      <li>Go to <strong>LinkedIn.com</strong> → click your profile icon → <strong>Settings & Privacy</strong></li>
      <li>Select <strong>Data privacy</strong> from the left menu</li>
      <li>Click <strong>Get a copy of your data</strong></li>
      <li>Select <strong>Connections</strong> only</li>
      <li>Click <strong>Request archive</strong></li>
      <li>LinkedIn emails you the file within 10 minutes to 24 hours</li>
      <li>Download the ZIP and <strong>upload it directly</strong> — no need to extract anything</li>
    </ol>`,
  },
  iphone: {
    title: 'Export from iPhone / iCloud',
    body: `<ol>
      <li>Go to <strong>icloud.com/contacts</strong> in a browser</li>
      <li>Sign in with your Apple ID</li>
      <li>Press <strong>Ctrl+A</strong> (or Cmd+A) to select all contacts</li>
      <li>Click the <strong>gear icon</strong> (bottom left) → <strong>Export vCard</strong></li>
      <li>A <strong>.vcf</strong> file downloads — upload it here</li>
    </ol>
    <p style="margin-top:12px;color:var(--txt-ghost);font-size:11px">Alternatively on iPhone: Settings → Contacts → Accounts → iCloud → export via the method above.</p>`,
  },
  google: {
    title: 'Export from Google Contacts',
    body: `<ol>
      <li>Go to <strong>contacts.google.com</strong></li>
      <li>Click <strong>Export</strong> in the left sidebar (or the three-dot menu)</li>
      <li>Select <strong>All contacts</strong> (or a specific label)</li>
      <li>Choose <strong>Google CSV</strong> format</li>
      <li>Click <strong>Export</strong> — a CSV file downloads</li>
      <li>Upload it here</li>
    </ol>
    <p style="margin-top:12px;color:var(--txt-ghost);font-size:11px">You can also export as vCard — Kenoki handles both formats.</p>`,
  },
  outlook: {
    title: 'Export from Outlook',
    body: `<ol>
      <li>Open <strong>Outlook</strong> (desktop or outlook.com)</li>
      <li>Go to <strong>People</strong> (contacts section)</li>
      <li>Click <strong>Manage</strong> → <strong>Export contacts</strong></li>
      <li>Select <strong>All contacts</strong> or a specific folder</li>
      <li>Click <strong>Export</strong> — a CSV file downloads</li>
      <li>Upload it here</li>
    </ol>`,
  },
  facebook: {
    title: 'Export from Facebook',
    body: `<ol>
      <li>Go to <strong>facebook.com/settings</strong></li>
      <li>Click <strong>Your Facebook Information</strong> in the left menu</li>
      <li>Click <strong>Download Your Information</strong></li>
      <li>Set format to <strong>JSON</strong></li>
      <li>Deselect everything except <strong>Friends and followers</strong></li>
      <li>Click <strong>Create file</strong> — Facebook prepares it (can take hours)</li>
      <li>Download the ZIP when ready and <strong>upload it directly</strong> — we find the right file inside</li>
    </ol>
    <p style="margin-top:12px;color:var(--txt-ghost);font-size:11px">Note: Facebook only exports friend names — no email, phone, or company data. You can add details manually later.</p>`,
  },
  csv: {
    title: 'Import any CSV or spreadsheet',
    body: `<p>Kenoki accepts any CSV file with contact data. It automatically detects columns by header name.</p>
    <p style="margin-top:12px"><strong>Supported column names</strong> (case-insensitive):</p>
    <ul style="margin-top:8px;padding-left:20px;line-height:2">
      <li><strong>Name</strong> — or "Full Name", "Contact Name", "First Name" + "Last Name"</li>
      <li><strong>Email</strong> — or "E-mail", "Email Address"</li>
      <li><strong>Phone</strong> — or "Mobile", "Telephone", "Phone Number"</li>
      <li><strong>Company</strong> — or "Organization", "Org"</li>
      <li><strong>Title</strong> — or "Job Title", "Position", "Role"</li>
      <li><strong>Notes</strong> — or "Comments", "Remarks"</li>
      <li><strong>Tags</strong> — or "Categories", "Groups", "Labels"</li>
    </ul>
    <p style="margin-top:12px;color:var(--txt-ghost);font-size:11px">Minimum requirement: at least a "Name" or "First Name" column. Everything else is optional.</p>`,
  },
};

function setupEmptyState() {
  document.getElementById('empty-import')?.addEventListener('click', () => {
    hide('empty-state');
    show('import-overlay');
  });

  document.querySelectorAll('.empty-guide-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const guide = EXPORT_GUIDES[btn.dataset.guide];
      if (!guide) return;
      document.getElementById('guide-title').textContent = guide.title;
      document.getElementById('guide-body').innerHTML = guide.body;
      show('guide-overlay');
    });
  });

  document.getElementById('guide-close')?.addEventListener('click', () => hide('guide-overlay'));
  document.getElementById('guide-backdrop')?.addEventListener('click', () => hide('guide-overlay'));
}

// ── Colour constants for vis-network (can't use CSS vars in canvas) ──
const C = {
  mark: '#E76F51', teal: '#C05A3C', markHover: 'rgba(231,111,81,0.22)',
  markSecondary: '#F4A261', markAccent: '#E9C46A',
  green: '#2A9D8F', amber: '#F4A261', red: '#C0503A',
  border: 'rgba(255,255,255,0.11)', txt2: 'rgba(255,255,255,0.55)',
  txtGhost: 'rgba(255,255,255,0.40)', base: '#0c0b0a',
  surface: '#181614', surfaceEl: '#1e1b18',
};

// ── Recency classification ──
function recencyClass(lastContact) {
  if (!lastContact) return 'never';
  const days = (Date.now() - new Date(lastContact).getTime()) / 86400000;
  if (days < 90)  return 'active';
  if (days < 365) return 'warm';
  return 'stale';
}

const RECENCY_BORDER = {
  active: '#2A9D8F',                  // green ring — talked recently
  warm:   '#E9C46A',                  // amber ring — been a while
  stale:  'rgba(255,255,255,0.12)',   // faint — going cold
  never:  'rgba(255,255,255,0.06)',   // ghost — never contacted
};
const RECENCY_SIZE = { active: 14, warm: 12, stale: 10, never: 10 };
const RECENCY_BORDER_WIDTH = { active: 2, warm: 1.5, stale: 0, never: 0 };

// Dynamic colour palette — assigns colours from a fixed pool based on whatever tags/types the user has
const PALETTE = [C.mark, C.markSecondary, C.green, C.markAccent, C.teal, C.red];
const _tagColorCache = new Map();
const _coColorCache = new Map();

function tagColor(tag) {
  if (!_tagColorCache.has(tag)) {
    _tagColorCache.set(tag, PALETTE[_tagColorCache.size % PALETTE.length]);
  }
  return _tagColorCache.get(tag);
}

function companyTypeColor(type) {
  if (!type) return C.txtGhost;
  if (!_coColorCache.has(type)) {
    _coColorCache.set(type, PALETTE[_coColorCache.size % PALETTE.length]);
  }
  return _coColorCache.get(type);
}

// ── State ──
let data = { people: [], companies: [], relationships: [], tags: [], events: [], inferredEdges: [] };
let tagsByPerson = new Map();
let network = null;
let chatContext = null;
let ctxNodeData = null;   // person data for current right-click
let ctxNodeTags = [];     // tags for current right-click
let panelPerson = null;   // person currently shown in side panel

// ═══════════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════════

async function loadData() {
  const uid = currentUser?.id;
  // Supabase defaults to 1000 rows max — override with .range()
  // Exclude embedding column from people (384 floats × 2k rows = 3MB we never need in memory)
  const [p, c, r, t, e, ie] = await Promise.all([
    sb.from('people').select('id,user_id,full_name,role,phone,linkedin_url,notes,last_contact,company_id,industry,what_they_do,what_they_offer,what_they_want,next_action,created_at').eq('user_id', uid).range(0, 9999),
    sb.from('companies').select('*').eq('user_id', uid).range(0, 9999),
    sb.from('relationships').select('*').eq('user_id', uid).range(0, 9999),
    sb.from('tags').select('*').eq('user_id', uid).range(0, 9999),
    sb.from('events').select('*').eq('user_id', uid).range(0, 9999),
    sb.from('inferred_edges').select('person_a_id,person_b_id,edge_type,strength').eq('user_id', uid).range(0, 29999),
  ]);
  data = {
    people: p.data || [], companies: c.data || [],
    relationships: r.data || [], tags: t.data || [], events: e.data || [],
    inferredEdges: ie.data || [],
  };

  tagsByPerson = new Map();
  data.tags.forEach(t => {
    const arr = tagsByPerson.get(t.person_id) || [];
    arr.push(t.tag);
    tagsByPerson.set(t.person_id, arr);
  });

  // Stats
  document.getElementById('stat-people').textContent = `${data.people.length} people`;
  document.getElementById('stat-companies').textContent = `${data.companies.length} companies`;
  const totalLinks = data.relationships.length + data.inferredEdges.length;
  const statEl = document.getElementById('stat-relationships');
  statEl.textContent = `${totalLinks} links`;
  statEl.title = `${data.relationships.length} explicit · ${data.inferredEdges.length} inferred`;

  // Populate tag filter — exclude import-source metadata tags
  const sel = document.getElementById('tag-filter');
  const tags = [...new Set(data.tags.map(t => t.tag).filter(t => !IMPORT_SOURCE_TAGS.has(t)))].sort();
  sel.innerHTML = `<option value="all">All (${data.people.length})</option>` +
    tags.map(t => `<option value="${t}">${t}</option>`).join('');

  chatContext = null;
}

async function inferEdges() {
  if (!currentUser) return;
  try {
    const { data: result, error } = await sb.rpc('run_inference', { p_user_id: currentUser.id });
    if (error) { console.warn('Inference error:', error.message); return; }
    const total = result?.total ?? 0;
    if (total > 0) {
      const parts = [];
      if (result.co_worker)        parts.push(`${result.co_worker} co-worker`);
      if (result.same_role)        parts.push(`${result.same_role} role`);
      if (result.same_industry)    parts.push(`${result.same_industry} industry`);
      if (result.semantic_similar) parts.push(`${result.semantic_similar} semantic`);
      showToast(`Network updated — ${total.toLocaleString()} connections (${parts.join(' · ')})`);
      // Reload inferred edges and refresh graph
      const { data: ie } = await sb.from('inferred_edges')
        .select('person_a_id,person_b_id,edge_type,strength')
        .eq('user_id', currentUser.id).range(0, 29999);
      data.inferredEdges = ie || [];
      const totalLinks = data.relationships.length + data.inferredEdges.length;
      const statEl = document.getElementById('stat-relationships');
      statEl.textContent = `${totalLinks} links`;
      statEl.title = `${data.relationships.length} explicit · ${data.inferredEdges.length} inferred`;
      buildGraph();
    }
  } catch (e) {
    console.warn('Inference failed:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// GRAPH
// ═══════════════════════════════════════════════════════════════

function nodeColor(tags) {
  for (const t of tags) { return tagColor(t); }
  return C.txtGhost;
}

// ── Garbage company blocklist ──
const GARBAGE_COMPANIES = new Set([
  'private yacht', 'self-employed', 'superyacht', 'private', 'freelance',
  'private company', 'motor yacht', 'yacht', 'super yachts', 'self employed',
  'n/a', 'none', '-', 'na', 'private motor yacht', 'sailing yacht',
  'private vessel', 'freelancer', 'independent',
]);

function isRealCompany(name) {
  return name && !GARBAGE_COMPANIES.has(name.toLowerCase().trim());
}

// ── Lightweight Louvain community detection ──
function detectCommunities(peopleList, relationships) {
  // Build adjacency from relationships
  const adj = new Map();
  const pSet = new Set(peopleList.map(p => p.id));

  function addEdge(a, b) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }

  // Relationship edges
  relationships.forEach(r => {
    if (pSet.has(r.person_a_id) && pSet.has(r.person_b_id)) {
      addEdge(r.person_a_id, r.person_b_id);
    }
  });

  // Company edges (real companies only) — people at same company are connected
  const coMap = new Map(data.companies.map(c => [c.id, c]));
  const companyPeople = new Map();
  peopleList.forEach(p => {
    if (!p.company_id) return;
    const co = coMap.get(p.company_id);
    if (!co || !isRealCompany(co.name)) return;
    if (!companyPeople.has(p.company_id)) companyPeople.set(p.company_id, []);
    companyPeople.get(p.company_id).push(p.id);
  });
  companyPeople.forEach(members => {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j]);
      }
    }
  });

  // Simple label propagation (faster than full Louvain, good enough for <10k nodes)
  const community = new Map();
  let nextCom = 0;
  peopleList.forEach(p => community.set(p.id, nextCom++));

  // Iterate: each node adopts the most common community among its neighbours
  for (let iter = 0; iter < 15; iter++) {
    let changed = false;
    peopleList.forEach(p => {
      const neighbours = adj.get(p.id);
      if (!neighbours || neighbours.length === 0) return;

      // Count neighbour communities
      const counts = new Map();
      neighbours.forEach(n => {
        const c = community.get(n);
        counts.set(c, (counts.get(c) || 0) + 1);
      });

      // Find most common
      let bestCom = community.get(p.id);
      let bestCount = 0;
      counts.forEach((count, com) => {
        if (count > bestCount) { bestCount = count; bestCom = com; }
      });

      if (bestCom !== community.get(p.id)) {
        community.set(p.id, bestCom);
        changed = true;
      }
    });
    if (!changed) break;
  }

  // Renumber communities to 0, 1, 2, ...
  const comIds = [...new Set(community.values())];
  const remap = new Map();
  comIds.forEach((c, i) => remap.set(c, i));
  community.forEach((c, id) => community.set(id, remap.get(c)));

  return community;
}

const CLUSTER_COLORS = [
  '#E76F51', '#2A9D8F', '#F4A261', '#E9C46A', '#264653',
  '#8B5CF6', '#52B788', '#F97316', '#06B6D4', '#EC4899',
  '#84CC16', '#A855F7', '#14B8A6', '#F43F5E', '#6366F1',
  '#D97706', '#059669', '#7C3AED', '#0EA5E9', '#EF4444',
];

function buildGraph() {
  const filter = document.getElementById('tag-filter').value;
  const search = document.getElementById('search').value.toLowerCase();

  let people = data.people;
  if (filter !== 'all') {
    people = people.filter(p => (tagsByPerson.get(p.id) || []).includes(filter));
  }
  if (search) {
    people = people.filter(p =>
      p.full_name.toLowerCase().includes(search) ||
      (p.role && p.role.toLowerCase().includes(search)) ||
      (p.notes && p.notes.toLowerCase().includes(search))
    );
  }

  const pIds = new Set(people.map(p => p.id));
  const coMap = new Map(data.companies.map(c => [c.id, c]));

  // ── Connection count per person — drives node size ──
  const connCount = new Map();
  [...data.relationships, ...data.inferredEdges].forEach(r => {
    if (pIds.has(r.person_a_id)) connCount.set(r.person_a_id, (connCount.get(r.person_a_id) || 0) + 1);
    if (pIds.has(r.person_b_id)) connCount.set(r.person_b_id, (connCount.get(r.person_b_id) || 0) + 1);
  });

  // ── Run community detection on explicit + inferred edges ──
  const allEdges = [...data.relationships, ...data.inferredEdges];
  const communities = detectCommunities(people, allEdges);

  // Count community sizes, assign colours to top communities
  const comSizes = new Map();
  communities.forEach(c => comSizes.set(c, (comSizes.get(c) || 0) + 1));
  const sortedComs = [...comSizes.entries()].sort((a, b) => b[1] - a[1]);
  const comColor = new Map();
  sortedComs.forEach(([com, size], i) => {
    if (size >= 2 && i < CLUSTER_COLORS.length) {
      comColor.set(com, CLUSTER_COLORS[i]);
    }
  });

  function getColor(personId) {
    const com = communities.get(personId);
    return comColor.get(com) || 'rgba(255,255,255,0.15)';
  }

  const nodes = [];
  const edges = [];

  // People nodes — size scales with connection count, labels only for hubs
  people.forEach(p => {
    const pt = tagsByPerson.get(p.id) || [];
    const color = getColor(p.id);
    const co = p.company_id ? coMap.get(p.company_id) : null;
    const coName = co && isRealCompany(co.name) ? co.name : '';
    const recency = recencyClass(p.last_contact);
    const conns = connCount.get(p.id) || 0;

    // Hub nodes are larger — size scales with sqrt(connections) to avoid giant outliers
    const baseSize = RECENCY_SIZE[recency];
    const size = Math.min(baseSize + Math.sqrt(conns) * 2.2, 32);

    // Labels only for well-connected nodes or recently active ones
    // This dramatically reduces visual clutter for 2000+ node graphs
    const showLabel = conns >= 4 || recency === 'active';
    const labelColor = (recency === 'stale' || recency === 'never')
      ? 'rgba(255,255,255,0.30)'
      : 'rgba(255,255,255,0.80)';
    const labelSize = conns >= 12 ? 11 : 10;

    nodes.push({
      id: 'p_' + p.id,
      label: showLabel ? p.full_name : '',
      title: '', // suppress vis-network default tooltip — we handle hover ourselves
      shape: 'dot',
      size,
      color: {
        background: color,
        border: RECENCY_BORDER[recency],
        highlight: { background: '#ffffff', border: '#ffffff' },
        hover: { background: C.mark, border: C.mark },
      },
      font: { color: labelColor, size: labelSize, face: 'Inter, system-ui, sans-serif' },
      borderWidth: RECENCY_BORDER_WIDTH[recency],
      _type: 'person', _data: p, _tags: pt,
    });
  });

  // Explicit relationship edges
  data.relationships.forEach(r => {
    if (!pIds.has(r.person_a_id) || !pIds.has(r.person_b_id)) return;
    const color = getColor(r.person_a_id);
    edges.push({
      from: 'p_' + r.person_a_id, to: 'p_' + r.person_b_id,
      color: { color, opacity: 0.25 },
      width: 1.2,
      smooth: { type: 'continuous' },
    });
  });

  // Inferred edges — multi-dimensional rendering
  // Strategy: deduplicate pairs, accumulate combined weight across all edge types.
  // Co-worker renders as primary edge. Same-role + semantic-similar boost its width.
  // Rendering only co-worker + multi-dim boosted pairs — same-role-only (24k) would freeze.
  const pairEdgeMap = new Map(); // key: "a_id|b_id" → { types: Set, maxStrength, color }
  data.inferredEdges.forEach(ie => {
    if (!pIds.has(ie.person_a_id) || !pIds.has(ie.person_b_id)) return;
    const key = ie.person_a_id + '|' + ie.person_b_id;
    if (!pairEdgeMap.has(key)) {
      pairEdgeMap.set(key, { types: new Set(), maxStrength: 0, a: ie.person_a_id, b: ie.person_b_id });
    }
    const entry = pairEdgeMap.get(key);
    entry.types.add(ie.edge_type);
    entry.maxStrength = Math.max(entry.maxStrength, Number(ie.strength));
  });

  pairEdgeMap.forEach(entry => {
    // Only render if pair has co-worker OR semantic-similar edge
    // Same-role-only pairs (24k) are used for community detection but not drawn
    const hasCoWorker   = entry.types.has('co-worker');
    const hasSemantic   = entry.types.has('semantic-similar');
    const hasSameRole   = entry.types.has('same-role');
    if (!hasCoWorker && !hasSemantic) return;

    const dimensionCount = entry.types.size; // 1 = single link, 2+ = spider web
    const color = getColor(entry.a);

    // Width scales with number of dimensions connecting this pair
    // co-worker alone: 0.6. co-worker + same-role: 1.0. all three: 1.6
    const width = 0.4 + (dimensionCount * 0.4);
    // Opacity increases with dimension count — multi-dim pairs are more prominent
    const opacity = 0.10 + (dimensionCount * 0.07);

    // Semantic-only pairs get a teal tint to distinguish from structure-based
    const edgeColor = hasSemantic && !hasCoWorker ? '#2A9D8F' : color;

    edges.push({
      from: 'p_' + entry.a, to: 'p_' + entry.b,
      color: { color: edgeColor, opacity: Math.min(opacity, 0.45) },
      width,
      title: [...entry.types].join(' + '), // tooltip shows all dimensions
      smooth: { type: 'continuous' },
    });
  });

  // NOTE: Company edges removed — co-worker inferred edges already cluster companies.
  // Adding company edges on top created duplicate connections and visual noise.

  const container = document.getElementById('graph');
  if (network) network.destroy();

  network = new vis.Network(container, { nodes, edges }, {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -80,      // was -30: much stronger repulsion separates clusters
        centralGravity: 0.003,           // mild pull to center — prevents explosion
        springLength: 180,               // was 150: more breathing room between nodes
        springConstant: 0.05,
        damping: 0.65,
        avoidOverlap: 0.8,               // prevent node overlap — critical for readability
      },
      stabilization: {
        iterations: 1000,
        fit: true,
        updateInterval: 50,
      },
      minVelocity: 0.5,
    },
    interaction: {
      hover: true,
      tooltipDelay: 9999,    // effectively disabled — we handle tooltips manually
      zoomView: true,
      dragView: true,
      dragNodes: true,       // drag individual nodes to reposition
      multiselect: false,
      hoverConnectedEdges: true,
    },
    nodes: {
      font: { face: 'Inter, system-ui, sans-serif' },
      chosen: {
        node: (values) => {
          values.shadowSize = 8;
          values.shadowColor = 'rgba(255,255,255,0.12)';
        },
      },
    },
    edges: {
      smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
      chosen: false,
      hoverWidth: 0,
    },
  });

  // Build node lookup map for O(1) access in event handlers
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // ── Hover tooltip ──
  const tooltip = document.getElementById('tooltip');
  network.on('hoverNode', e => {
    const n = nodeMap.get(e.node);
    if (!n) return;
    const pos = network.canvasToDOM(network.getPosition(e.node));
    const panelOpen = !document.getElementById('person-panel').classList.contains('hidden');
    const rightEdge = panelOpen ? window.innerWidth - 330 : window.innerWidth - 20;
    tooltip.style.left = Math.min(pos.x + 16, rightEdge - 320) + 'px';
    tooltip.style.top = Math.max(pos.y - 10, 10) + 'px';
    tooltip.innerHTML = n._type === 'person' ? personHTML(n._data, n._tags) : '';
    tooltip.classList.remove('hidden');
  });
  network.on('blurNode', () => tooltip.classList.add('hidden'));
  network.on('dragStart', () => { tooltip.classList.add('hidden'); hideCtxMenu(); });

  // ── Click: open person panel ──
  network.on('selectNode', params => {
    const n = nodeMap.get(params.nodes[0]);
    if (!n || n._type !== 'person') return;
    tooltip.classList.add('hidden');
    showPersonPanel(n._data, n._tags);
  });
  network.on('click', params => {
    if (!params.nodes.length) hideCtxMenu();
  });

  // ── Right-click: context menu ──
  network.on('oncontext', params => {
    params.event.preventDefault();
    hideCtxMenu();
    const nodeId = network.getNodeAt(params.pointer.DOM);
    if (!nodeId) return;
    const n = nodeMap.get(nodeId);
    if (!n || n._type !== 'person') return;
    ctxNodeData = n._data;
    ctxNodeTags = n._tags;
    const rect = container.getBoundingClientRect();
    let x = params.pointer.DOM.x + rect.left;
    let y = params.pointer.DOM.y + rect.top;
    if (x + 170 > window.innerWidth) x -= 170;
    if (y + 120 > window.innerHeight) y -= 120;
    const menu = document.getElementById('ctx-menu');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.remove('hidden');
  });

  // After stabilization: fit with padding so nodes don't hug edges
  network.once('stabilizationIterationsDone', () => {
    network.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
  });

  // Build legend from actual data
  buildLegend();
}

function buildLegend() {
  const legendEl = document.getElementById('legend');

  // ── Recency buckets ──
  const buckets = { active: 0, warm: 0, stale: 0, never: 0 };
  data.people.forEach(p => buckets[recencyClass(p.last_contact)]++);

  const recencyRows = [
    { key: 'active', label: 'Active',  sublabel: '< 3 months',  color: RECENCY_BORDER.active },
    { key: 'warm',   label: 'Warm',    sublabel: '3–12 months', color: RECENCY_BORDER.warm },
    { key: 'stale',  label: 'Stale',   sublabel: '> 1 year',    color: 'rgba(255,255,255,0.35)' },
    { key: 'never',  label: 'No contact', sublabel: 'never logged', color: 'rgba(255,255,255,0.18)' },
  ].filter(r => buckets[r.key] > 0);

  // ── Top user-defined tags (strip import-source metadata) ──
  const tagCounts = new Map();
  data.tags.forEach(t => {
    if (IMPORT_SOURCE_TAGS.has(t.tag)) return;
    tagCounts.set(t.tag, (tagCounts.get(t.tag) || 0) + 1);
  });
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  if (!recencyRows.length && !topTags.length) {
    legendEl.innerHTML = '';
    return;
  }

  let html = '<div class="legend-title">Last contact</div><div class="legend-grid">';
  recencyRows.forEach(r => {
    html += `<div class="legend-item">
      <span class="legend-dot" style="background:${r.color};border:1.5px solid ${r.color}"></span>
      <span>${r.label} <span class="legend-count">${buckets[r.key]}</span></span>
    </div>`;
  });
  html += '</div>';

  if (topTags.length) {
    html += '<div class="legend-title" style="margin-top:10px">Tags</div><div class="legend-grid">';
    topTags.forEach(([tag]) => {
      html += `<div class="legend-item"><span class="legend-dot" style="background:${tagColor(tag)}"></span>${tag}</div>`;
    });
    html += '</div>';
  }

  legendEl.innerHTML = html;
}

function personHTML(p, tags) {
  const coMap = new Map(data.companies.map(c => [c.id, c]));
  let html = `<div class="tt-name">${p.full_name}</div>`;
  if (p.role) html += `<div class="tt-role">${p.role}</div>`;
  if (p.industry) html += `<div class="tt-industry">${p.industry}</div>`;

  if (tags.length) {
    html += '<div class="tt-tags">' + tags.map(t => `<span class="tt-tag">${t}</span>`).join('') + '</div>';
  }

  // KV fields
  const kvs = [
    ['does', p.what_they_do], ['offers', p.what_they_offer],
    ['wants', p.what_they_want ? p.what_they_want.slice(0, 120) : null],
    ['last contact', p.last_contact], ['next', p.next_action],
  ].filter(([, v]) => v);
  if (kvs.length) {
    html += kvs.map(([k, v]) => `<div class="tt-kv"><span class="tt-kv-label">${k}</span> ${v}</div>`).join('');
  }

  // Connections
  const conns = [];
  if (p.company_id) {
    const co = coMap.get(p.company_id);
    if (co) conns.push({ name: co.name, type: 'works at' });
  }
  data.relationships.forEach(r => {
    if (r.person_a_id === p.id || r.person_b_id === p.id) {
      const oid = r.person_a_id === p.id ? r.person_b_id : r.person_a_id;
      const o = data.people.find(pp => pp.id === oid);
      if (o) conns.push({ name: o.full_name, type: r.relationship_type || 'connected' });
    }
  });
  if (conns.length) {
    html += '<div class="tt-section"><div class="tt-section-title">Connections</div>';
    html += conns.slice(0, 5).map(c =>
      `<div class="tt-connection"><span class="tt-conn-name">${c.name}</span> — ${c.type}</div>`
    ).join('');
    if (conns.length > 5) html += `<div class="tt-connection" style="color:var(--txt-ghost)">+${conns.length - 5} more</div>`;
    html += '</div>';
  }

  if (p.notes) html += `<div class="tt-notes">${p.notes.slice(0, 150)}</div>`;
  return html;
}

function companyHTML(c) {
  let html = `<div class="tt-name company">${c.name}</div>`;
  if (c.type) html += `<div class="tt-type">${c.type}</div>`;
  if (c.industry) html += `<div class="tt-industry">${c.industry}</div>`;
  if (c.location) html += `<div class="tt-kv"><span class="tt-kv-label">location</span> ${c.location}</div>`;
  if (c.website) html += `<div class="tt-kv"><span class="tt-kv-label">web</span> ${c.website}</div>`;

  const members = data.people.filter(p => p.company_id === c.id);
  if (members.length) {
    html += '<div class="tt-section"><div class="tt-section-title">People (' + members.length + ')</div>';
    html += members.slice(0, 6).map(m =>
      `<div class="tt-connection"><span class="tt-conn-name">${m.full_name}</span>${m.role ? ' — ' + m.role : ''}</div>`
    ).join('');
    if (members.length > 6) html += `<div class="tt-connection" style="color:var(--txt-ghost)">+${members.length - 6} more</div>`;
    html += '</div>';
  }
  return html;
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════════════

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

function setupContextMenu() {
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

  document.getElementById('ctx-open').addEventListener('click', () => {
    if (ctxNodeData) showPersonPanel(ctxNodeData, ctxNodeTags);
  });
  document.getElementById('ctx-edit').addEventListener('click', () => {
    if (ctxNodeData) { showPersonPanel(ctxNodeData, ctxNodeTags); openPersonEdit(); }
  });
  document.getElementById('ctx-delete').addEventListener('click', () => {
    if (ctxNodeData) deletePersonConfirm(ctxNodeData);
  });
}

// ═══════════════════════════════════════════════════════════════
// PERSON PANEL — slide-in detail + edit
// ═══════════════════════════════════════════════════════════════

function showPersonPanel(person, tags) {
  panelPerson = person;
  const coMap = new Map(data.companies.map(c => [c.id, c]));
  const co = person.company_id ? coMap.get(person.company_id) : null;
  const coName = co && isRealCompany(co.name) ? co.name : '';
  const recency = recencyClass(person.last_contact);
  const recencyColors = { active: '#2A9D8F', warm: '#E9C46A', stale: 'rgba(255,255,255,0.25)', never: 'rgba(255,255,255,0.15)' };
  const recencyLabels = { active: 'Active (< 3 months)', warm: 'Warm (3–12 months)', stale: 'Stale (> 1 year)', never: 'No contact logged' };

  document.getElementById('pp-name').textContent = person.full_name;
  document.getElementById('pp-meta').textContent = [person.role, coName].filter(Boolean).join(' · ');

  const filteredTags = (tags || []).filter(t => !IMPORT_SOURCE_TAGS.has(t));

  let body = '';

  // Recency status
  body += `<div class="pp-recency">
    <span class="pp-recency-dot" style="background:${recencyColors[recency]}"></span>
    ${recencyLabels[recency]}
  </div>`;

  // Tags
  if (filteredTags.length) {
    body += '<div class="pp-tags">' + filteredTags.map(t =>
      `<span class="pp-tag" style="border-color:${tagColor(t)}">${t}</span>`
    ).join('') + '</div>';
  }

  // Key fields
  const fields = [
    ['Role', person.role],
    ['Company', coName],
    ['Industry', person.industry],
    ['Phone', person.phone],
    ['LinkedIn', person.linkedin_url ? `<a href="${person.linkedin_url}" target="_blank" rel="noopener">${person.linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '')}</a>` : null],
    ['What they do', person.what_they_do],
    ['What they offer', person.what_they_offer],
    ['What they want', person.what_they_want],
    ['Last contact', person.last_contact],
    ['Next action', person.next_action],
    ['Notes', person.notes],
  ].filter(([, v]) => v);

  fields.forEach(([label, value]) => {
    body += `<div class="pp-kv"><div class="pp-kv-label">${label}</div><div class="pp-kv-value">${value}</div></div>`;
  });

  // Explicit connections
  const conns = [];
  data.relationships.forEach(r => {
    if (r.person_a_id === person.id || r.person_b_id === person.id) {
      const otherId = r.person_a_id === person.id ? r.person_b_id : r.person_a_id;
      const other = data.people.find(pp => pp.id === otherId);
      if (other) conns.push({ name: other.full_name, type: r.relationship_type || 'connected' });
    }
  });

  if (conns.length) {
    body += `<div class="pp-section-title">Connections (${conns.length})</div>`;
    conns.slice(0, 8).forEach(c => {
      body += `<div class="pp-conn"><span class="pp-conn-name">${c.name}</span><span style="color:var(--txt-ghost)">— ${c.type}</span></div>`;
    });
    if (conns.length > 8) body += `<div class="pp-conn" style="color:var(--txt-ghost)">+${conns.length - 8} more</div>`;
  }

  document.getElementById('pp-body').innerHTML = body;
  document.getElementById('person-panel').classList.remove('hidden');
  // Switch footer to view mode
  document.getElementById('pp-edit-btn').textContent = 'Edit';
  document.getElementById('pp-edit-btn').onclick = openPersonEdit;
}

function hidePersonPanel() {
  document.getElementById('person-panel').classList.add('hidden');
  panelPerson = null;
}

function openPersonEdit() {
  if (!panelPerson) return;
  const coMap = new Map(data.companies.map(c => [c.id, c]));
  const co = panelPerson.company_id ? coMap.get(panelPerson.company_id) : null;
  const coName = co && isRealCompany(co.name) ? co.name : '';

  const fields = [
    { key: 'full_name', label: 'Name', value: panelPerson.full_name, type: 'text' },
    { key: 'role', label: 'Role', value: panelPerson.role || '', type: 'text' },
    { key: '_company_name', label: 'Company', value: coName, type: 'text' },
    { key: 'industry', label: 'Industry', value: panelPerson.industry || '', type: 'text' },
    { key: 'phone', label: 'Phone', value: panelPerson.phone || '', type: 'text' },
    { key: 'linkedin_url', label: 'LinkedIn', value: panelPerson.linkedin_url || '', type: 'text' },
    { key: 'what_they_do', label: 'What they do', value: panelPerson.what_they_do || '', type: 'text' },
    { key: 'notes', label: 'Notes', value: panelPerson.notes || '', type: 'textarea' },
    { key: 'next_action', label: 'Next action', value: panelPerson.next_action || '', type: 'text' },
  ];

  let html = '<form id="pp-edit-form" style="display:flex;flex-direction:column;gap:0">';
  fields.forEach(f => {
    html += `<div class="pp-edit-field">
      <div class="pp-edit-label">${f.label}</div>
      ${f.type === 'textarea'
        ? `<textarea class="pp-edit-input" name="${f.key}" rows="3">${f.value}</textarea>`
        : `<input class="pp-edit-input" type="text" name="${f.key}" value="${f.value.replace(/"/g, '&quot;')}" />`}
    </div>`;
  });
  html += '</form>';

  // Add company datalist
  html += '<datalist id="pp-company-list">' +
    data.companies.map(c => `<option value="${c.name.replace(/"/g, '&quot;')}">`).join('') +
    '</datalist>';

  document.getElementById('pp-body').innerHTML = html;
  // Wire company datalist
  const companyInput = document.querySelector('[name="_company_name"]');
  if (companyInput) companyInput.setAttribute('list', 'pp-company-list');

  document.getElementById('pp-edit-btn').textContent = 'Save';
  document.getElementById('pp-edit-btn').onclick = savePersonEdit;
}

async function savePersonEdit() {
  if (!panelPerson) return;
  const form = document.getElementById('pp-edit-form');
  if (!form) return;

  const fd = new FormData(form);
  const updates = {};
  for (const [key, value] of fd.entries()) {
    if (key === '_company_name') continue;
    updates[key] = value.trim() || null;
  }

  // Handle company name → company_id
  const companyName = fd.get('_company_name')?.trim();
  if (companyName) {
    const existing = data.companies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (existing) {
      updates.company_id = existing.id;
    } else {
      const { data: newCo } = await sb.from('companies').insert({
        user_id: currentUser.id, name: companyName
      }).select().single();
      if (newCo) { data.companies.push(newCo); updates.company_id = newCo.id; }
    }
  } else {
    updates.company_id = null;
  }

  const btn = document.getElementById('pp-edit-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  const { error } = await sb.from('people').update(updates).eq('id', panelPerson.id);
  if (error) { showToast('Save failed: ' + error.message); btn.textContent = 'Save'; btn.disabled = false; return; }

  // Update local data
  const idx = data.people.findIndex(p => p.id === panelPerson.id);
  if (idx >= 0) Object.assign(data.people[idx], updates);
  panelPerson = data.people[idx] || panelPerson;

  showToast('Saved');

  // Re-embed with updated role/industry
  embedSinglePerson(panelPerson).then(() => inferEdges());

  // Refresh panel view and graph
  const tags = tagsByPerson.get(panelPerson.id) || [];
  showPersonPanel(panelPerson, tags);
  buildGraph();
}

async function deletePersonConfirm(person) {
  // Simple confirm — could be enhanced to a custom modal later
  if (!confirm(`Delete ${person.full_name}? This cannot be undone.`)) return;

  const { error } = await sb.from('people').delete().eq('id', person.id);
  if (error) { showToast('Delete failed'); return; }

  // Remove from local data
  data.people = data.people.filter(p => p.id !== person.id);
  data.relationships = data.relationships.filter(r => r.person_a_id !== person.id && r.person_b_id !== person.id);
  data.inferredEdges = data.inferredEdges.filter(e => e.person_a_id !== person.id && e.person_b_id !== person.id);
  tagsByPerson.delete(person.id);

  hidePersonPanel();
  showToast(`${person.full_name} deleted`);

  // Update stats
  document.getElementById('stat-people').textContent = `${data.people.length} people`;
  const totalLinks = data.relationships.length + data.inferredEdges.length;
  document.getElementById('stat-relationships').textContent = `${totalLinks} links`;

  buildGraph();
}

// ═══════════════════════════════════════════════════════════════
// ADD PERSON — schema form + immediate embedding
// ═══════════════════════════════════════════════════════════════

function openAddPersonForm() {
  // Clear form
  ['ap-name','ap-role','ap-company','ap-industry','ap-phone','ap-linkedin','ap-does','ap-notes','ap-next']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

  // Populate company autocomplete
  const dl = document.getElementById('ap-company-list');
  if (dl) {
    dl.innerHTML = data.companies
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${c.name.replace(/"/g, '&quot;')}">`)
      .join('');
  }

  document.getElementById('ap-status').textContent = '* Name is required';
  document.getElementById('ap-status').className = 'si-hint ap-hint';
  show('add-person-overlay');

  // Focus name field after animation
  setTimeout(() => document.getElementById('ap-name')?.focus(), 120);
}

async function savePersonFromForm() {
  const name = document.getElementById('ap-name')?.value.trim();
  if (!name) {
    document.getElementById('ap-status').textContent = 'Name is required';
    document.getElementById('ap-status').className = 'si-hint ap-hint ap-error';
    document.getElementById('ap-name')?.focus();
    return;
  }

  const statusEl = document.getElementById('ap-status');
  statusEl.textContent = 'Saving…';
  statusEl.className = 'si-hint ap-hint ap-saving';
  document.getElementById('add-person-save').disabled = true;

  // Resolve company
  let companyId = null;
  const companyName = document.getElementById('ap-company')?.value.trim();
  if (companyName) {
    const existing = data.companies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (existing) {
      companyId = existing.id;
    } else {
      const { data: newCo } = await sb.from('companies').insert({
        user_id: currentUser.id, name: companyName
      }).select().single();
      if (newCo) { data.companies.push(newCo); companyId = newCo.id; }
    }
  }

  const personPayload = {
    user_id: currentUser.id,
    full_name: name,
    role: document.getElementById('ap-role')?.value.trim() || null,
    company_id: companyId,
    industry: document.getElementById('ap-industry')?.value.trim() || null,
    phone: document.getElementById('ap-phone')?.value.trim() || null,
    linkedin_url: document.getElementById('ap-linkedin')?.value.trim() || null,
    what_they_do: document.getElementById('ap-does')?.value.trim() || null,
    notes: document.getElementById('ap-notes')?.value.trim() || null,
    next_action: document.getElementById('ap-next')?.value.trim() || null,
  };

  const { data: newPerson, error } = await sb.from('people').insert(personPayload).select().single();
  if (error || !newPerson) {
    statusEl.textContent = 'Error: ' + (error?.message || 'Unknown error');
    statusEl.className = 'si-hint ap-hint ap-error';
    document.getElementById('add-person-save').disabled = false;
    return;
  }

  // Add to local state immediately
  data.people.push(newPerson);
  tagsByPerson.set(newPerson.id, []);

  hide('add-person-overlay');
  document.getElementById('add-person-save').disabled = false;

  // Update stats
  document.getElementById('stat-people').textContent = `${data.people.length} people`;

  showToast(`${name} added — computing embedding…`);

  // Rebuild graph immediately (person appears without embedding)
  buildGraph();

  // Embed in background, then re-run inference
  embedSinglePerson(newPerson).then(() => {
    inferEdges();
    showToast(`${name} connected to network`);
  });
}

// ═══════════════════════════════════════════════════════════════
// SINGLE-PERSON EMBEDDING — immediate, not queued
// ═══════════════════════════════════════════════════════════════

async function embedSinglePerson(person) {
  if (!window.Worker) return;
  const text = [person.role, person.role, person.industry, person.what_they_do]
    .filter(Boolean).join(' ') || person.full_name || '';
  if (!text.trim()) return;

  return new Promise(resolve => {
    let worker;
    try { worker = new Worker('embed-worker.js'); } catch { resolve(); return; }
    worker.onmessage = async ({ data: msg }) => {
      worker.terminate();
      if (!msg.error && msg.embedding) {
        await sb.from('people').update({ embedding: msg.embedding }).eq('id', person.id);
        // Update local person object if present
        const idx = data.people.findIndex(p => p.id === person.id);
        // embedding not stored in memory (excluded from loadData select) — just saved to DB
      }
      resolve();
    };
    worker.onerror = () => { worker.terminate(); resolve(); };
    worker.postMessage({ id: person.id, text });
  });
}

// ═══════════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a relationship intelligence system. You have the user's full CRM database below.
Rules: Answer with facts from the data. No speculation. Reference names, roles, companies. Short, direct. Never say "I think". Present evidence.`;

function buildContext() {
  const lines = [`${data.people.length} people, ${data.companies.length} companies, ${data.relationships.length} relationships.`, ''];
  const coMap = new Map(data.companies.map(c => [c.id, c]));

  lines.push('PEOPLE:');
  data.people.forEach(p => {
    const parts = [p.full_name];
    if (p.role) parts.push('role: ' + p.role);
    const co = p.company_id ? coMap.get(p.company_id) : null;
    if (co) parts.push('company: ' + co.name);
    const pt = (tagsByPerson.get(p.id) || []).filter(t => !IMPORT_SOURCE_TAGS.has(t));
    if (pt.length) parts.push('tags: ' + pt.join(', '));
    if (p.what_they_want) parts.push('wants: ' + p.what_they_want.slice(0, 120));
    if (p.notes) parts.push('notes: ' + p.notes.slice(0, 120));
    lines.push('- ' + parts.join(' | '));
  });

  lines.push('', 'COMPANIES:');
  data.companies.forEach(c => {
    const parts = [c.name];
    if (c.type) parts.push(c.type);
    if (c.location) parts.push(c.location);
    lines.push('- ' + parts.join(' | '));
  });

  lines.push('', 'RELATIONSHIPS:');
  const pMap = new Map(data.people.map(p => [p.id, p]));
  data.relationships.forEach(r => {
    const a = pMap.get(r.person_a_id), b = pMap.get(r.person_b_id);
    if (a && b) lines.push(`- ${a.full_name} <-> ${b.full_name} | ${r.relationship_type || 'connected'}${r.notes ? ' | ' + r.notes : ''}`);
  });

  return lines.join('\n');
}

async function sendChat(question) {
  if (!chatContext) chatContext = buildContext();

  const msgs = document.getElementById('chat-messages');
  const empty = document.getElementById('chat-empty');
  if (empty) empty.remove();

  // User message
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-msg user';
  userDiv.textContent = question;
  msgs.appendChild(userDiv);

  // Assistant message
  const aDiv = document.createElement('div');
  aDiv.className = 'chat-msg assistant';
  aDiv.innerHTML = '<span class="chat-cursor"></span>';
  msgs.appendChild(aDiv);
  msgs.scrollTop = msgs.scrollHeight;

  // Collect conversation history
  const history = [];
  msgs.querySelectorAll('.chat-msg').forEach(el => {
    if (el === aDiv) return;
    history.push({ role: el.classList.contains('user') ? 'user' : 'assistant', content: el.textContent });
  });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + '\n\n--- DATABASE ---\n' + chatContext + '\n--- END ---' },
    ...history.slice(-10),
    { role: 'user', content: question },
  ];

  try {
    let text = '';
    await chatWithProvider(messages,
      token => { text += token; aDiv.textContent = text; msgs.scrollTop = msgs.scrollHeight; },
      () => { if (!text) aDiv.textContent = 'No response.'; }
    );
  } catch (e) {
    aDiv.textContent = 'Connection failed. Check AI provider settings.';
  }
}

// ═══════════════════════════════════════════════════════════════
// SMART INPUT
// ═══════════════════════════════════════════════════════════════

let siActions = [];
let siStates = [];

async function siProcess(text) {
  show('si-thinking'); hide('si-idle');

  const pList = data.people.map(p => `"${p.full_name}" (id:${p.id}${p.role ? ', ' + p.role : ''})`).join('\n');
  const cList = data.companies.map(c => `"${c.name}" (id:${c.id})`).join('\n');

  const prompt = `You are a CRM data router. Extract actions from the user's input.
EXISTING PEOPLE:\n${pList}\n\nEXISTING COMPANIES:\n${cList}\n\nToday: ${new Date().toISOString().split('T')[0]}

Return ONLY JSON: {"summary":"...","actions":[{"type":"new_person|update_person|new_relationship|add_tags|new_company","data":{...},"display":"human summary"}]}

Rules: Match existing people by name. Do not create duplicates. Use YYYY-MM-DD for dates.`;

  try {
    const content = await chatWithProviderSync([
      { role: 'system', content: prompt },
      { role: 'user', content: text },
    ]);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    const parsed = JSON.parse(match[0]);

    siActions = parsed.actions || [];
    siStates = siActions.map(() => true);

    document.getElementById('si-summary').textContent = parsed.summary || '';
    document.getElementById('si-actions').innerHTML = siActions.map((a, i) =>
      `<button class="si-action" data-i="${i}">
        <span class="si-action-icon">${actionIcon(a.type)}</span>
        <span class="si-action-label">${a.display}</span>
        <span class="si-action-status">OK</span>
      </button>`
    ).join('');

    hide('si-thinking'); show('si-review');

    // Toggle actions
    document.querySelectorAll('.si-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = +btn.dataset.i;
        siStates[i] = !siStates[i];
        btn.classList.toggle('rejected', !siStates[i]);
        btn.querySelector('.si-action-status').textContent = siStates[i] ? 'OK' : 'SKIP';
      });
    });
  } catch (e) {
    hide('si-thinking'); show('si-idle');
    console.error('Parse failed:', e);
  }
}

function actionIcon(type) {
  return { new_person: '+P', update_person: '~P', new_relationship: 'LN', add_tags: '#T', new_company: '+C', new_event: '+E' }[type] || '??';
}

async function siExecute() {
  hide('si-review'); show('si-thinking');
  const results = [];

  for (let i = 0; i < siActions.length; i++) {
    if (!siStates[i]) { results.push({ ok: false, skip: true, display: siActions[i].display }); continue; }
    const a = siActions[i];
    try {
      let ok = false;
      if (a.type === 'new_company') {
        // Check if company already exists
        const { data: existingCo } = await sb.from('companies')
          .select('id')
          .eq('user_id', currentUser.id)
          .ilike('name', a.data.name)
          .limit(1);
        if (existingCo?.length) {
          a.display += ' (already exists)';
          ok = true;
        } else {
          const { error } = await sb.from('companies').insert({ name: a.data.name, type: a.data.type, industry: a.data.industry, location: a.data.location, user_id: currentUser.id });
          ok = !error;
        }
      } else if (a.type === 'new_person') {
        let coId = null;
        if (a.data.company_name) {
          const { data: cos } = await sb.from('companies').select('id').ilike('name', `%${a.data.company_name}%`).limit(1);
          coId = cos?.[0]?.id || null;
        }
        // Check if person already exists
        const { data: existingPerson } = await sb.from('people')
          .select('id')
          .eq('user_id', currentUser.id)
          .ilike('full_name', a.data.full_name)
          .limit(1);

        if (existingPerson?.length) {
          // Person exists — update instead of creating duplicate
          a.display += ' (updated existing)';
          const { error: upErr } = await sb.from('people').update({
            role: a.data.role || undefined,
            industry: a.data.industry || undefined,
            what_they_do: a.data.what_they_do || undefined,
            what_they_offer: a.data.what_they_offer || undefined,
            what_they_want: a.data.what_they_want || undefined,
            last_contact: a.data.last_contact || undefined,
            next_action: a.data.next_action || undefined,
            company_id: coId || undefined,
          }).eq('id', existingPerson[0].id);
          ok = !upErr;
          if (ok && a.data.tags?.length) {
            // Insert tags, ignore duplicates (unique index handles it)
            for (const t of a.data.tags) {
              await sb.from('tags').insert({ person_id: existingPerson[0].id, tag: t.toLowerCase(), user_id: currentUser.id }).single();
            }
          }
        } else {
          const { data: person, error } = await sb.from('people').insert({
            full_name: a.data.full_name, role: a.data.role, industry: a.data.industry,
            what_they_do: a.data.what_they_do, what_they_offer: a.data.what_they_offer,
            what_they_want: a.data.what_they_want, notes: a.data.notes,
            last_contact: a.data.last_contact, next_action: a.data.next_action, company_id: coId,
            user_id: currentUser.id,
          }).select('id').single();
          ok = !error && person;
          if (ok && a.data.tags?.length) {
            await sb.from('tags').insert(a.data.tags.map(t => ({ person_id: person.id, tag: t.toLowerCase(), user_id: currentUser.id })));
          }
        }
      } else if (a.type === 'update_person') {
        const updates = {};
        if (a.data.updates?.last_contact) updates.last_contact = a.data.updates.last_contact;
        if (a.data.updates?.next_action) updates.next_action = a.data.updates.next_action;
        if (a.data.updates?.notes_append) {
          const { data: cur } = await sb.from('people').select('notes').eq('id', a.data.person_id).single();
          const today = new Date().toISOString().split('T')[0];
          updates.notes = `[${today}] ${a.data.updates.notes_append}` + (cur?.notes ? '\n' + cur.notes : '');
        }
        if (Object.keys(updates).length) {
          const { error } = await sb.from('people').update(updates).eq('id', a.data.person_id);
          ok = !error;
        }
      } else if (a.type === 'new_relationship') {
        let aId = a.data.person_a_id, bId = a.data.person_b_id;
        if (!aId && a.data.person_a_name) {
          const { data: m } = await sb.from('people').select('id').ilike('full_name', `%${a.data.person_a_name}%`).limit(1);
          aId = m?.[0]?.id;
        }
        if (!bId && a.data.person_b_name) {
          const { data: m } = await sb.from('people').select('id').ilike('full_name', `%${a.data.person_b_name}%`).limit(1);
          bId = m?.[0]?.id;
        }
        if (aId && bId) {
          const { error } = await sb.from('relationships').insert({ person_a_id: aId, person_b_id: bId, relationship_type: a.data.relationship_type, strength: 1, confirmed: false, user_id: currentUser.id });
          ok = !error;
        }
      } else if (a.type === 'add_tags') {
        if (a.data.person_id && a.data.tags?.length) {
          const { error } = await sb.from('tags').insert(a.data.tags.map(t => ({ person_id: a.data.person_id, tag: t.toLowerCase(), user_id: currentUser.id })));
          ok = !error;
        }
      }
      results.push({ ok, skip: false, display: a.display });
    } catch { results.push({ ok: false, skip: false, display: a.display }); }
  }

  document.getElementById('si-results').innerHTML = results.map(r =>
    `<div class="si-result ${r.skip ? 'skip' : r.ok ? 'ok' : 'fail'}">${r.skip ? '—' : r.ok ? '✓' : '✗'} ${r.display}</div>`
  ).join('');

  hide('si-thinking'); show('si-done');
  await loadData();
  buildGraph();
}

function siOpen() {
  show('si-overlay');
  siReset();
  setTimeout(() => document.getElementById('si-text').focus(), 100);
}

function siClose() {
  hide('si-overlay');
  siReset();
}

function siReset() {
  hide('si-review', 'si-thinking', 'si-done'); show('si-idle');
  document.getElementById('si-text').value = '';
  siActions = []; siStates = [];
}

// ═══════════════════════════════════════════════════════════════
// LENS SYSTEM — Bloomberg-style view switching (keys 1–4)
// ═══════════════════════════════════════════════════════════════

let currentLens = 'network';

function setLens(lens) {
  if (currentLens === lens) return;
  currentLens = lens;

  // Update active button
  document.querySelectorAll('.lens-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lens === lens);
  });

  // Destroy vis-network if switching away from network lens
  if (lens !== 'network' && network) {
    network.destroy();
    network = null;
  }

  const graphEl = document.getElementById('graph');
  graphEl.innerHTML = '';
  graphEl.style.display = '';
  hide('empty-state');

  switch (lens) {
    case 'network':  buildGraph();         break;
    case 'org':      renderOrgLens();      break;
    case 'time':     renderTimeLens();     break;
    case 'strength': renderStrengthLens(); break;
  }
}

function setupLensBar() {
  document.querySelectorAll('.lens-btn').forEach(btn => {
    btn.addEventListener('click', () => setLens(btn.dataset.lens));
  });
}

// ── Org Lens — company tiles with people inside ──────────────
function renderOrgLens() {
  const graphEl = document.getElementById('graph');
  const search = document.getElementById('search').value.toLowerCase();
  const coMap = new Map(data.companies.map(c => [c.id, c]));

  // Group people by company
  const byCompany = new Map();
  const ungrouped = [];
  data.people.forEach(p => {
    if (search && !p.full_name.toLowerCase().includes(search) &&
        !(p.role && p.role.toLowerCase().includes(search))) return;
    if (p.company_id && coMap.has(p.company_id)) {
      const arr = byCompany.get(p.company_id) || [];
      arr.push(p);
      byCompany.set(p.company_id, arr);
    } else {
      ungrouped.push(p);
    }
  });

  // Sort companies by headcount desc
  const companies = [...byCompany.entries()]
    .map(([id, people]) => ({ co: coMap.get(id), people }))
    .filter(x => x.co && isRealCompany(x.co.name))
    .sort((a, b) => b.people.length - a.people.length);

  const wrap = document.createElement('div');
  wrap.className = 'lens-org';

  companies.forEach(({ co, people }) => {
    const card = document.createElement('div');
    card.className = 'org-card';
    const meta = [co.type, co.industry, co.location].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="org-card-header">
        <div class="org-card-name">${co.name}</div>
        ${meta ? `<div class="org-card-meta">${meta}</div>` : ''}
      </div>
      <div class="org-card-people">
        ${people.slice(0, 8).map(p => {
          const recency = recencyClass(p.last_contact);
          return `<div class="org-person-row" data-pid="${p.id}">
            <span class="org-person-dot" style="background:${RECENCY_BORDER[recency]}"></span>
            <div class="org-person-info">
              <div class="org-person-name">${p.full_name}</div>
              ${p.role ? `<div class="org-person-role">${p.role}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
        ${people.length > 8 ? `<div class="org-person-row" style="color:var(--txt-ghost);font-size:10px;padding:4px 12px">+${people.length - 8} more</div>` : ''}
      </div>`;
    wrap.appendChild(card);
  });

  if (ungrouped.length) {
    const hdr = document.createElement('div');
    hdr.className = 'org-ungrouped-header';
    hdr.textContent = `No company (${ungrouped.length})`;
    wrap.appendChild(hdr);
    ungrouped.slice(0, 20).forEach(p => {
      const row = document.createElement('div');
      row.className = 'org-person-row';
      row.dataset.pid = p.id;
      const recency = recencyClass(p.last_contact);
      row.innerHTML = `
        <span class="org-person-dot" style="background:${RECENCY_BORDER[recency]}"></span>
        <div class="org-person-info">
          <div class="org-person-name">${p.full_name}</div>
          ${p.role ? `<div class="org-person-role">${p.role}</div>` : ''}
        </div>`;
      wrap.appendChild(row);
    });
  }

  // Wire tooltips
  const tooltip = document.getElementById('tooltip');
  wrap.querySelectorAll('[data-pid]').forEach(row => {
    row.addEventListener('mouseenter', e => {
      const p = data.people.find(x => x.id === row.dataset.pid);
      if (!p) return;
      const tags = (tagsByPerson.get(p.id) || []).filter(t => !IMPORT_SOURCE_TAGS.has(t));
      const rect = row.getBoundingClientRect();
      tooltip.style.left = Math.min(rect.right + 8, window.innerWidth - 340) + 'px';
      tooltip.style.top = Math.max(rect.top, 10) + 'px';
      tooltip.innerHTML = personHTML(p, tags);
      tooltip.classList.remove('hidden');
    });
    row.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });

  graphEl.appendChild(wrap);
}

// ── Time Lens — chronological buckets ───────────────────────
function renderTimeLens() {
  const graphEl = document.getElementById('graph');
  const now = Date.now();

  const BUCKETS = [
    { key: 'week',    label: 'This week',      ms: 7 * 86400000 },
    { key: 'month',   label: 'This month',     ms: 30 * 86400000 },
    { key: 'quarter', label: 'Last 3 months',  ms: 90 * 86400000 },
    { key: 'year',    label: 'This year',      ms: 365 * 86400000 },
    { key: 'older',   label: 'Older',          ms: Infinity },
    { key: 'never',   label: 'Never contacted', ms: null },
  ];

  const bucketMap = new Map(BUCKETS.map(b => [b.key, []]));

  data.people.forEach(p => {
    if (!p.last_contact) { bucketMap.get('never').push(p); return; }
    const age = now - new Date(p.last_contact).getTime();
    const bucket = BUCKETS.find(b => b.ms !== null && age <= b.ms) || BUCKETS.find(b => b.key === 'older');
    bucketMap.get(bucket.key).push(p);
  });

  const coMap = new Map(data.companies.map(c => [c.id, c]));
  const wrap = document.createElement('div');
  wrap.className = 'lens-time';

  BUCKETS.forEach(({ key, label }) => {
    const people = bucketMap.get(key);
    if (!people.length) return;
    people.sort((a, b) => {
      if (!a.last_contact) return 1;
      if (!b.last_contact) return -1;
      return new Date(b.last_contact) - new Date(a.last_contact);
    });

    const section = document.createElement('div');
    section.className = 'time-bucket';
    section.innerHTML = `<div class="time-bucket-label">${label} <span class="bucket-count">${people.length}</span></div>`;
    const row = document.createElement('div');
    row.className = 'time-bucket-row';

    people.forEach(p => {
      const co = p.company_id ? coMap.get(p.company_id) : null;
      const recency = recencyClass(p.last_contact);
      const dateStr = p.last_contact
        ? new Date(p.last_contact).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
        : 'no date';
      const card = document.createElement('div');
      card.className = `time-card${recency === 'stale' || key === 'never' ? ' stale' : ''}`;
      card.dataset.pid = p.id;
      card.innerHTML = `
        <div class="time-card-name">${p.full_name}</div>
        ${p.role ? `<div class="time-card-role">${p.role}${co && isRealCompany(co.name) ? ' · ' + co.name : ''}</div>` : ''}
        <div class="time-card-date">${dateStr}</div>`;
      row.appendChild(card);
    });

    section.appendChild(row);
    wrap.appendChild(section);
  });

  // Wire tooltips
  const tooltip = document.getElementById('tooltip');
  wrap.querySelectorAll('[data-pid]').forEach(card => {
    card.addEventListener('mouseenter', () => {
      const p = data.people.find(x => x.id === card.dataset.pid);
      if (!p) return;
      const tags = (tagsByPerson.get(p.id) || []).filter(t => !IMPORT_SOURCE_TAGS.has(t));
      const rect = card.getBoundingClientRect();
      tooltip.style.left = Math.min(rect.right + 8, window.innerWidth - 340) + 'px';
      tooltip.style.top = Math.max(rect.top, 10) + 'px';
      tooltip.innerHTML = personHTML(p, tags);
      tooltip.classList.remove('hidden');
    });
    card.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });

  graphEl.appendChild(wrap);
}

// ── Strength Lens — strong ties vs weak ties (Granovetter) ──
function renderStrengthLens() {
  const graphEl = document.getElementById('graph');
  const coMap = new Map(data.companies.map(c => [c.id, c]));

  // Count connections per person (explicit + inferred)
  const connCount = new Map();
  [...data.relationships, ...data.inferredEdges].forEach(r => {
    connCount.set(r.person_a_id, (connCount.get(r.person_a_id) || 0) + 1);
    connCount.set(r.person_b_id, (connCount.get(r.person_b_id) || 0) + 1);
  });

  // Strong ties: score = recency weight + relationship count
  const scored = data.people.map(p => {
    const now = Date.now();
    const recencyDays = p.last_contact
      ? (now - new Date(p.last_contact).getTime()) / 86400000
      : 9999;
    const recencyScore = recencyDays < 9999 ? Math.max(0, 100 - recencyDays / 3) : 0;
    const connScore = (connCount.get(p.id) || 0) * 10;
    return { p, score: recencyScore + connScore, conns: connCount.get(p.id) || 0, recencyDays };
  });

  const strong = [...scored]
    .filter(x => x.recencyDays < 365)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  // Weak ties: well-connected in network but haven't spoken recently
  const weak = [...scored]
    .filter(x => x.conns >= 2 && x.recencyDays > 180)
    .sort((a, b) => b.conns - a.conns)
    .slice(0, 30);

  function buildList(items, label, subtitle) {
    const col = document.createElement('div');
    col.className = 'strength-col';
    col.innerHTML = `<div class="strength-col-header">
      <div class="strength-col-title">${label}</div>
      <div class="strength-col-subtitle">${subtitle}</div>
    </div>`;
    const list = document.createElement('div');
    list.className = 'strength-list';

    items.forEach(({ p, conns, recencyDays }, i) => {
      const co = p.company_id ? coMap.get(p.company_id) : null;
      const recency = recencyClass(p.last_contact);
      const dateStr = recencyDays < 9999
        ? (recencyDays < 1 ? 'today' : `${Math.round(recencyDays)}d ago`)
        : 'never';
      const row = document.createElement('div');
      row.className = 'strength-row';
      row.dataset.pid = p.id;
      row.innerHTML = `
        <span class="strength-rank">${i + 1}</span>
        <span class="strength-dot" style="background:${RECENCY_BORDER[recency]}"></span>
        <div class="strength-info">
          <div class="strength-name">${p.full_name}</div>
          <div class="strength-role">${p.role || ''}${co && isRealCompany(co.name) ? (p.role ? ' · ' : '') + co.name : ''}</div>
        </div>
        <div class="strength-meta">${conns > 0 ? conns + ' links' : ''}<br>${dateStr}</div>`;
      list.appendChild(row);
    });

    if (!items.length) {
      list.innerHTML = '<div style="padding:16px;font-size:11px;color:var(--txt-ghost)">None yet — import more contacts or add interactions via "+ Add"</div>';
    }

    col.appendChild(list);
    return col;
  }

  const wrap = document.createElement('div');
  wrap.className = 'lens-strength';
  wrap.appendChild(buildList(strong, 'Strong ties', 'Recent contact + shared connections'));
  wrap.appendChild(buildList(weak, 'Weak ties worth nurturing', 'Well-connected but going cold — Granovetter bridges'));

  // Wire tooltips
  const tooltip = document.getElementById('tooltip');
  wrap.querySelectorAll('[data-pid]').forEach(row => {
    row.addEventListener('mouseenter', () => {
      const p = data.people.find(x => x.id === row.dataset.pid);
      if (!p) return;
      const tags = (tagsByPerson.get(p.id) || []).filter(t => !IMPORT_SOURCE_TAGS.has(t));
      const rect = row.getBoundingClientRect();
      tooltip.style.left = Math.min(rect.right + 8, window.innerWidth - 340) + 'px';
      tooltip.style.top = Math.max(rect.top, 10) + 'px';
      tooltip.innerHTML = personHTML(p, tags);
      tooltip.classList.remove('hidden');
    });
    row.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });

  graphEl.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════════════
// EMBEDDINGS — background queue, Web Worker, browser-local (free)
// ═══════════════════════════════════════════════════════════════

let embedWorker = null;
let embedQueue = [];
let embedProcessed = 0;
let embedTotal = 0;

// Called after import and on startApp — finds unembedded people, queues them
async function startEmbeddingQueue() {
  if (!currentUser || !window.Worker) return;

  // Fetch which people have no embedding (quick count query)
  const { data: unembedded } = await sb
    .from('people')
    .select('id,full_name,role,industry,what_they_do')
    .eq('user_id', currentUser.id)
    .is('embedding', null)
    .range(0, 4999);

  if (!unembedded || !unembedded.length) return;

  embedQueue = [...unembedded];
  embedProcessed = 0;
  embedTotal = unembedded.length;

  show('embed-progress');
  document.getElementById('embed-label').textContent = `Building intelligence… 0/${embedTotal}`;
  document.getElementById('embed-bar-fill').style.width = '0%';

  if (embedWorker) { embedWorker.terminate(); embedWorker = null; }

  try {
    embedWorker = new Worker('embed-worker.js');
  } catch (e) {
    // Web Workers may be blocked (e.g. file:// protocol). Silently skip.
    hide('embed-progress');
    return;
  }

  embedWorker.onmessage = async ({ data: msg }) => {
    if (msg.error) { embedProcessed++; } // skip failures silently
    else {
      // Store embedding in Supabase
      // Also flag dirty data at write time: detect company stored as person, etc.
      const person = embedQueue.find(p => p.id === msg.id);
      const dirtyFlags = {};
      if (person) {
        const name = (person.full_name || '').toLowerCase();
        const role = (person.role || '');
        const companyPatterns = /\b(inc|ltd|llc|corp|group|holdings|gmbh|pty|plc|limited|& co|s\.a\.)\b/i;
        if (companyPatterns.test(name)) dirtyFlags.name_is_company = true;
        if (role.length > 40 || companyPatterns.test(role)) dirtyFlags.role_is_company = true;
      }
      const update = { embedding: msg.embedding };
      if (Object.keys(dirtyFlags).length) update.dirty_data_flags = dirtyFlags;
      await sb.from('people').update(update).eq('id', msg.id);
      embedProcessed++;
    }

    const pct = Math.round((embedProcessed / embedTotal) * 100);
    document.getElementById('embed-bar-fill').style.width = pct + '%';
    document.getElementById('embed-label').textContent = `Building intelligence… ${embedProcessed}/${embedTotal}`;

    if (embedProcessed >= embedTotal) {
      hide('embed-progress');
      embedWorker.terminate();
      embedWorker = null;
      // Embeddings done — re-run inference to generate semantic-similar edges
      // These only appear after vectors exist, so we must trigger a second pass
      showToast('Embeddings complete — computing semantic connections…');
      await inferEdges();
    }
  };

  embedWorker.onerror = () => {
    hide('embed-progress');
    if (embedWorker) { embedWorker.terminate(); embedWorker = null; }
  };

  // Send in batches of 5 to avoid overwhelming the worker
  const BATCH = 5;
  function sendBatch(start) {
    embedQueue.slice(start, start + BATCH).forEach(p => {
      // Weight role and industry heavily — these are the semantic signals.
      // Repeating role twice makes the embedding cluster by function not name.
      // Format: "{role} {role} {industry} {what_they_do}" — name excluded intentionally.
      const text = [p.role, p.role, p.industry, p.what_they_do].filter(Boolean).join(' ') ||
                   p.full_name || '';
      embedWorker?.postMessage({ id: p.id, text });
    });
  }

  // Send first batch, then piggyback on responses for pacing
  let sent = 0;
  const origOnMessage = embedWorker.onmessage;
  embedWorker.onmessage = async (e) => {
    await origOnMessage(e);
    sent++;
    if (sent % BATCH === 0 && sent < embedTotal) sendBatch(sent);
  };
  sendBatch(0);
}

// ═══════════════════════════════════════════════════════════════
// COMMAND PALETTE (Cmd+K) — three-tier query routing
// ═══════════════════════════════════════════════════════════════

let paletteSelectedIndex = -1;

function openPalette() {
  show('palette-overlay');
  const input = document.getElementById('palette-input');
  input.value = '';
  paletteSelectedIndex = -1;
  input.focus();
  queryPalette(''); // show top contacts immediately
}

function closePalette() {
  hide('palette-overlay');
  document.getElementById('palette-input').value = '';
}

function movePaletteSelection(dir) {
  const results = document.querySelectorAll('.palette-result');
  if (!results.length) return;
  results[paletteSelectedIndex]?.classList.remove('selected');
  paletteSelectedIndex = Math.max(0, Math.min(results.length - 1, paletteSelectedIndex + dir));
  results[paletteSelectedIndex]?.classList.add('selected');
  results[paletteSelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function selectPaletteResult() {
  const sel = document.querySelector('.palette-result.selected');
  if (sel) sel.click();
}

async function queryPalette(q) {
  const resultsEl = document.getElementById('palette-results');
  const query = q.trim().toLowerCase();
  const coMap = new Map(data.companies.map(c => [c.id, c]));
  let results = [];
  let sectionLabel = '';

  // ── Tier 3: /ask — fall through to LLM ──
  if (query.startsWith('/ask ')) {
    const question = q.slice(5).trim();
    if (!question) return;
    resultsEl.innerHTML = '<div class="palette-ask-result">Thinking…</div>';
    const answer = await chatWithProviderSync([
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + buildContext() },
      { role: 'user', content: question },
    ]);
    resultsEl.innerHTML = `<div class="palette-ask-result">${answer || 'No answer.'}</div>`;
    return;
  }

  // ── Tier 1: structured queries ──
  if (query === '') {
    // Empty: show most recently contacted
    sectionLabel = 'Recently contacted';
    results = [...data.people]
      .filter(p => p.last_contact)
      .sort((a, b) => new Date(b.last_contact) - new Date(a.last_contact))
      .slice(0, 10)
      .map(p => ({ type: 'person', p }));
  } else if (query.startsWith('@') || query.startsWith('at:')) {
    sectionLabel = 'Company';
    const coQ = query.replace(/^@|^at:/, '');
    const matchCos = data.companies.filter(c => c.name.toLowerCase().includes(coQ));
    const coIds = new Set(matchCos.map(c => c.id));
    results = data.people
      .filter(p => p.company_id && coIds.has(p.company_id))
      .map(p => ({ type: 'person', p }));
  } else if (query.startsWith('#')) {
    sectionLabel = 'Tag';
    const tagQ = query.slice(1);
    const matchIds = new Set(
      data.tags.filter(t => !IMPORT_SOURCE_TAGS.has(t.tag) && t.tag.includes(tagQ)).map(t => t.person_id)
    );
    results = data.people.filter(p => matchIds.has(p.id)).map(p => ({ type: 'person', p }));
  } else if (query.startsWith('role:')) {
    sectionLabel = 'Role';
    const roleQ = query.slice(5);
    results = data.people
      .filter(p => p.role && p.role.toLowerCase().includes(roleQ))
      .map(p => ({ type: 'person', p }));
  } else if (query === 'stale:' || query === 'stale') {
    sectionLabel = 'Stale contacts';
    results = data.people
      .filter(p => recencyClass(p.last_contact) === 'stale' || recencyClass(p.last_contact) === 'never')
      .sort((a, b) => {
        if (!a.last_contact) return -1;
        if (!b.last_contact) return 1;
        return new Date(a.last_contact) - new Date(b.last_contact);
      })
      .slice(0, 20)
      .map(p => ({ type: 'person', p }));
  } else {
    // ── Tier 2: fuzzy text search (client-side, data already in memory) ──
    sectionLabel = 'People';
    const q2 = query;
    results = data.people
      .filter(p => {
        const co = p.company_id ? coMap.get(p.company_id) : null;
        return p.full_name.toLowerCase().includes(q2) ||
          (p.role && p.role.toLowerCase().includes(q2)) ||
          (co && co.name.toLowerCase().includes(q2)) ||
          (p.industry && p.industry.toLowerCase().includes(q2));
      })
      .slice(0, 15)
      .map(p => ({ type: 'person', p }));
  }

  renderPaletteResults(results, sectionLabel, coMap);
}

function renderPaletteResults(results, sectionLabel, coMap) {
  const resultsEl = document.getElementById('palette-results');
  paletteSelectedIndex = -1;

  if (!results.length) {
    resultsEl.innerHTML = '<div class="palette-empty">No results</div>';
    return;
  }

  let html = sectionLabel ? `<div class="palette-section-label">${sectionLabel}</div>` : '';

  results.forEach(({ type, p }, i) => {
    const co = p.company_id ? coMap?.get(p.company_id) : null;
    const coName = co && isRealCompany(co.name) ? co.name : '';
    const recency = recencyClass(p.last_contact);
    const dateStr = p.last_contact
      ? new Date(p.last_contact).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      : '';

    html += `<div class="palette-result" data-pid="${p.id}">
      <span class="palette-result-dot" style="background:${RECENCY_BORDER[recency]}"></span>
      <div class="palette-result-info">
        <div class="palette-result-name">${p.full_name}</div>
        <div class="palette-result-sub">${[p.role, coName].filter(Boolean).join(' · ')}</div>
      </div>
      ${dateStr ? `<span class="palette-result-recency">${dateStr}</span>` : ''}
    </div>`;
  });

  resultsEl.innerHTML = html;

  // Wire click handlers
  resultsEl.querySelectorAll('.palette-result[data-pid]').forEach(el => {
    el.addEventListener('click', () => {
      const pid = el.dataset.pid;
      closePalette();
      // Switch to network lens and highlight the node
      setLens('network');
      setTimeout(() => {
        if (network) {
          network.selectNodes(['p_' + pid]);
          network.focus('p_' + pid, { scale: 1.2, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
          // Show tooltip
          const p = data.people.find(x => x.id === pid);
          if (p) {
            const pos = network.canvasToDOM(network.getPosition('p_' + pid));
            const tooltip = document.getElementById('tooltip');
            tooltip.style.left = Math.min(pos.x + 20, window.innerWidth - 340) + 'px';
            tooltip.style.top = Math.max(pos.y - 10, 10) + 'px';
            const tags = (tagsByPerson.get(p.id) || []).filter(t => !IMPORT_SOURCE_TAGS.has(t));
            tooltip.innerHTML = personHTML(p, tags);
            tooltip.classList.remove('hidden');
          }
        }
      }, 100);
    });
  });
}

function setupPalette() {
  const input = document.getElementById('palette-input');
  const backdrop = document.getElementById('palette-backdrop');

  input.addEventListener('input', () => queryPalette(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSelection(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); movePaletteSelection(-1); }
    if (e.key === 'Enter')     { e.preventDefault(); selectPaletteResult(); }
    if (e.key === 'Escape')    closePalette();
  });
  backdrop.addEventListener('click', closePalette);
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function show(...ids) { ids.forEach(id => document.getElementById(id)?.classList.remove('hidden')); }
function hide(...ids) { ids.forEach(id => document.getElementById(id)?.classList.add('hidden')); }

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Welcome / Landing — "Get started" dismisses landing and shows auth
  function dismissLanding() {
    const wrap = document.getElementById('landing-wrap');
    wrap.classList.add('dismissed');
  }
  document.getElementById('welcome-btn').addEventListener('click', dismissLanding);
  document.getElementById('land-cta')?.addEventListener('click', dismissLanding);

  // Setup auth + onboarding + empty state
  setupAuth();
  setupProvider();
  setupImport();
  setupEmptyState();

  // Check existing session
  const { data: { session } } = await sb.auth.getSession();

  // Auth overlay hidden until needed
  hide('auth-overlay');

  if (session) {
    currentUser = session.user;
    // Logged in — skip landing, go straight to app
    dismissLanding();
    await onAuthenticated();
  }

  // Wire CTA buttons to dismiss landing → show auth (if not logged in)
  function onLandingDismiss() {
    if (!currentUser) show('auth-overlay');
  }
  document.getElementById('welcome-btn').addEventListener('click', onLandingDismiss);
  document.getElementById('land-cta')?.addEventListener('click', onLandingDismiss);

  // Lens bar + command palette + context menu setup
  setupLensBar();
  setupPalette();
  setupContextMenu();

  // Graph controls
  document.getElementById('search').addEventListener('input', () => {
    if (currentLens === 'network') buildGraph();
    else if (currentLens === 'org') renderOrgLens();
  });
  document.getElementById('tag-filter').addEventListener('change', () => buildGraph());
  document.getElementById('fit-btn').addEventListener('click', () => network?.fit({ animation: true }));

  // + Add person — schema form (primary path)
  document.getElementById('si-trigger').addEventListener('click', openAddPersonForm);
  // AI path — secondary
  document.getElementById('si-trigger-ai')?.addEventListener('click', siOpen);
  // Add person form wiring
  document.getElementById('add-person-cancel').addEventListener('click', () => hide('add-person-overlay'));
  document.getElementById('add-person-backdrop').addEventListener('click', () => hide('add-person-overlay'));
  document.getElementById('add-person-save').addEventListener('click', savePersonFromForm);
  document.getElementById('ap-ai-toggle')?.addEventListener('click', () => { hide('add-person-overlay'); siOpen(); });
  document.getElementById('ap-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('add-person-save').click(); }
  });

  // Person panel wiring
  document.getElementById('pp-close').addEventListener('click', hidePersonPanel);
  document.getElementById('pp-delete-btn').addEventListener('click', () => {
    if (panelPerson) deletePersonConfirm(panelPerson);
  });
  document.getElementById('pp-edit-btn').addEventListener('click', openPersonEdit);

  // Graph hint bar — dismiss on click or auto-dismiss after 8s
  const hintEl = document.getElementById('graph-hint');
  const hintDismissed = localStorage.getItem('kenoki-hint-dismissed');
  if (hintDismissed) hintEl?.classList.add('dismissed');
  document.getElementById('graph-hint-close')?.addEventListener('click', () => {
    hintEl?.classList.add('dismissed');
    localStorage.setItem('kenoki-hint-dismissed', '1');
  });
  if (!hintDismissed) setTimeout(() => hintEl?.classList.add('dismissed'), 8000);

  // Smart input — overlay (AI path)
  document.getElementById('si-backdrop').addEventListener('click', siClose);
  document.getElementById('si-cancel').addEventListener('click', siClose);
  document.getElementById('si-submit').addEventListener('click', () => {
    const text = document.getElementById('si-text').value.trim();
    if (text) siProcess(text);
  });
  document.getElementById('si-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('si-submit').click(); }
    if (e.key === 'Escape') siClose();
  });
  document.getElementById('si-confirm').addEventListener('click', siExecute);
  document.getElementById('si-discard').addEventListener('click', siReset);
  document.getElementById('si-reset').addEventListener('click', siClose);
  document.getElementById('si-another').addEventListener('click', siReset);
  // Global keyboard shortcuts
  document.addEventListener('keydown', e => {
    // ESC: close overlays in priority order
    if (e.key === 'Escape') {
      if (!document.getElementById('add-person-overlay').classList.contains('hidden')) { hide('add-person-overlay'); return; }
      if (!document.getElementById('si-overlay').classList.contains('hidden')) { siClose(); return; }
      if (!document.getElementById('palette-overlay').classList.contains('hidden')) { closePalette(); return; }
      if (!document.getElementById('person-panel').classList.contains('hidden')) { hidePersonPanel(); return; }
      hideCtxMenu();
      return;
    }
    // Don't intercept shortcuts while typing
    if (e.target.matches('input, textarea')) return;
    // Cmd+K / Ctrl+K — open command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPalette(); return; }
    // 1–4 — lens switching
    if (e.key === '1' && data.people.length) { setLens('network'); return; }
    if (e.key === '2' && data.people.length) { setLens('org'); return; }
    if (e.key === '3' && data.people.length) { setLens('time'); return; }
    if (e.key === '4' && data.people.length) { setLens('strength'); return; }
  });

  // Chat
  document.getElementById('chat-send').addEventListener('click', () => {
    const input = document.getElementById('chat-input');
    const q = input.value.trim();
    if (q) { input.value = ''; sendChat(q); }
  });
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('chat-send').click(); }
  });
  document.getElementById('chat-refresh').addEventListener('click', () => { chatContext = null; });
  document.getElementById('chat-clear').addEventListener('click', () => {
    document.getElementById('chat-messages').innerHTML =
      `<div class="chat-empty" id="chat-empty">
        <div class="chat-empty-label">Try asking:</div>
        <button class="chat-suggestion" data-q="Who are the most connected people?">"Most connected?"</button>
        <button class="chat-suggestion" data-q="Who should I follow up with?">"Follow up?"</button>
      </div>`;
    bindSuggestions();
    chatContext = null;
  });

  bindSuggestions();

  // ── Demo graph on landing page ──
  buildDemoGraph();
});

// ═══════════════════════════════════════════════════════════════
// DEMO GRAPH (landing page — interactive sample data)
// ═══════════════════════════════════════════════════════════════

function buildDemoGraph() {
  const container = document.getElementById('demo-graph');
  if (!container) return;

  const people = [
    { id: 1, label: 'Sarah Chen', title: 'Partner\nSequoia Capital\n\nTags: vc, investor' },
    { id: 2, label: 'James Carter', title: 'Head of Sales\nStripe\n\nTags: sales, fintech' },
    { id: 3, label: 'Maria Lopez', title: 'Founder & CEO\nLuma Health\n\nTags: founder, healthtech' },
    { id: 4, label: 'Ben Turner', title: 'VP Engineering\nNotion\n\nTags: engineering, product' },
    { id: 5, label: 'Katy Mills', title: 'Talent Lead\nAccel\n\nTags: recruiting, vc' },
    { id: 6, label: 'David Kim', title: 'Managing Director\nAndreessen Horowitz\n\nTags: vc, investor' },
    { id: 7, label: 'Priya Patel', title: 'COO\nFigma\n\nTags: operations, design' },
    { id: 8, label: 'Tom Rivera', title: 'Sales Director\nDatadog\n\nTags: sales, enterprise' },
    { id: 9, label: 'Emma Wilson', title: 'Founder\nArc Browser\n\nTags: founder, consumer' },
    { id: 10, label: 'Alex Morgan', title: 'Partner\nFirst Round Capital\n\nTags: vc, seed' },
    { id: 11, label: 'Chris Lee', title: 'CTO\nLinear\n\nTags: engineering, tools' },
    { id: 12, label: 'Rachel Green', title: 'Head of Marketing\nVercel\n\nTags: marketing, devtools' },
    { id: 13, label: 'Mike Zhang', title: 'Founder\nReplit\n\nTags: founder, ai' },
    { id: 14, label: 'Sophie Adams', title: 'BD Director\nOpenAI\n\nTags: partnerships, ai' },
    { id: 15, label: 'Ryan Park', title: 'Principal\nLightspeed\n\nTags: vc, growth' },
    { id: 16, label: 'Lisa Wang', title: 'CEO\nSheWorx\n\nTags: founder, community' },
    { id: 17, label: 'Dan Patel', title: 'Investor\nTiger Global\n\nTags: investor, growth' },
    { id: 18, label: 'Olivia Scott', title: 'VP Product\nAirtable\n\nTags: product, enterprise' },
  ];

  const companies = [
    { id: 'c1', label: 'Sequoia', shape: 'diamond', size: 14, color: { background: C.green, border: C.border } },
    { id: 'c2', label: 'Stripe', shape: 'diamond', size: 14, color: { background: C.markSecondary, border: C.border } },
    { id: 'c3', label: 'Notion', shape: 'diamond', size: 12, color: { background: C.markAccent, border: C.border } },
    { id: 'c4', label: 'Accel', shape: 'diamond', size: 12, color: { background: C.green, border: C.border } },
    { id: 'c5', label: 'a16z', shape: 'diamond', size: 14, color: { background: C.mark, border: C.border } },
    { id: 'c6', label: 'OpenAI', shape: 'diamond', size: 14, color: { background: C.markSecondary, border: C.border } },
  ];

  const nodes = [
    ...people.map(p => ({
      ...p, shape: 'dot', size: 10,
      color: { background: C.mark, border: C.border,
        highlight: { background: C.mark, border: C.teal },
        hover: { background: C.markHover, border: C.teal } },
      font: { color: C.txt2, size: 10 },
    })),
    ...companies.map(co => ({
      ...co,
      font: { color: C.txt2, size: 9 },
      borderWidth: 1.5,
    })),
  ];

  const edges = [
    // People ↔ Companies
    { from: 1, to: 'c1' }, { from: 6, to: 'c5' }, { from: 2, to: 'c2' },
    { from: 4, to: 'c3' }, { from: 5, to: 'c4' }, { from: 14, to: 'c6' },
    // People ↔ People (relationships)
    { from: 1, to: 2, label: 'YC batch' }, { from: 1, to: 3, label: 'board' },
    { from: 1, to: 6, label: 'co-invested' }, { from: 2, to: 8, label: 'sales conf' },
    { from: 3, to: 7, label: 'intro' }, { from: 4, to: 11, label: 'eng meetup' },
    { from: 5, to: 10, label: 'VC network' }, { from: 6, to: 15 },
    { from: 9, to: 13, label: 'founders dinner' }, { from: 10, to: 17 },
    { from: 7, to: 12 }, { from: 11, to: 13 }, { from: 14, to: 6 },
    { from: 15, to: 17, label: 'growth stage' }, { from: 16, to: 9 },
    { from: 12, to: 18 }, { from: 3, to: 16, label: 'community' },
    { from: 8, to: 18 },
  ].map(e => ({
    ...e,
    color: { color: e.label ? C.green : C.border, opacity: e.label ? 0.4 : 0.2 },
    width: e.label ? 1.2 : 0.6,
    font: { color: C.txtGhost, size: 7, strokeWidth: 0 },
    smooth: { type: 'dynamic' },
    dashes: e.label ? false : [4, 4],
  }));

  new vis.Network(container, { nodes, edges }, {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -50, centralGravity: 0.006, springLength: 120, springConstant: 0.025, damping: 0.4 },
      stabilization: { iterations: 200, fit: true },
    },
    interaction: { hover: true, tooltipDelay: 100, zoomView: true, dragView: true },
    nodes: { font: { face: '-apple-system, system-ui, sans-serif' } },
    edges: { smooth: { enabled: true, type: 'continuous', roundness: 0.5 } },
  });
}

function bindSuggestions() {
  document.querySelectorAll('.chat-suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('chat-input').value = btn.dataset.q;
      document.getElementById('chat-send').click();
    });
  });
}
