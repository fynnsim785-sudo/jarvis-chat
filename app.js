// Jarvis Chat (Handy): nur Chat. Nichts am PC wird ausgeführt. Der PC meldet seinen Stand, der Chat nennt bei PC aus den letzten Wert.
(function () {
  'use strict';
  const CFG = window.JC_CONFIG;
  const $ = (id) => document.getElementById(id);
  const msgsEl = $('msgs'), inputEl = $('input'), sendBtn = $('send'), formEl = $('form');
  let code = localStorage.getItem('jc-code') || '';
  let state = { exists: false, pc_seen: null, snapshot: null, snapshot_at: null };
  let skew = 0; // Serverzeit - Handyzeit
  let lastId = 0; const seen = new Set(); const waiters = new Map(); let history = []; let busy = false; let typingEl = null;

  // ---------- Server ----------
  async function rpc(name, args) {
    if (window.JC_RPC) return window.JC_RPC(name, args || {});
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(CFG.url + '/rest/v1/rpc/' + name, { method: 'POST', signal: ctl.signal, headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
      const txt = await r.text();
      if (!r.ok) { let m = txt; try { m = JSON.parse(txt).message || txt; } catch { /* text */ } throw new Error(m); }
      return txt ? JSON.parse(txt) : null;
    } finally { clearTimeout(t); }
  }

  // ---------- Nummer ----------
  function newCode() {
    let s = ''; const b = new Uint8Array(64); crypto.getRandomValues(b);
    for (const x of b) { if (x < 250) s += String(x % 10); if (s.length === 12) break; }
    return s.length === 12 ? s : newCode();
  }
  const pretty = (c) => '+1 ' + c.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
  const command = () => 'Verbinde Handy-Chat mit ' + pretty(code);
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); }
    if (btn) { const o = btn.textContent; btn.textContent = 'Kopiert'; setTimeout(() => { btn.textContent = o; }, 1400); }
  }

  // ---------- Zeit ----------
  const now = () => Date.now() + skew;
  function ago(ms) {
    const m = Math.round(ms / 60000);
    if (ms < 90000) return 'gerade eben';
    if (m < 60) return 'vor ' + m + ' Min';
    const h = Math.round(ms / 3600000); if (h < 36) return 'vor ' + h + (h === 1 ? ' Stunde' : ' Std');
    const d = Math.round(ms / 86400000); return 'vor ' + d + (d === 1 ? ' Tag' : ' Tagen');
  }
  const clock = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const dayTime = (iso) => { const d = new Date(iso); const today = new Date(now()); const same = d.toDateString() === today.toDateString(); const y = new Date(now() - 86400000).toDateString() === d.toDateString(); return (same ? 'heute' : y ? 'gestern' : d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })) + ' um ' + clock(iso); };
  const gb = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('de-DE') + ' GB';
  const pcOnline = () => !!state.pc_seen && now() - Date.parse(state.pc_seen) < 75000;

  // ---------- Anzeige ----------
  function addMsg(m) {
    if (m.id != null) { if (seen.has(m.id)) return; seen.add(m.id); if (m.id > lastId) lastId = m.id; }
    const e = msgsEl.querySelector('.empty'); if (e) e.remove();
    const div = document.createElement('div'); div.className = 'msg ' + m.role; div.textContent = m.body;
    const s = document.createElement('small'); s.textContent = (m.role === 'jarvis' ? (m.via === 'pc' ? 'vom PC' : m.via === 'cloud' ? 'Cloud' : '') + (m.via === 'pc' || m.via === 'cloud' ? ' · ' : '') : '') + clock(m.created_at || new Date(now()).toISOString());
    div.appendChild(s);
    if (typingEl) msgsEl.insertBefore(div, typingEl); else msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    history.push({ role: m.role === 'jarvis' ? 'assistant' : 'user', content: m.body }); history = history.slice(-10);
    if (m.reply_to != null && waiters.has(m.reply_to)) { const w = waiters.get(m.reply_to); waiters.delete(m.reply_to); w(m); }
  }
  function typing(on) {
    if (on && !typingEl) { typingEl = document.createElement('div'); typingEl.className = 'msg jarvis typing'; typingEl.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>'; msgsEl.appendChild(typingEl); msgsEl.scrollTop = msgsEl.scrollHeight; }
    if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }
  function emptyHint() {
    if (msgsEl.children.length) return;
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = 'Frag mich zum Beispiel: Wie viel GB habe ich noch auf meinem PC? Wie warm ist meine Grafikkarte? Oder einfach irgendetwas anderes.';
    msgsEl.appendChild(d);
  }
  function render() {
    const st = $('status'); const label = st.querySelector('span');
    st.className = 'pill';
    if (!state.pc_seen) { st.classList.add('off'); label.textContent = 'PC noch nicht verbunden'; }
    else if (pcOnline()) { st.classList.add('on'); label.textContent = 'PC an'; }
    else { st.classList.add('off'); label.textContent = 'PC aus · ' + ago(now() - Date.parse(state.pc_seen)); }
    $('pair').hidden = !!state.pc_seen;
    $('number').textContent = pretty(code); $('cmd').textContent = command(); $('sheet-number').textContent = pretty(code);
    const note = $('note');
    if (state.pc_seen && !pcOnline()) { note.hidden = false; note.textContent = 'Dein PC ist aus. Ich antworte aus der Cloud. PC-Werte sind vom letzten Mal, als er an war.'; } else note.hidden = true;
  }

  // ---------- Fragen zum PC (ohne KI, aus dem letzten Stand) ----------
  const norm = (s) => String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9: ]+/g, ' ').replace(/\s+/g, ' ').trim();
  function prefix() {
    const s = state.snapshot; if (!s) return '';
    const at = state.snapshot_at; const age = now() - Date.parse(at);
    if (pcOnline() && age < 150000) return 'Gerade eben: ';
    return 'Stand von ' + dayTime(at) + ' (' + ago(age) + '), als dein PC zuletzt an war: ';
  }
  function localAnswer(text) {
    const t = norm(text); const s = state.snapshot;
    const about = /\b(pc|rechner|computer|laptop|festplatte|platte|ssd|laufwerk|ram|arbeitsspeicher|grafikkarte|gpu|cpu|prozessor|speicher|gb)\b/.test(t);
    const noData = () => state.pc_seen ? null : 'Dein PC hat sich noch nie bei mir gemeldet, deshalb kenne ich seine Werte noch nicht. Verbinde ihn zuerst mit der Nummer oben.';
    if (/\b(ram|arbeitsspeicher)\b/.test(t)) {
      if (!s) return noData() || 'Ich habe noch keinen Stand von deinem PC.';
      return prefix() + 'Vom Arbeitsspeicher sind ' + gb(s.ram.free) + ' frei von ' + gb(s.ram.total) + '.';
    }
    if (/\b(grafikkarte|gpu|temperatur|temperaturen)\b/.test(t) || (/\b(heiss|warm)\b/.test(t) && about)) {
      if (!s) return noData() || 'Ich habe noch keinen Stand von deinem PC.';
      if (!s.gpu) return prefix() + 'Von der Grafikkarte habe ich keine Werte.';
      return prefix() + s.gpu.name + ': ' + s.gpu.temp + ' Grad, ' + s.gpu.util + ' Prozent ausgelastet, ' + gb(s.gpu.vramUsed / 1024) + ' von ' + gb(s.gpu.vramTotal / 1024) + ' Grafikspeicher belegt.';
    }
    if (/\b(cpu|prozessor|auslastung)\b/.test(t)) {
      if (!s) return noData() || 'Ich habe noch keinen Stand von deinem PC.';
      return prefix() + 'Der Prozessor war mit ' + s.cpu + ' Prozent ausgelastet.';
    }
    if (/\b(festplatte|platte|ssd|laufwerk|speicherplatz|platz|gb|speicher|frei)\b/.test(t) && /\b(noch|frei|habe|platz|gb|wie viel|wieviel|voll)\b/.test(t) && about) {
      if (!s) return noData() || 'Ich habe noch keinen Stand von deinem PC.';
      const m = t.match(/\b(?:laufwerk|platte|disk|auf)\s+([a-z])\b|\b([a-z]):/); const letter = m && (m[1] || m[2]); const only = letter && s.disks.find((d) => d.d.toLowerCase().startsWith(letter + ':'));
      const list = only ? [only] : s.disks;
      if (list.length === 1) return prefix() + 'Auf ' + list[0].d + ' sind noch ' + gb(list[0].free) + ' frei (von ' + gb(list[0].total) + ').';
      return prefix() + list.map((d) => d.d + ' ' + gb(d.free) + ' frei von ' + gb(d.total)).join(', ') + '.';
    }
    if ((/\b(wann|seit wann|wie lange)\b/.test(t) && /\b(an|online|laeuft|gelaufen|gemeldet|angeschaltet|zuletzt)\b/.test(t) && about) || /\bist (mein |der )?(pc|rechner|computer|laptop) (gerade )?(an|aus|online)\b/.test(t)) {
      if (!state.pc_seen) return noData();
      if (pcOnline()) return 'Dein PC ist gerade an' + (s && s.uptimeH != null ? ' und läuft seit ' + (s.uptimeH < 1 ? Math.round(s.uptimeH * 60) + ' Minuten' : (Math.round(s.uptimeH * 10) / 10).toLocaleString('de-DE') + ' Stunden') : '') + '.';
      return 'Dein PC ist gerade aus. Er hat sich zuletzt ' + dayTime(state.pc_seen) + ' gemeldet (' + ago(now() - Date.parse(state.pc_seen)) + ').';
    }
    return null;
  }

  // ---------- Cloud-Antwort (wenn der PC aus ist) ----------
  function snapText() {
    const s = state.snapshot; if (!s) return 'Vom PC sind keine Werte bekannt.';
    return 'Letzter bekannter PC-Stand (' + dayTime(state.snapshot_at) + '): ' + s.disks.map((d) => 'Laufwerk ' + d.d + ' ' + gb(d.free) + ' frei von ' + gb(d.total)).join('; ') + '; Arbeitsspeicher ' + gb(s.ram.free) + ' frei von ' + gb(s.ram.total) + '; Prozessor ' + s.cpu + ' Prozent' + (s.gpu ? '; Grafikkarte ' + s.gpu.name + ' ' + s.gpu.temp + ' Grad' : '') + '.';
  }
  async function cloud() {
    const sys = 'Du bist Jarvis, der persönliche KI-Assistent des Nutzers, hier im Handy-Chat. Du sprichst Deutsch, duzt den Nutzer, bist höflich und präzise mit leicht trockenem Humor und antwortest kurz in 1 bis 4 Sätzen, ohne Markdown und ohne Emojis. WICHTIG: Im Handy-Chat kannst du nur schreiben. Du kannst nichts auf dem PC ausführen, öffnen, starten, löschen oder verändern, auch wenn der Nutzer darum bittet. Sag dann freundlich, dass das nur direkt am PC geht. ' +
      (pcOnline() ? 'Der PC des Nutzers ist gerade an, hat aber nicht rechtzeitig geantwortet. ' : state.pc_seen ? 'Der PC des Nutzers ist gerade AUS (zuletzt an: ' + dayTime(state.pc_seen) + '). ' : 'Der PC des Nutzers ist noch nicht verbunden. ') +
      'Nenne PC-Werte nur, wenn sie hier stehen, und erfinde nie welche. ' + snapText() + ' Heute ist ' + new Date(now()).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '.';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 55000);
    try {
      const r = await fetch('https://text.pollinations.ai/openai', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', private: true, messages: [{ role: 'system', content: sys }, ...history.slice(-8)] }) });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      const out = String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!out) throw new Error('leer');
      return out;
    } finally { clearTimeout(t); }
  }

  // ---------- Senden ----------
  async function refreshState() {
    const s = await rpc('jc_state', { p_code: code });
    if (s && s.exists === false) { await rpc('jc_create', { p_code: code }); return refreshState(); }
    if (s) { state = s; skew = Date.parse(s.now) - Date.now(); }
    render();
  }
  async function reply(toId, body, via) { try { const id = await rpc('jc_post', { p_code: code, p_role: 'jarvis', p_via: via, p_body: body, p_reply_to: toId }); addMsg({ id: Number(id), role: 'jarvis', via, body, reply_to: toId }); } catch { addMsg({ role: 'jarvis', via, body }); } }
  async function send(text) {
    if (busy) return; busy = true; sendBtn.disabled = true;
    try {
      let id;
      try { id = Number(await rpc('jc_post', { p_code: code, p_role: 'user', p_via: 'phone', p_body: text, p_reply_to: null })); }
      catch (e) { addMsg({ role: 'jarvis', via: '', body: 'Das Senden hat nicht geklappt: ' + e.message }); return; }
      addMsg({ id, role: 'user', via: 'phone', body: text });
      try { await refreshState(); } catch { /* alten Stand behalten */ }
      const local = localAnswer(text);
      if (local) { await reply(id, local, 'cloud'); return; }
      typing(true);
      if (pcOnline()) {
        // der PC antwortet mit seinem eigenen Modell, bis zu 30 Sekunden warten
        const got = await Promise.race([new Promise((res) => waiters.set(id, res)), new Promise((res) => setTimeout(() => res(null), 30000))]);
        waiters.delete(id);
        if (got) return;
      }
      try { await reply(id, await cloud(), 'cloud'); }
      catch { addMsg({ role: 'jarvis', via: '', body: 'Der Cloud-Chat antwortet gerade nicht. Fragen zu Speicher, RAM, Grafikkarte oder wann der PC an war beantworte ich trotzdem aus dem letzten Stand.' }); }
    } finally { typing(false); busy = false; sendBtn.disabled = false; inputEl.focus(); }
  }

  async function poll() {
    try {
      const list = await rpc('jc_list', { p_code: code, p_after: lastId });
      for (const m of (list || [])) { if (m.role === 'user' && seen.has(Number(m.id))) continue; addMsg({ id: Number(m.id), role: m.role, via: m.via, body: m.body, reply_to: m.reply_to == null ? null : Number(m.reply_to), created_at: m.created_at }); }
      if (!msgsEl.children.length) emptyHint();
    } catch { /* offline, naechster Versuch */ }
  }

  // ---------- Start ----------
  function bind() {
    formEl.addEventListener('submit', (e) => { e.preventDefault(); const t = inputEl.value.trim(); if (!t) return; inputEl.value = ''; inputEl.style.height = 'auto'; send(t); });
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width:700px)').matches) { e.preventDefault(); formEl.requestSubmit(); } });
    inputEl.addEventListener('input', () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px'; });
    $('copy-number').onclick = (e) => copy(pretty(code), e.target); $('copy-cmd').onclick = (e) => copy(command(), e.target);
    $('sheet-copy').onclick = (e) => copy(pretty(code), e.target); $('sheet-cmd').onclick = (e) => copy(command(), e.target);
    $('menu-btn').onclick = () => { $('sheet').hidden = false; }; $('sheet-close').onclick = () => { $('sheet').hidden = true; };
    $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('sheet').hidden = true; });
    $('sheet-new').onclick = async () => {
      if (!confirm('Neue Nummer erstellen? Der Chat wird gelöscht und Jarvis am PC muss neu verbunden werden.')) return;
      try { await rpc('jc_forget', { p_code: code }); } catch { /* egal */ }
      code = newCode(); localStorage.setItem('jc-code', code); await rpc('jc_create', { p_code: code });
      msgsEl.textContent = ''; seen.clear(); lastId = 0; history = []; state = { exists: true, pc_seen: null, snapshot: null }; $('sheet').hidden = true; render(); emptyHint();
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); refreshState().catch(() => {}); } });
  }
  async function start() {
    if (!/^\d{12}$/.test(code)) { code = newCode(); localStorage.setItem('jc-code', code); }
    bind(); render(); emptyHint();
    try { await rpc('jc_create', { p_code: code }); await refreshState(); }
    catch (e) { $('note').hidden = false; $('note').textContent = 'Keine Verbindung zum Server. Prüfe dein Internet. (' + e.message + ')'; }
    await poll();
    setInterval(() => { if (!document.hidden) poll(); }, 3000);
    setInterval(() => { if (!document.hidden) refreshState().catch(() => {}); }, 8000);
    setInterval(render, 30000);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.JC = { localAnswer, pretty, get state() { return state; }, set state(v) { state = v; }, send, start, ago, get code() { return code; } };
  start();
})();
