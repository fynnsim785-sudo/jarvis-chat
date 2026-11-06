// Jarvis Chat: Einstellungen, Sprechen, Anruf-Modus, Benachrichtigungen und PC-Steuerung (mit Code gekoppelt).
(function () {
  'use strict';
  const JC = window.JC; if (!JC) return;
  const $ = JC.$;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const settings = () => (JC.state && JC.state.settings) || {};
  let callOn = false;

  // =====================================================================
  // Einstellungen (liegen auf dem Server, damit auch der PC sie kennt)
  // =====================================================================
  const FLAGS = ['speak', 'push_disk', 'push_temp', 'push_remind', 'push_chat'];
  async function saveSettings(patch) {
    JC.state = Object.assign({}, JC.state, { settings: Object.assign({}, settings(), patch) });
    try { const s = await JC.rpc('jc_settings_set', { p_code: JC.code, p_settings: patch }); JC.state = Object.assign({}, JC.state, { settings: s }); } catch { /* bleibt lokal */ }
  }
  function syncSettings() {
    const s = settings();
    for (const k of FLAGS) { const el = $('set-' + k); if (el && document.activeElement !== el) el.checked = !!s[k]; }
    const v = $('set-voice'); if (v && document.activeElement !== v) v.value = s.voice === 'phone' ? 'phone' : 'pc';
  }
  FLAGS.forEach((k) => { const el = $('set-' + k); if (el) el.addEventListener('change', () => saveSettings({ [k]: el.checked })); });
  $('set-voice').addEventListener('change', (e) => saveSettings({ voice: e.target.value }));

  // =====================================================================
  // Sprechen: Jarvis-Stimme vom PC (wenn er an ist), sonst Handy-Stimme
  // =====================================================================
  const player = new Audio(); player.preload = 'auto';
  let unlocked = false;
  function unlockAudio() {
    if (unlocked) return; unlocked = true;
    try { player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA='; player.play().catch(() => {}); } catch { /* ignore */ }
    try { if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch { /* ignore */ }
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

  let speakChain = Promise.resolve(); let speakGen = 0; let phoneVoice = null;
  function pickVoice() {
    if (phoneVoice) return phoneVoice;
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || []; const de = vs.filter((v) => /^de/i.test(v.lang));
    const pref = [/premium/i, /enhanced|erweitert/i, /markus|yannick|daniel|conrad|stefan|reed/i, /google/i];
    for (const re of pref) { const v = de.find((x) => re.test(x.name)); if (v) return (phoneVoice = v); }
    return (phoneVoice = de[0] || null);
  }
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { phoneVoice = null; };
  function speakPhone(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve();
      const u = new SpeechSynthesisUtterance(text); u.lang = 'de-DE'; const v = pickVoice(); if (v) u.voice = v; u.rate = 1.02; u.pitch = 0.88;
      const done = () => { clearTimeout(t); resolve(); }; const t = setTimeout(done, 5000 + text.length * 90);
      u.onend = done; u.onerror = done; speechSynthesis.speak(u);
    });
  }
  const b64Blob = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'audio/wav' }); };
  function playWav(b64) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(b64Blob(b64));
      const end = () => { URL.revokeObjectURL(url); player.onended = player.onerror = null; resolve(); };
      player.onended = end; player.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio')); };
      player.src = url; player.play().catch((e) => { URL.revokeObjectURL(url); reject(e); });
    });
  }
  function chunks(text) {
    const parts = String(text).replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || [text]; const out = []; let cur = '';
    for (const p of parts.map((x) => x.trim()).filter(Boolean)) { if ((cur + ' ' + p).length > 200 && cur) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
    if (cur) out.push(cur); return out.slice(0, 6).map((x) => x.slice(0, 380));
  }
  // Jarvis-Stimme: alle Sätze beim PC bestellen, der Reihe nach abspielen. false = hat nicht geklappt (dann Handy-Stimme)
  async function speakPc(text) {
    const parts = chunks(text); let ids;
    try { ids = await Promise.all(parts.map((p) => JC.rpc('jc_tts_req', { p_code: JC.code, p_body: p }))); } catch { return false; }
    for (let i = 0; i < ids.length; i++) {
      if (speakGen !== speakNow.gen) return true;
      const deadline = Date.now() + (i === 0 ? 45000 : 30000); let audio = null;
      while (Date.now() < deadline) {
        let r = null; try { r = await JC.rpc('jc_tts_get', { p_code: JC.code, p_id: Number(ids[i]) }); } catch { /* weiter */ }
        const row = r && r[0]; if (row && row.status === 'done' && row.audio) { audio = row.audio; break; } if (row && row.status === 'fail') break;
        await sleep(600);
      }
      if (!audio) { if (i === 0) return false; await speakPhone(parts.slice(i).join(' ')); return true; }
      try { await playWav(audio); } catch { if (i === 0) return false; await speakPhone(parts.slice(i).join(' ')); return true; }
    }
    return true;
  }
  async function speakNow(text) {
    speakNow.gen = speakGen;
    if (settings().voice !== 'phone' && JC.pcOnline()) { if (await speakPc(text)) return; }
    await speakPhone(text);
  }
  function enqueueSpeak(text) { const g = speakGen; speakChain = speakChain.then(() => (g === speakGen ? speakNow(text) : null)).catch(() => {}); return speakChain; }
  function stopSpeaking() { speakGen++; try { speechSynthesis.cancel(); } catch { /* ignore */ } try { player.pause(); } catch { /* ignore */ } speakChain = Promise.resolve(); }
  JC.hooks.msg.push((m) => {
    if (m.role !== 'jarvis' || (m.via !== 'pc' && m.via !== 'cloud')) return;
    if (settings().speak || callOn) enqueueSpeak(m.body);
  });

  // =====================================================================
  // Mikrofon (Diktat) und Anruf
  // =====================================================================
  function listenOnce(ms) {
    return new Promise((resolve) => {
      if (!SR) return resolve('');
      const r = new SR(); r.lang = 'de-DE'; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
      let got = ''; let finished = false; const fin = () => { if (finished) return; finished = true; clearTimeout(t); try { r.stop(); } catch { /* ignore */ } resolve(got); };
      const t = setTimeout(fin, ms || 12000);
      r.onresult = (e) => { got = Array.from(e.results).map((x) => x[0].transcript).join(' ').trim(); fin(); };
      r.onerror = fin; r.onend = fin;
      try { r.start(); listenOnce.cur = r; } catch { fin(); }
    });
  }
  if (SR) {
    const mic = $('mic'); mic.hidden = false;
    mic.addEventListener('click', async () => {
      if (callOn) return; unlockAudio(); mic.classList.add('hot');
      const text = await listenOnce(9000); mic.classList.remove('hot');
      if (text) { $('input').value = text; $('form').requestSubmit(); }
    });
  }

  // Anruf: frei sprechen. Hören -> Jarvis antwortet -> Vorlesen -> wieder hören
  const callEl = $('call'); const orb = $('call-orb'); const octx = orb.getContext('2d');
  let callState = 'idle'; let muted = false; let held = false; let pcMode = false; let subs = true; let raf = 0; let level = 0; let callStart = 0; let clock = 0;
  const COLORS = { listen: [76, 201, 255], think: [255, 179, 64], speak: [210, 245, 255], idle: [80, 110, 130], muted: [120, 120, 130] };
  const fmtT = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  function showSub() {
    const k = held ? 'hold' : muted ? 'muted' : callState;
    const lbl = { listen: '', think: 'denkt nach …', speak: 'spricht …', muted: 'stumm', idle: '', hold: 'gehalten' }[k] || '';
    $('call-state').textContent = callStart ? [fmtT(Date.now() - callStart), lbl, pcMode ? 'PC' : '', camOn ? 'Kamera' : ''].filter(Boolean).join(' · ') : 'Verbinde …';
  }
  function setCall(st, text) {
    callState = st;
    if (text != null) $('call-text').textContent = text;
    showSub();
  }
  function drawOrb(t) {
    if (!callOn) return;
    const W = orb.width, c = W / 2, col = COLORS[muted || held ? 'muted' : callState] || COLORS.idle;
    level += ((callState === 'speak' ? 0.5 + 0.5 * Math.abs(Math.sin(t / 130) * Math.sin(t / 310)) : callState === 'think' ? 0.35 : 0.12) - level) * 0.08;
    octx.clearRect(0, 0, W, W);
    for (let i = 0; i < 3; i++) {
      const r = 78 + i * 22 + level * (8 + i * 4) * Math.sin(t / 400 + i);
      octx.beginPath(); octx.arc(c, c, r, 0, Math.PI * 2); octx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.55 - i * 0.11})`; octx.lineWidth = 3 - i * 0.5; octx.setLineDash(i % 2 ? [6, 14] : [90, 24]); octx.lineDashOffset = -t / (30 + i * 20) * (i % 2 ? -1 : 1); octx.stroke();
    }
    octx.setLineDash([]);
    const g = octx.createRadialGradient(c, c, 4, c, c, 64 + level * 16); g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},0.95)`); g.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    octx.fillStyle = g; octx.beginPath(); octx.arc(c, c, 64 + level * 16, 0, Math.PI * 2); octx.fill();
    raf = requestAnimationFrame(drawOrb);
  }
  // jeder Anruf wird gespeichert: hier auf dem Handy (Einstellungen > Gespräche) und, über die Markierungen im Chat, auf dem PC
  let callLog = null;
  const lastJarvis = () => { const l = [...document.querySelectorAll('.msg.jarvis:not(.live):not(.alert):not(.marker)')].pop(); return l ? l.firstChild.textContent : ''; };
  const mark = (txt) => { try { JC.rpc('jc_post', { p_code: JC.code, p_role: 'jarvis', p_via: 'live', p_body: '[Anruf] ' + txt, p_reply_to: null }); } catch { /* ignore */ } };
  function saveCall() {
    if (!callLog) return; callLog.end = Date.now();
    if (callLog.lines.length) { let all = []; try { all = JSON.parse(localStorage.getItem('jc-calls') || '[]'); } catch { /* ignore */ } all.unshift(callLog); try { localStorage.setItem('jc-calls', JSON.stringify(all.slice(0, 30))); } catch { /* ignore */ } }
    const sec = Math.round((callLog.end - callLog.start) / 1000); mark(`beendet (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}, ${callLog.lines.filter((x) => x.r === 'du').length} Sätze von dir)`); callLog = null;
  }
  const PC_RE = /^(computer|pc|am pc|auf dem pc|beim pc)\b[,:]?\s*/i;
  async function callLoop() {
    while (callOn) {
      if (muted || held) { setCall('listen'); await sleep(300); continue; }
      setCall('listen');
      const text = await listenOnce(14000);
      if (!callOn) break; if (muted || held || !text) continue;
      setCall('think', 'Du: ' + text);
      if (callLog) callLog.lines.push({ r: 'du', t: text, at: Date.now() });
      const pa = phoneAction(text, pcMode);
      if (pa) {
        runPhoneAction(text, pa); if (callLog) callLog.lines.push({ r: 'jarvis', t: pa.say, at: Date.now() });
        setCall('speak', pa.say); await enqueueSpeak(pa.say);
        if (pa.url) { endCall(); setTimeout(() => { location.href = pa.url; }, 200); return; }
        continue;
      }
      if (pcMode || PC_RE.test(text)) {
        if (!paired()) { const s = 'Den PC kann ich erst steuern, wenn das Handy gekoppelt ist. Das geht in den Einstellungen unter PC-Steuerung.'; setCall('speak', s); await enqueueSpeak(s); continue; }
        await sendCtl(text.replace(PC_RE, '') || text);   // die Antwort kommt als PC-Nachricht und wird vorgelesen
      } else {
        if (camOn && !JC.pcOnline()) { const s = 'Die Kamera sieht nur Jarvis am PC, und der ist gerade aus.'; setCall('speak', s); await enqueueSpeak(s); }
        await JC.send(text);                              // wartet, bis die Antwort da ist (PC, Cloud oder Handy-Wissen)
      }
      setCall('speak'); const said = lastJarvis(); if (callLog && said) callLog.lines.push({ r: 'jarvis', t: said, at: Date.now() });
      $('call-text').textContent = said; await speakChain.catch(() => {}); // Antwort wird vorgelesen
      await sleep(250);
    }
  }
  function stopListen() { try { listenOnce.cur && listenOnce.cur.stop(); } catch { /* ignore */ } }
  function startCall(brief) {
    if (callOn) return;
    if (!SR) { alert('Dieser Browser kann keine Sprache erkennen. Auf dem iPhone geht es in Safari. Aus der App auf dem Home-Bildschirm geht es manchmal nicht, dann nimm die Diktier-Taste der Tastatur.'); return; }
    unlockAudio(); callOn = true; muted = false; held = false; pcMode = false;
    ['call-mute', 'call-hold', 'call-pc'].forEach((id) => $(id).classList.remove('on'));
    callEl.hidden = false; callStart = Date.now(); clearInterval(clock); clock = setInterval(showSub, 1000); setCall('idle', ''); raf = requestAnimationFrame(drawOrb);
    $('sheet').hidden = true; callLog = { start: Date.now(), lines: [] }; mark('gestartet');
    if (brief) { callLog.lines.push({ r: 'jarvis', t: brief, at: Date.now() }); $('call-text').textContent = brief; enqueueSpeak(brief).then(() => { if (callOn) enqueueSpeak('Was kann ich für dich tun?'); }); }
    else enqueueSpeak('Ich höre, Master.');
    callLoop();
  }
  function endCall() {
    callOn = false; cancelAnimationFrame(raf); clearInterval(clock); callStart = 0; callEl.hidden = true;
    if (camOn) camStop(); pcMode = false; stopListen(); stopSpeaking(); saveCall(); renderCalls();
  }

  // ---------- Kamera im Anruf: alle 2,5 s ein kleines Bild für Jarvis am PC ----------
  let camOn = false; let camStream = null; let camTimer = 0; let camFacing = 'environment';
  async function camStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('call-text').textContent = 'Dieser Browser kann die Kamera nicht öffnen.'; return; }
    try { camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: camFacing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
    catch (e) { $('call-text').textContent = 'Kamera nicht erlaubt. In den Einstellungen des Handys bei Safari die Kamera erlauben.'; return; }
    const v = $('cam-view'); v.srcObject = camStream; v.hidden = false; v.play().catch(() => {});
    camOn = true; $('call-cam').classList.add('on'); showSub();
    if (!JC.pcOnline()) $('call-text').textContent = 'Kamera an. Sehen kann Jarvis nur, wenn dein PC an ist.';
    else enqueueSpeak('Ich sehe jetzt, was deine Kamera zeigt. Frag mich einfach.');
    const cv = document.createElement('canvas');
    const snap = async () => {
      if (!camOn) return;
      if (v.videoWidth) {
        const w = 512; const h = Math.round(512 * v.videoHeight / v.videoWidth); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(v, 0, 0, w, h);
        try { await JC.rpc('jc_cam_put', { p_code: JC.code, p_img: cv.toDataURL('image/jpeg', 0.62).split(',')[1] }); } catch { /* nächster Versuch */ }
      }
      camTimer = setTimeout(snap, 2500);
    };
    snap();
  }
  function camStop() {
    camOn = false; clearTimeout(camTimer);
    try { if (camStream) camStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    camStream = null; const v = $('cam-view'); v.hidden = true; v.srcObject = null; $('call-cam').classList.remove('on');
    JC.rpc('jc_cam_put', { p_code: JC.code, p_img: '' }).catch(() => {}); showSub();
  }

  // ---------- Handy-Aktionen: Apps öffnen, Navigation, anrufen, SMS, WhatsApp ----------
  const APPS = { youtube: 'youtube://', whatsapp: 'whatsapp://', spotify: 'spotify:', instagram: 'instagram://', tiktok: 'https://www.tiktok.com/', netflix: 'nflx://', karten: 'maps://', maps: 'maps://', 'google maps': 'comgooglemaps://', snapchat: 'snapchat://', telegram: 'tg://', facebook: 'fb://', twitch: 'twitch://', discord: 'discord://', 'app store': 'itms-apps://', musik: 'music://', 'apple music': 'music://', kalender: 'calshow://', fotos: 'photos-redirect://', mail: 'message://', google: 'https://www.google.com/', amazon: 'https://www.amazon.de/', ebay: 'https://www.ebay.de/', roblox: 'roblox://' };
  const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  function phoneAction(raw, preferPc) {
    const t = String(raw).toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
    if (/\b(pc|computer|rechner|laptop)\b/.test(t)) return null;      // PC-Befehle gehen an den PC
    if (preferPc && !/\bhandy\b/.test(t)) return null;                  // im Modus PC steuern nur, wenn "Handy" gesagt wird
    const tt = t.replace(/\s+(auf|am|an)\s+(dem|meinem)\s+handy$/, '').replace(/^(hey |ok )?jarvis,?\s*/, '');
    let m = tt.match(/^(?:bitte\s+)?(?:öffne|oeffne|starte|mach|geh auf|geh zu|zeig mir)\s+(?:mir\s+)?(?:die\s+|das\s+)?(?:app\s+)?(.{3,20}?)(?:\s+app)?(?:\s+auf)?$/);
    if (m && APPS[m[1].trim()]) return { say: 'Ich öffne ' + cap(m[1].trim()) + ', Master.', url: APPS[m[1].trim()] };
    m = tt.match(/^(?:bitte\s+)?navigier\w*\s+(?:mich\s+)?(?:nach|zu|zum|zur|in die)\s+(.{2,80})$/);
    if (m) return { say: 'Ich starte die Navigation nach ' + m[1] + '.', url: 'maps://?daddr=' + encodeURIComponent(m[1]) };
    m = tt.match(/^(?:bitte\s+)?ruf\w*\s+(?:die\s+nummer\s+)?(\+?[\d ]{6,20})\s+an$/);
    if (m) return { say: 'Ich rufe ' + m[1].trim() + ' an.', url: 'tel:' + m[1].replace(/\s/g, '') };
    m = tt.match(/^(?:bitte\s+)?(?:schreib\w*|schick\w*)\s+(?:eine\s+)?(?:sms|nachricht)\s+an\s+(\+?[\d ]{6,20})[:,]?\s+(.{1,300})$/);
    if (m) return { say: 'Ich öffne die Nachricht, du musst nur noch auf Senden tippen.', url: 'sms:' + m[1].replace(/\s/g, '') + '&body=' + encodeURIComponent(m[2]) };
    m = tt.match(/^(?:bitte\s+)?(?:schreib\w*|schick\w*)\s+(?:eine\s+)?whatsapp(?:\s+nachricht)?[:,]?\s+(.{1,300})$/);
    if (m) return { say: 'Ich öffne WhatsApp mit dem Text. Den Empfänger wählst du aus.', url: 'whatsapp://send?text=' + encodeURIComponent(m[1]) };
    m = tt.match(/^(?:bitte\s+)?(?:such\w*|google\w*)\s+(?:mal\s+)?(?:nach\s+)?(.{2,120}?)(?:\s+(?:im internet|bei google))?$/);
    if (m && /handy/.test(t)) return { say: 'Ich suche nach ' + m[1] + '.', url: 'https://www.google.com/search?q=' + encodeURIComponent(m[1]) };
    if (/\b(wecker|timer|taschenlampe|wlan|bluetooth|helligkeit|flugmodus)\b/.test(tt) && /\bhandy\b/.test(t)) return { say: 'Das darf eine Web-App auf dem Handy nicht einstellen, Master. Sag es Siri, oder ich mache es am PC.' };
    return null;
  }
  function runPhoneAction(text, pa) {
    JC.addMsg({ role: 'user', via: 'phone', body: text }); JC.addMsg({ role: 'jarvis', via: '', body: pa.say });
    if (pa.url && !callOn) setTimeout(() => { location.href = pa.url; }, 500);
  }
  // Gespräche und Gedächtnis in den Einstellungen
  function renderCalls() {
    const box = $('calls-list'); if (!box) return; let all = []; try { all = JSON.parse(localStorage.getItem('jc-calls') || '[]'); } catch { /* ignore */ }
    box.textContent = '';
    if (!all.length) { const p = document.createElement('p'); p.className = 'hint small'; p.textContent = 'Noch kein Anruf.'; box.appendChild(p); return; }
    for (const c of all.slice(0, 12)) {
      const d = document.createElement('details'); const s = document.createElement('summary'); const sec = Math.max(1, Math.round(((c.end || c.start) - c.start) / 1000));
      s.textContent = new Date(c.start).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' · ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + ' · ' + c.lines.length + ' Zeilen'; d.appendChild(s);
      for (const l of c.lines) { const p = document.createElement('p'); p.className = 'cl ' + l.r; p.textContent = (l.r === 'du' ? 'Du: ' : 'Jarvis: ') + l.t; d.appendChild(p); }
      box.appendChild(d);
    }
  }
  function renderMem() {
    const box = $('mem-list'); if (!box) return; let local = []; try { local = JSON.parse(localStorage.getItem('jc-mem') || '[]').map((x) => x.t); } catch { /* ignore */ }
    const all = [...((JC.state.snapshot && JC.state.snapshot.memory) || []), ...local]; box.textContent = '';
    if (!all.length) { const p = document.createElement('p'); p.className = 'hint small'; p.textContent = 'Noch nichts gemerkt.'; box.appendChild(p); return; }
    for (const t of all.slice(0, 20)) { const p = document.createElement('p'); p.className = 'cl'; p.textContent = '★ ' + t; box.appendChild(p); }
  }
  JC.hooks.render.push(() => { renderMem(); });
  renderCalls();

  // Eingehender Anruf (aus der Benachrichtigung): Annehmen -> Jarvis sagt, was los ist, danach kann man reden
  // Klingelton (selbst erzeugt) + Vibration, bis angenommen, abgelehnt oder 45 s vorbei
  let ringCtx = null; let ringTimer = 0;
  function ringStart() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; ringCtx = new AC();
      const beep = () => {
        if (!ringCtx) return; const t0 = ringCtx.currentTime;
        [[0, 1046], [0.16, 1318], [0.32, 1568], [0.48, 1318], [0.8, 1046], [0.96, 1318], [1.12, 1568]].forEach(([d, f]) => {
          const o = ringCtx.createOscillator(); const g = ringCtx.createGain(); o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0, t0 + d); g.gain.linearRampToValueAtTime(0.22, t0 + d + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t0 + d + 0.15);
          o.connect(g); g.connect(ringCtx.destination); o.start(t0 + d); o.stop(t0 + d + 0.17);
        });
      };
      if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
      beep(); ringTimer = setInterval(beep, 2400);
    } catch { /* ohne Ton */ }
    try { if (navigator.vibrate) navigator.vibrate([700, 500, 700, 500, 700, 500, 700]); } catch { /* ignore */ }
  }
  function ringStop() { clearInterval(ringTimer); try { if (ringCtx) ringCtx.close(); } catch { /* ignore */ } ringCtx = null; try { if (navigator.vibrate) navigator.vibrate(0); } catch { /* ignore */ } }
  async function incoming(text) {
    if (callOn || !$('incoming').hidden) return;
    await JC.refreshState().catch(() => {});
    const alerts = [...document.querySelectorAll('.msg.alert')].slice(-3).map((e) => e.firstChild.textContent.replace(/^Meldung\s*/, ''));
    const brief = text || (alerts.length ? 'Master, es gibt Neuigkeiten. ' + alerts.join(' ') : 'Hallo Master, hier ist Jarvis.');
    $('inc-text').textContent = text || (alerts.length ? alerts.join('\n\n') : '');
    $('incoming').hidden = false; ringStart();
    const close = () => { clearTimeout(auto); ringStop(); $('incoming').hidden = true; history.replaceState(null, '', location.pathname); };
    const auto = setTimeout(() => { if (!$('incoming').hidden) close(); }, 45000);
    $('inc-yes').onclick = () => { close(); startCall(brief); };
    $('inc-no').onclick = () => { close(); };
  }
  if (/[?&]call=1\b/.test(location.search)) setTimeout(() => incoming(), 1200);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.call && !callOn) incoming(); });
  // Jarvis am PC klingelt ("Ruf mich auf dem Handy an"): sichtbar, sobald die Seite offen ist
  JC.hooks.render.push(() => {
    const r = JC.state.ring_at; if (!r || localStorage.getItem('jc-ring-seen') === r) return;
    localStorage.setItem('jc-ring-seen', r);
    const age = Date.parse(JC.state.now || new Date().toISOString()) - Date.parse(r);
    if (age < 90000 && !callOn) incoming(JC.state.ring_text || '');
  });

  // Hintergrund: ruhig treibende Lichtpunkte mit feinen Linien (stoppt bei "weniger Bewegung" und im Hintergrund)
  (function bg() {
    const cv = $('bg'); if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const g = cv.getContext('2d'); let W = 0; let H = 0; let pts = []; let raf = 0;
    function size() { const d = Math.min(2, devicePixelRatio || 1); W = cv.width = innerWidth * d; H = cv.height = innerHeight * d; pts = Array.from({ length: Math.round(Math.min(46, innerWidth * innerHeight / 14000)) }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25 * d, vy: (Math.random() - 0.5) * 0.25 * d, r: (0.8 + Math.random() * 1.6) * d })); }
    function frame() {
      raf = requestAnimationFrame(frame); if (document.hidden) return;
      g.clearRect(0, 0, W, H);
      for (const p of pts) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1; }
      const lim = Math.min(W, H) * 0.2;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = Math.hypot(dx, dy); if (d < lim) { g.strokeStyle = `rgba(76,201,255,${0.1 * (1 - d / lim)})`; g.lineWidth = 1; g.beginPath(); g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[j].x, pts[j].y); g.stroke(); } }
      for (const p of pts) { g.fillStyle = 'rgba(120,215,255,0.45)'; g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill(); }
    }
    addEventListener('resize', size); size(); frame();
  })();
  $('call-btn').addEventListener('click', () => startCall());
  $('call-end').addEventListener('click', endCall);
  $('call-mute').addEventListener('click', () => { muted = !muted; $('call-mute').classList.toggle('on', muted); if (muted) stopListen(); showSub(); });
  $('call-hold').addEventListener('click', () => { held = !held; $('call-hold').classList.toggle('on', held); if (held) { stopListen(); stopSpeaking(); } showSub(); });
  $('call-cam').addEventListener('click', () => { if (camOn) camStop(); else camStart(); });
  $('call-flip').addEventListener('click', async () => { camFacing = camFacing === 'environment' ? 'user' : 'environment'; if (camOn) { camStop(); await camStart(); } });
  $('call-pc').addEventListener('click', () => {
    if (!paired()) { $('call-text').textContent = 'PC steuern geht erst nach der Kopplung: Einstellungen, PC-Steuerung.'; return; }
    pcMode = !pcMode; $('call-pc').classList.toggle('on', pcMode);
    const s = pcMode ? 'PC-Steuerung an. Was du jetzt sagst, mache ich am PC.' : 'PC-Steuerung aus. Wir reden wieder normal.';
    $('call-text').textContent = s; enqueueSpeak(s); showSub();
  });
  $('call-sub').addEventListener('click', () => { subs = !subs; $('call-sub').classList.toggle('on', subs); $('call-text').classList.toggle('off', !subs); });

  // =====================================================================
  // Benachrichtigungen (Push)
  // =====================================================================
  const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  async function enablePush() {
    const msg = $('push-msg');
    const ios = /iphone|ipad/i.test(navigator.userAgent); const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      msg.textContent = ios && !standalone ? 'Auf dem iPhone geht das nur als App: Tippe in Safari auf Teilen, dann Zum Home-Bildschirm, und öffne Jarvis von dort. Dann diesen Knopf noch einmal.' : 'Dieser Browser kann keine Benachrichtigungen. Nimm Chrome (Android) oder Safari (iPhone, als App auf dem Home-Bildschirm).'; return;
    }
    if (!JC.state.vapid_pub) { msg.textContent = 'Dein PC muss dafür einmal an und mit Jarvis verbunden sein. Dann kommt der Schlüssel automatisch.'; return; }
    msg.textContent = 'Frage nach Erlaubnis ...';
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { msg.textContent = 'Du hast Benachrichtigungen nicht erlaubt. In den Einstellungen des Handys kannst du das ändern.'; return; }
    try {
      const reg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription(); if (old) await old.unsubscribe().catch(() => {});
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(JC.state.vapid_pub) });
      await JC.rpc('jc_push_set', { p_code: JC.code, p_sub: sub.toJSON() });
      await saveSettings({ push_disk: true, push_remind: true, push_chat: true });
      msg.textContent = 'Eingeschaltet. Jarvis meldet sich jetzt auch, wenn die App zu ist (nur wenn dein PC an ist).'; await JC.refreshState();
    } catch (e) { msg.textContent = 'Das hat nicht geklappt: ' + ((e && e.message) || e); }
  }
  $('push-btn').addEventListener('click', enablePush);

  // =====================================================================
  // PC-Steuerung (gekoppelt mit Code, Schlüssel nur auf diesem Handy)
  // =====================================================================
  let mode = 'chat'; let ctl = null; // ctl = { code, token, hash }
  try { const c = JSON.parse(localStorage.getItem('jc-ctl') || 'null'); if (c && c.code === JC.code) ctl = c; } catch { /* ignore */ }
  const paired = () => !!(ctl && ctl.code === JC.code && JC.state.ctl_hash && JC.state.ctl_hash === ctl.hash && JC.state.ctl_ack === ctl.hash);
  function syncCtl() {
    if (ctl && ctl.code !== JC.code) { ctl = null; localStorage.removeItem('jc-ctl'); }
    const ok = paired(); const st = $('ctl-status');
    if (ok) st.textContent = 'Gekoppelt. Im Hauptbildschirm gibt es jetzt den Schalter Chat / Steuern.';
    else if (ctl && JC.state.ctl_window) st.textContent = 'Warte auf Bestätigung vom PC ...';
    else st.textContent = JC.state.pc_seen ? 'Nicht gekoppelt. Steuern geht nur nach der Kopplung mit einem Code vom PC.' : 'Verbinde zuerst Jarvis am PC mit dieser Nummer.';
    $('ctl-pair').hidden = ok || !JC.state.pc_seen; $('ctl-off').hidden = !ok;
    $('modebar').hidden = !ok;
    if (!ok && mode === 'ctl') setMode('chat');
  }
  function setMode(m) {
    mode = m; $('mode-chat').classList.toggle('on', m === 'chat'); $('mode-ctl').classList.toggle('on', m === 'ctl');
    $('mode-hint').textContent = m === 'ctl' ? 'Befehl für den PC, zum Beispiel: Starte Spotify. Du siehst die Schritte live.' : 'Gespräch mit Jarvis';
    $('input').placeholder = m === 'ctl' ? 'Befehl für den PC' : 'Nachricht an Jarvis';
    $('form').classList.toggle('ctl', m === 'ctl');
  }
  $('mode-chat').addEventListener('click', () => setMode('chat'));
  $('mode-ctl').addEventListener('click', () => setMode('ctl'));
  async function sendCtl(text) {
    const tell = (s) => { JC.addMsg({ role: 'jarvis', via: '', body: s }); if (callOn) return enqueueSpeak(s); return null; };
    if (!JC.pcOnline()) { await tell('Dein PC ist gerade aus. Befehle gehen nur, wenn er an ist.'); return; }
    let mid;
    try { mid = Number(await JC.rpc('jc_ctl_send', { p_code: JC.code, p_token: ctl.token, p_body: text.slice(0, 300) })); }
    catch (e) { await tell('Der Befehl wurde nicht angenommen: ' + e.message); return; }
    JC.addMsg({ id: mid, role: 'user', via: 'phone', kind: 'ctl', body: text });
    JC.typing(true);
    const done = new Promise((res) => { JC.waitFor(mid, res); });
    await Promise.race([done, sleep(125000)]); JC.typing(false);
  }
  JC.interceptSend = (text) => {
    const pa = phoneAction(text, mode === 'ctl');
    if (pa) { runPhoneAction(text, pa); return true; }
    if (mode !== 'ctl' || !paired()) return false;
    sendCtl(text);
    return true;
  };
  $('ctl-pair-btn').addEventListener('click', async () => {
    const pin = $('ctl-pin').value.replace(/\D/g, ''); const st = $('ctl-status');
    if (pin.length !== 6) { st.textContent = 'Der Code hat 6 Ziffern.'; return; }
    const arr = new Uint8Array(32); crypto.getRandomValues(arr); const token = [...arr].map((x) => x.toString(16).padStart(2, '0')).join(''); const hash = await sha(token);
    let ok = false; try { ok = await JC.rpc('jc_ctl_pair', { p_code: JC.code, p_token_hash: hash, p_proof: await sha(pin + ':' + hash) }); } catch (e) { st.textContent = 'Kopplung fehlgeschlagen: ' + e.message; return; }
    if (!ok) { st.textContent = 'Der PC hat gerade kein Kopplungsfenster offen. Sag bei Jarvis am PC: Erlaube Fernsteuerung, und gib den neuen Code ein.'; return; }
    ctl = { code: JC.code, token, hash }; localStorage.setItem('jc-ctl', JSON.stringify(ctl)); st.textContent = 'Warte auf Bestätigung vom PC ...';
    for (let i = 0; i < 14; i++) { await sleep(1500); await JC.refreshState(); if (paired()) { $('ctl-pin').value = ''; st.textContent = 'Gekoppelt.'; return; } }
    ctl = null; localStorage.removeItem('jc-ctl'); st.textContent = 'Der PC hat die Kopplung nicht angenommen. Meist war der Code falsch oder abgelaufen. Hole am PC einen neuen.'; JC.render();
  });
  $('ctl-off').addEventListener('click', async () => { try { await JC.rpc('jc_ctl_off', { p_code: JC.code }); } catch { /* egal */ } ctl = null; localStorage.removeItem('jc-ctl'); await JC.refreshState().catch(() => {}); });

  JC.hooks.render.push(() => { syncSettings(); syncCtl(); if (JC.state.push_on) $('push-btn').textContent = 'Benachrichtigungen neu einschalten'; });
  JC.render();
})();
