// 건축 통역 v1.2 (2026-11-15) — 일본어(·중국어) 해설 → 한국어 자막·음성 + 내가 말하기(한국어 → 일본어 큰 글자·소리)
// 엔진 1: OpenAI gpt-realtime-translate (WebRTC, 음성→음성)
// 엔진 2: Soniox stt-rt-v6 받아쓰기+번역 (WebSocket) → 브라우저 읽어주기(speechSynthesis)
// 진짜 API 키는 이 페이지에 없다. Supabase 함수(jp-interpreter-token)에서 몇 분짜리 임시 열쇠만 받는다.
import { BUILDINGS, allPairs, sonioxContext, talkContext } from "./glossary.js";

const FUNC = "https://trjsxwcekqmlnwfyswky.supabase.co/functions/v1/jp-interpreter-token";
const qs = new URLSearchParams(location.search);
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
// 시험용(내 맥에서만): ?tok=로컬 열쇠 대리 서버, ?src=소리 파일(마이크 대신), ?mon=1 원음 같이 듣기
const TOKEN_URL = LOCAL && qs.get("tok") ? qs.get("tok") : FUNC;
const TEST_SRC = LOCAL ? qs.get("src") : null;
const USD_KRW = 1400;
const PRICE_PER_MIN = { openai: 0.034, soniox: 0.12 / 60 };

const $ = (id) => document.getElementById(id);
const S = {
  engine: localStorage.jpiEngine || "openai",
  bld: localStorage.jpiBld || "",
  lang: localStorage.jpiLang || "ja", // ja=일본어 / zh=중국어만(통역사의 일본어는 건너뜀) / mix=일·중 모두
  want: false, // 사용자가 켜 둔 상태(끊기면 다시 연결)
  live: null, // 지금 돌아가는 엔진 객체
  t0: 0, log: [], blocks: [], cur: null,
  stream: null, streamUsers: 0, ctx: null, node: null,
  rec: null, recSid: null, recN: 0,
  retries: 0, wake: null, clockT: null, startedAt: 0,
};
window.JPI = S; // 시험 자동화용

// ---------- 화면 ----------
function msg(t, err) { const m = $("msg"); m.textContent = t || ""; m.className = err ? "err" : ""; }
function status(t, cls) { const s = $("st"); s.textContent = t; s.className = "pill " + (cls || ""); }
function now() { return (performance.now() - S.t0) / 1000; }
function L(k, x) { S.log.push(x === undefined ? { t: +now().toFixed(3), k } : { t: +now().toFixed(3), k, x }); }

function setPairs() { S.pairs = allPairs(S.bld, S.lang).sort((a, b) => b[0].length - a[0].length); } // 힌트는 긴 말 먼저
function fillBuildings() {
  const sel = $("bld");
  const trip = BUILDINGS.filter((b) => b.day).sort((a, b) => a.day.localeCompare(b.day, "en", { numeric: true }));
  const opt = (b) => `<option value="${b.id}">${b.day ? b.day + " · " : ""}${b.ko}</option>`;
  sel.innerHTML = `<option value="">건물 선택 안 함 (전체 용어집)</option>` +
    `<optgroup label="도쿄 일정 12/1~12/7">${trip.map(opt).join("")}</optgroup>` +
    `<optgroup label="그 밖의 명소">${BUILDINGS.filter((b) => !b.day).map(opt).join("")}</optgroup>`;
  sel.value = S.bld;
  sel.onchange = () => {
    S.bld = sel.value; localStorage.jpiBld = S.bld;
    const b = BUILDINGS.find((x) => x.id === S.bld);
    if (b && b.lang && b.lang !== S.lang) { setLang(b.lang); return; } // 포럼을 고르면 "중국어만"으로
    setPairs();
    if (S.want && S.engine === "soniox") restart("건물이 바뀌어 용어를 새로 넣는 중"); // Soniox 는 문맥을 연결할 때만 받음
  };
  setPairs();
}
function setLang(v) {
  S.lang = v; localStorage.jpiLang = v; setPairs(); fillLang();
  if (S.want && S.engine === "soniox") restart("듣는 말을 바꾸는 중");
}
function fillLang() {
  $("dir").textContent = { ja: "日→韓", zh: "中→韓", mix: "日中→韓" }[S.lang];
  for (const b of $("langSeg").querySelectorAll("button")) {
    b.classList.toggle("sel", b.dataset.v === S.lang);
    b.onclick = () => { if (S.lang !== b.dataset.v) setLang(b.dataset.v); };
  }
}
function fillEngine() {
  for (const b of $("engineSeg").querySelectorAll("button")) {
    b.classList.toggle("sel", b.dataset.v === S.engine);
    b.onclick = () => {
      if (S.engine === b.dataset.v) return;
      S.engine = b.dataset.v; localStorage.jpiEngine = S.engine; fillEngine();
      if (S.want) restart("엔진 바꾸는 중");
    };
  }
}

function newBlock() {
  const el = document.createElement("div");
  el.className = "blk";
  el.innerHTML = `<div class="ko"></div><div class="ja"></div><div class="hints"></div>`;
  $("subs").appendChild(el);
  const b = { el, ja: "", ko: "", jaTmp: "", koTmp: "", hints: new Set(), t: now(), closing: false };
  S.blocks.push(b); S.cur = b;
  if (S.blocks.length > 300) { S.blocks.shift().el.remove(); }
  return b;
}
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }
function render(b) {
  const box = $("subs");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  b.el.querySelector(".ko").innerHTML = esc(b.ko) + (b.koTmp ? `<span class="tmp">${esc(b.koTmp)}</span>` : "") +
    (b.skipKo ? ` <span class="skip">(통역사 부분: ${esc(b.skipKo)})</span>` : "");
  b.el.querySelector(".ja").innerHTML = esc(b.ja) + (b.jaTmp ? `<span class="tmp">${esc(b.jaTmp)}</span>` : "") +
    (b.skipJa ? ` <span class="skip">${esc(b.skipJa)}</span>` : "");
  // 용어 힌트: 일본어 원문에 용어집 단어가 나오면 "일본어 = 한국어" 딱지
  for (const [ja, ko] of S.pairs || []) {
    if (ja.length < 2 || b.hints.has(ja) || !b.ja.includes(ja)) continue;
    if ([...b.hints].some((h) => h.includes(ja))) continue;
    b.hints.add(ja);
    const s = document.createElement("span"); s.className = "hint"; s.textContent = `${ja} = ${ko}`;
    b.el.querySelector(".hints").appendChild(s);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- 입력 소리(마이크 또는 시험 파일) ----------
async function ensureCtx() {
  if (!S.ctx) {
    S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await S.ctx.audioWorklet.addModule("pcm-worklet.js");
  }
  if (S.ctx.state !== "running") await S.ctx.resume();
  return S.ctx;
}

async function getStream() {
  if (S.stream) { S.streamUsers++; return S.stream; }
  const ctx = await ensureCtx();
  let stream;
  if (TEST_SRC) {
    const buf = await ctx.decodeAudioData(await (await fetch(TEST_SRC)).arrayBuffer());
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
    if (qs.get("mon") === "1") src.connect(ctx.destination);
    S.fileSrc = src; S.fileDur = buf.duration; stream = dest.stream;
  } else {
    const dev = $("mic").value;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
    });
    listMics();
  }
  // 소리 → 16kHz 조각(Soniox 용) + 크기(소리 막대, 말 끝 감지)
  const node = new AudioWorkletNode(ctx, "pcm-worklet");
  const msrc = ctx.createMediaStreamSource(stream);
  msrc.connect(node);
  const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
  let speaking = false, quiet = 0;
  node.port.onmessage = (e) => {
    const { pcm, db } = e.data;
    $("meter").firstElementChild.style.width = Math.max(0, Math.min(100, ((db + 60) / 50) * 100)) + "%";
    if (S.live && S.live.pcm) S.live.pcm(pcm);
    if (db > -42) { if (!speaking) { speaking = true; L("v1"); } quiet = 0; }
    else if (speaking && ++quiet >= 5) { speaking = false; S.log.push({ t: +(now() - 0.5).toFixed(3), k: "v0" }); }
  };
  S.stream = stream; S.node = node; S.msrc = msrc; S.streamUsers = 1;
  return stream;
}
function releaseStream() {
  if (--S.streamUsers > 0 || !S.stream) return;
  try { S.msrc.disconnect(); S.node.disconnect(); } catch (_) {}
  S.stream.getTracks().forEach((t) => t.stop());
  if (S.fileSrc) { try { S.fileSrc.stop(); } catch (_) {} S.fileSrc = null; }
  S.stream = null; S.streamUsers = 0; $("meter").firstElementChild.style.width = "0";
}
async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const sel = $("mic"), keep = sel.value || localStorage.jpiMic || "";
    sel.innerHTML = `<option value="">기본 마이크</option>` + devs.map((d, i) => `<option value="${d.deviceId}">${d.label || "마이크 " + (i + 1)}</option>`).join("");
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  } catch (_) {}
}

// ---------- 임시 열쇠 ----------
async function getToken(body) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jpi-pass": localStorage.jpiPass || "" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error || "열쇠 받기 실패 " + r.status);
  return d;
}

// ---------- 엔진 1: OpenAI ----------
async function startOpenAI(stream) {
  const tok = await getToken({ engine: "openai", lang: "ko", noise: $("noise").value });
  const pc = new RTCPeerConnection();
  const eng = { name: "openai", pc, closed: false };
  let lastDelta = 0;
  // 중국어만: 원문에 가나가 섞이면 일본어(통역사) 구간으로 보고, 몇 초 늦게 나오는 한국어를 흐리게·소리 끔 (추정)
  const langMarks = []; // [시각, "ja"|"zh"]
  const LAG = 2.0;
  const langAt = (t) => { let v = null; for (const [tt, l] of langMarks) { if (tt <= t) v = l; else break; } return v; };
  const skipNow = () => S.lang === "zh" && langAt(now() - LAG) === "ja";
  eng.iv = setInterval(() => { const o = $("out"); if (o) o.muted = !$("ttsOn").checked || skipNow(); }, 200);
  const gapBlock = () => {
    const t = now();
    if (!S.cur || (t - lastDelta > 2.5 && (S.cur.ko || S.cur.ja))) newBlock();
    else if (S.cur.ko.length > 140 && /[.?!。]\s*$/.test(S.cur.ko)) newBlock();
    lastDelta = t;
  };
  pc.ontrack = (e) => {
    const out = $("out"); out.srcObject = e.streams[0]; out.muted = !$("ttsOn").checked; out.volume = +$("vol").value;
    out.play().catch(() => msg("화면을 한 번 눌러 주세요(소리 재생 허용)"));
    if (TEST_SRC) watchOut(e.streams[0]);
  };
  stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
  const dc = pc.createDataChannel("oai-events");
  const ready = new Promise((res, rej) => { dc.onopen = res; setTimeout(() => rej(new Error("GPT 연결 시간 초과")), 15000); });
  dc.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    if (ev.type === "session.input_transcript.delta") {
      const l = /[\u3040-\u30ff]/.test(ev.delta) ? "ja" : /[\u4e00-\u9fff]/.test(ev.delta) ? "zh" : null;
      if (l && (!langMarks.length || langMarks.at(-1)[1] !== l)) langMarks.push([now(), l]);
      gapBlock(); S.cur.ja += ev.delta; L("j", ev.delta); render(S.cur);
    } else if (ev.type === "session.output_transcript.delta") {
      gapBlock();
      if (skipNow()) { S.cur.skipKo = (S.cur.skipKo || "") + ev.delta; L("kx", ev.delta); }
      else { S.cur.ko += ev.delta; L("k", ev.delta); }
      render(S.cur);
    }
    else if (ev.type === "session.closed") { eng.closedRes && eng.closedRes(); }
    else if (ev.type === "error") { L("err", ev.error); msg("GPT 오류: " + (ev.error?.message || ev.error?.code || ""), true); }
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected"].includes(pc.connectionState) && !eng.closed) lost("GPT 연결 끊김");
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const r = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST", body: offer.sdp,
    headers: { Authorization: `Bearer ${tok.value}`, "Content-Type": "application/sdp" },
  });
  if (!r.ok) throw new Error("GPT 연결 실패 " + r.status + " " + (await r.text()).slice(0, 200));
  await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
  await ready;
  eng.stop = async () => {
    eng.closed = true; clearInterval(eng.iv);
    try {
      const done = new Promise((res) => { eng.closedRes = res; setTimeout(res, 3000); });
      dc.send(JSON.stringify({ type: "session.close" })); await done;
    } catch (_) {}
    pc.close(); $("out").srcObject = null;
  };
  return eng;
}
function watchOut(rs) { // 시험 때만: 한국어 음성이 나오기 시작·끝난 시각 기록
  const a = S.ctx.createAnalyser(); a.fftSize = 1024;
  S.ctx.createMediaStreamSource(rs).connect(a);
  const buf = new Float32Array(a.fftSize); let on = false, q = 0;
  const iv = setInterval(() => {
    if (!S.live) return clearInterval(iv);
    a.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    const db = 10 * Math.log10(s / buf.length + 1e-12);
    if (db > -50) { if (!on) { on = true; L("a1"); } q = 0; } else if (on && ++q >= 8) { on = false; S.log.push({ t: +(now() - 0.4).toFixed(3), k: "a0" }); }
  }, 50);
}

// ---------- 엔진 2: Soniox + 읽어주기 ----------
let koVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /^ko/i.test(v.lang));
  koVoice = vs.find((v) => /premium|enhanced|향상/i.test(v.name)) || vs.find((v) => /yuna|유나/i.test(v.name)) || vs[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  text = text.trim();
  if (!text || !$("ttsOn").checked || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR"; if (koVoice) u.voice = koVoice;
  const base = +$("rate").value;
  u.rate = speechSynthesis.pending || speechSynthesis.speaking ? Math.min(1.8, base + 0.25) : base; // 밀리면 조금 빠르게
  u.onstart = () => L("s1", text); u.onend = () => L("s0");
  speechSynthesis.speak(u);
}

async function openSoniox(tok, config) {
  const open = (withProto) => new Promise((res, rej) => {
    const ws = withProto
      ? new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket", ["soniox-api-key", tok.api_key])
      : new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { ws.send(JSON.stringify(withProto ? config : { ...config, api_key: tok.api_key })); res(ws); };
    ws.onerror = () => rej(new Error("Soniox 연결 실패"));
  });
  try { return await open(true); } catch (_) { return await open(false); } // 머리글 방식이 막히면 옛 방식
}

async function startSoniox(stream) {
  const tok = await getToken({ engine: "soniox" });
  const config = {
    model: "stt-rt-v6", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
    language_hints: S.lang === "ja" ? ["ja"] : S.lang === "zh" ? ["zh", "ja"] : ["ja", "zh"],
    enable_language_identification: S.lang !== "ja",
    enable_endpoint_detection: true, max_endpoint_delay_ms: 1200,
    translation: { type: "one_way", target_language: "ko" },
    context: sonioxContext(S.bld, S.lang),
  };
  const ws = await openSoniox(tok, config);
  const eng = { name: "soniox", ws, closed: false };
  let ttsBuf = "", ttsTimer = null, lastKo = "";
  const flush = () => { clearTimeout(ttsTimer); if (ttsBuf.trim()) { speak(ttsBuf); } ttsBuf = ""; };
  ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.error_code) { L("err", d); msg(`Soniox 오류 ${d.error_code}: ${d.error_message || d.error_type}`, true); return; }
    let nfJa = "", nfKo = "";
    for (const t of d.tokens || []) {
      if (t.text === "<end>") { if (S.cur) S.cur.closing = true; flush(); L("end"); continue; }
      if (t.text === "<fin>") continue;
      const tr = t.translation_status === "translation";
      // 중국어만: 일본어(통역사)로 말한 부분과 그 번역은 건너뛴다
      const skip = S.lang === "zh" && (tr ? t.source_language === "ja" : t.language === "ja");
      if (!t.is_final) { if (skip) continue; if (tr) nfKo += t.text; else nfJa += t.text; continue; }
      if (skip) {
        if (!tr) { if (!S.cur || S.cur.closing) newBlock(); S.cur.skipJa = (S.cur.skipJa || "") + t.text; }
        L(tr ? "kx" : "jx", t.text); continue;
      }
      if (tr) {
        if (!S.cur) newBlock();
        S.cur.ko += t.text; L("k", t.text);
        ttsBuf += t.text;
        clearTimeout(ttsTimer);
        if (/[.?!。？！]\s*$/.test(ttsBuf)) flush(); else ttsTimer = setTimeout(flush, 1200);
      } else {
        if (!S.cur || S.cur.closing) newBlock();
        S.cur.ja += t.text; L("j", t.text);
      }
    }
    if (!S.cur) newBlock();
    S.cur.jaTmp = nfJa; S.cur.koTmp = nfKo;
    if (nfKo && nfKo !== lastKo) { L("kn", nfKo); lastKo = nfKo; }
    render(S.cur);
    if (d.finished) { eng.closedRes && eng.closedRes(); }
  };
  ws.onclose = (e) => { if (!eng.closed) lost("Soniox 연결 끊김 " + (e.code || "")); };
  eng.pcm = (buf) => { if (ws.readyState === 1) ws.send(buf); };
  eng.stop = async () => {
    eng.closed = true; flush();
    try {
      const done = new Promise((res) => { eng.closedRes = res; setTimeout(res, 3000); });
      ws.send(""); await done;
    } catch (_) {}
    try { ws.close(); } catch (_) {}
  };
  return eng;
}

// ---------- 시작·정지·다시 연결 ----------
async function startEngine() {
  status("연결 중…");
  const stream = await getStream();
  try {
    S.live = S.engine === "openai" ? await startOpenAI(stream) : await startSoniox(stream);
  } catch (e) { releaseStream(); throw e; }
  S.retries = 0;
  status(S.engine === "openai" ? "GPT 통역 중" : "Soniox 통역 중", "on");
  L("go", S.engine);
  if (S.fileSrc && !S.fileStarted) { // 시험 파일: 엔진 준비가 끝난 뒤 재생 시작 → 시각 0
    S.fileStarted = true; S.t0 = performance.now(); S.log = [{ t: 0, k: "play", x: S.engine }];
    S.fileSrc.onended = () => { L("eof"); setTimeout(() => { if (S.want) stopAll().then(() => (window.__done = true)); }, 10000); };
    S.fileSrc.start();
  }
}
async function startAll() {
  if (!localStorage.jpiPass && TOKEN_URL === FUNC) { $("setBox").open = true; $("pass").focus(); msg("설정에서 암호를 먼저 넣어 주세요", true); return; }
  // 아이폰: 버튼을 누른 이 순간에 소리 재생을 미리 허용받는다
  if (navigator.audioSession) { try { navigator.audioSession.type = "play-and-record"; } catch (_) {} }
  if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  $("out").play().catch(() => {});
  await ensureCtx();
  S.want = true; S.t0 = performance.now(); S.startedAt = Date.now(); S.log = [];
  setBtn();
  wakeOn(); clockOn();
  try { await startEngine(); msg(""); }
  catch (e) { msg(String(e.message || e), true); status("오류", "err"); S.want = false; setBtn(); clockOff(); }
}
async function stopEngine() {
  const e = S.live; S.live = null;
  if (e) { try { await e.stop(); } catch (_) {} releaseStream(); }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
async function stopAll() {
  S.want = false; setBtn(); await stopEngine(); L("stop");
  status("대기"); clockOff(); wakeOff();
}
async function restart(why) {
  msg(why); await stopEngine();
  if (!S.want) return;
  try { await startEngine(); msg(""); } catch (e) { lost(String(e.message || e)); }
}
async function lost(why) {
  if (!S.want) return;
  L("lost", why);
  await stopEngine();
  if (S.retries >= 6) { msg(why + " — 다시 연결 실패. ▶ 를 다시 눌러 주세요", true); status("끊김", "err"); S.want = false; setBtn(); clockOff(); return; }
  const wait = Math.min(8000, 1000 * 2 ** S.retries++);
  status("다시 연결 중…", "err"); msg(why + ` — ${Math.round(wait / 1000)}초 뒤 다시 연결`);
  setTimeout(async () => { if (!S.want || S.live) return; try { await startEngine(); msg("다시 연결됨"); } catch (e) { lost(String(e.message || e)); } }, wait);
}
function setBtn() { const b = $("big"); b.textContent = S.want ? "■ 통역 멈춤" : "▶ 통역 시작"; b.classList.toggle("stop", S.want); }

// 화면 꺼짐 막기(아이폰은 화면이 꺼지면 마이크도 멈춤)
async function wakeOn() { try { S.wake = await navigator.wakeLock?.request("screen"); } catch (_) {} }
function wakeOff() { try { S.wake?.release(); } catch (_) {} S.wake = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (S.want || S.rec) wakeOn();
  if (S.want && S.live?.name === "soniox" && S.live.ws.readyState > 1) lost("화면이 꺼졌다 켜져 다시 연결");
  if (S.ctx && S.ctx.state !== "running") S.ctx.resume().catch(() => {});
});

function clockOn() {
  clearInterval(S.clockT);
  S.clockT = setInterval(() => {
    const sec = (Date.now() - S.startedAt) / 1000;
    const won = Math.round((sec / 60) * PRICE_PER_MIN[S.engine] * USD_KRW);
    $("clock").textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")} · 약 ${won.toLocaleString()}원`;
  }, 1000);
}
function clockOff() { clearInterval(S.clockT); }


// ---------- 내가 말하기 (한국어 → 일본어: 흰 화면에 큰 일본어 + 소리) ----------
// 듣기 통역이 켜져 있으면 잠시 멈추고, 닫으면 다시 켠다. 같은 엔진(GPT/Soniox)을 쓴다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let jaVoice = null;
function pickJaVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
  jaVoice = vs.find((v) => /premium|enhanced|향상/i.test(v.name)) || vs.find((v) => /kyoko|o-ren/i.test(v.name)) || vs[0] || null;
}
if ("speechSynthesis" in window) { pickJaVoice(); speechSynthesis.addEventListener?.("voiceschanged", pickJaVoice); }
function speakJa(text) {
  text = (text || "").trim();
  if (!text || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP"; if (jaVoice) u.voice = jaVoice; u.rate = 1.0;
  speechSynthesis.speak(u);
}
const T = { on: false, eng: null, ko: "", ja: "", koTmp: "", jaTmp: "", spoken: 0, lastOut: 0, finished: false, resume: false };
function talkRender() {
  $("talkKo").textContent = T.ko + T.koTmp;
  $("talkJa").innerHTML = esc(T.ja) + (T.jaTmp ? `<span class="tmp">${esc(T.jaTmp)}</span>` : "");
  $("talkJa").scrollTop = $("talkJa").scrollHeight;
}
function talkState(t) { $("talkSt").textContent = t; }

async function talkOpenAI(stream) {
  const tok = await getToken({ engine: "openai", lang: "ja", noise: "near_field" });
  const pc = new RTCPeerConnection();
  const eng = { name: "openai-talk", closed: false };
  pc.ontrack = (e) => { const o = $("out"); o.srcObject = e.streams[0]; o.muted = false; o.volume = 1; o.play().catch(() => {}); };
  stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
  const dc = pc.createDataChannel("oai-events");
  const ready = new Promise((res, rej) => { dc.onopen = res; setTimeout(() => rej(new Error("GPT 연결 시간 초과")), 15000); });
  dc.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    if (ev.type === "session.input_transcript.delta") { T.ko += ev.delta; talkRender(); }
    else if (ev.type === "session.output_transcript.delta") { T.ja += ev.delta; T.lastOut = performance.now(); talkRender(); }
    else if (ev.type === "session.closed") { eng.closedRes && eng.closedRes(); }
    else if (ev.type === "error") talkState("GPT 오류: " + (ev.error?.message || ev.error?.code || ""));
  };
  pc.onconnectionstatechange = () => { if (["failed", "disconnected"].includes(pc.connectionState) && !eng.closed) talkState("연결 끊김 — 닫고 다시 해 주세요"); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const r = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${tok.value}`, "Content-Type": "application/sdp" },
  });
  if (!r.ok) throw new Error("GPT 연결 실패 " + r.status);
  await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
  await ready;
  eng.finish = async () => { // 번역이 다 나올 때까지: 1.5초 조용하면 끝(최대 8초), 소리 끝나게 1초 더
    const t0 = performance.now();
    while (performance.now() - t0 < 8000 && performance.now() - Math.max(T.lastOut, t0) < 1500) await sleep(200);
    await sleep(1000);
  };
  eng.stop = async () => {
    eng.closed = true;
    try { const done = new Promise((res) => { eng.closedRes = res; setTimeout(res, 2000); }); dc.send(JSON.stringify({ type: "session.close" })); await done; } catch (_) {}
    pc.close(); $("out").srcObject = null;
  };
  return eng;
}

async function talkSoniox(stream) {
  const tok = await getToken({ engine: "soniox" });
  const ws = await openSoniox(tok, {
    model: "stt-rt-v6", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
    language_hints: ["ko"], enable_language_identification: true,
    enable_endpoint_detection: true, max_endpoint_delay_ms: 1000,
    translation: { type: "one_way", target_language: "ja" },
    context: talkContext(S.bld),
  });
  const eng = { name: "soniox-talk", ws, closed: false };
  let finRes = null;
  const speakNew = () => { const part = T.ja.slice(T.spoken); T.spoken = T.ja.length; speakJa(part); };
  ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.error_code) { talkState(`Soniox 오류 ${d.error_code}: ${d.error_message || d.error_type}`); return; }
    let nfKo = "", nfJa = "";
    for (const t of d.tokens || []) {
      if (t.text === "<end>") { speakNew(); continue; }
      if (t.text === "<fin>") { finRes && finRes(); continue; }
      const tr = t.translation_status === "translation";
      if (tr ? t.source_language === "ja" : t.language === "ja") continue; // 스피커에서 나온 일본어가 다시 들어온 것은 버림
      if (!t.is_final) { if (tr) nfJa += t.text; else nfKo += t.text; continue; }
      if (tr) T.ja += t.text; else T.ko += t.text;
    }
    T.koTmp = nfKo; T.jaTmp = nfJa; talkRender();
    if (d.finished) eng.closedRes && eng.closedRes();
  };
  ws.onclose = () => { if (!eng.closed) talkState("연결 끊김 — 닫고 다시 해 주세요"); };
  eng.pcm = (buf) => { if (ws.readyState === 1) ws.send(buf); };
  eng.finish = async () => { // 남은 말을 바로 확정 → 번역이 따라올 시간 조금 → 아직 안 읽은 일본어 읽기
    const fin = new Promise((r) => { finRes = r; });
    try { ws.send(JSON.stringify({ type: "finalize" })); } catch (_) {}
    await Promise.race([fin, sleep(4000)]);
    await sleep(700);
    T.koTmp = ""; T.jaTmp = ""; talkRender(); speakNew();
  };
  eng.stop = async () => {
    eng.closed = true;
    try { const done = new Promise((res) => { eng.closedRes = res; setTimeout(res, 2000); }); ws.send(""); await done; } catch (_) {}
    try { ws.close(); } catch (_) {}
  };
  return eng;
}

async function talkEngineOff() { // 듣기용 stopEngine 과 달리 읽어주기를 끊지 않는다
  const e = S.live; S.live = null;
  if (e) { try { await e.stop(); } catch (_) {} releaseStream(); }
}
async function talkRound() {
  Object.assign(T, { ko: "", ja: "", koTmp: "", jaTmp: "", spoken: 0, lastOut: 0, finished: false });
  talkRender(); talkState("연결 중…");
  $("talkMain").textContent = "■ 다 말했어요"; $("talkMain").classList.remove("done");
  try {
    const stream = await getStream();
    try { T.eng = S.engine === "openai" ? await talkOpenAI(stream) : await talkSoniox(stream); }
    catch (e) { releaseStream(); throw e; }
    S.live = T.eng;
    talkState("듣는 중… 한국어로 말하세요");
  } catch (e) { T.eng = null; talkState("오류: " + (e.message || e)); $("talkMain").textContent = "🗣 다시 말하기"; $("talkMain").classList.add("done"); T.finished = true; }
}
async function talkFinish() {
  if (!T.eng || T.finished) return;
  T.finished = true; talkState("번역 마무리 중…");
  try { await T.eng.finish(); } catch (_) {}
  await talkEngineOff(); T.eng = null;
  talkState(T.ja ? "끝 — 🔊 다시 듣기로 또 들려줄 수 있어요" : "알아들은 말이 없어요 — 다시 말해 주세요");
  $("talkMain").textContent = "🗣 다시 말하기"; $("talkMain").classList.add("done");
  if (T.ko || T.ja) { // 자막 목록에도 남김(자막 저장에 들어감)
    const b = newBlock(); b.el.classList.add("me"); b.ko = "🗣 나: " + T.ko; b.ja = T.ja; render(b);
  }
}
async function talkOpen() {
  if (T.on) return;
  if (!localStorage.jpiPass && TOKEN_URL === FUNC) { $("setBox").open = true; $("pass").focus(); msg("설정에서 암호를 먼저 넣어 주세요", true); return; }
  if (navigator.audioSession) { try { navigator.audioSession.type = "play-and-record"; } catch (_) {} }
  if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  $("out").play().catch(() => {});
  await ensureCtx();
  T.resume = S.want;
  if (S.want) { S.want = false; setBtn(); await stopEngine(); clockOff(); status("대기"); }
  T.on = true; $("talk").classList.add("on"); wakeOn();
  await talkRound();
}
async function talkClose() {
  T.finished = true;
  if (T.eng) { await talkEngineOff(); T.eng = null; }
  T.on = false; $("talk").classList.remove("on");
  if (T.resume) { T.resume = false; startAll(); } else if (!S.rec) wakeOff();
}

// ---------- 원음 녹음 (IndexedDB 에 5초마다 저장 → 새로고침해도 남음) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("jpi", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("chunks", { keyPath: ["sid", "i"] });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbPut(row) { const db = await idb(); db.transaction("chunks", "readwrite").objectStore("chunks").put(row); }
async function idbAll() {
  const db = await idb();
  return new Promise((res) => { const q = db.transaction("chunks").objectStore("chunks").getAll(); q.onsuccess = () => res(q.result); });
}
async function recToggle() {
  if (S.rec) {
    S.rec.stop(); S.rec = null; releaseStream();
    $("recBtn").textContent = "● 원음 녹음 켜기"; $("recBtn").classList.remove("rec");
    if (!S.want) wakeOff();
    return;
  }
  try {
    await ensureCtx();
    const stream = await getStream();
    const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined);
    S.recSid = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ""); S.recN = 0; S.recType = rec.mimeType || type;
    localStorage.jpiLastRec = S.recSid; localStorage.jpiLastRecType = S.recType;
    rec.ondataavailable = (e) => { if (e.data.size) idbPut({ sid: S.recSid, i: S.recN++, blob: e.data, type: S.recType }); };
    rec.start(5000); S.rec = rec; wakeOn();
    $("recBtn").textContent = "■ 녹음 중 (누르면 끝)"; $("recBtn").classList.add("rec");
  } catch (e) { msg("녹음 시작 실패: " + (e.message || e), true); }
}
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function saveRec() {
  const sid = S.recSid || localStorage.jpiLastRec;
  if (!sid) return msg("저장할 녹음이 없습니다");
  if (S.rec) S.rec.requestData();
  await new Promise((r) => setTimeout(r, 400));
  const rows = (await idbAll()).filter((r) => r.sid === sid).sort((a, b) => a.i - b.i);
  if (!rows.length) return msg("녹음 조각이 없습니다");
  const type = rows[0].type || localStorage.jpiLastRecType || "audio/mp4";
  const ext = type.includes("webm") ? "webm" : "m4a";
  await shareFile(new Blob(rows.map((r) => r.blob), { type }), `건축해설_${sid}.${ext}`);
}
async function saveTxt() {
  const lines = S.blocks.filter((b) => b.ja || b.ko).map((b) => `[${Math.floor(b.t / 60)}:${String(Math.floor(b.t % 60)).padStart(2, "0")}]\n${b.ja}\n→ ${b.ko}\n`);
  if (!lines.length) return msg("저장할 자막이 없습니다");
  const head = `건축 통역 자막 ${new Date().toLocaleString("ko-KR")} · 엔진 ${S.engine} · 듣는 말 ${S.lang} · 건물 ${S.bld || "-"}\n\n`;
  await shareFile(new Blob([head + lines.join("\n")], { type: "text/plain" }), `자막_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.txt`);
}
async function saveLog() {
  const data = { engine: S.engine, bld: S.bld, lang: S.lang, ua: navigator.userAgent, src: TEST_SRC, log: S.log };
  await shareFile(new Blob([JSON.stringify(data)], { type: "application/json" }), `측정_${S.engine}_${Date.now()}.json`);
}

// ---------- 묶기 ----------
fillEngine(); fillBuildings(); fillLang(); listMics();
$("pass").value = localStorage.jpiPass || "";
$("pass").onchange = () => { localStorage.jpiPass = $("pass").value.trim(); msg("암호 저장됨"); };
$("mic").onchange = () => { localStorage.jpiMic = $("mic").value; if (S.want) restart("마이크 바꾸는 중"); };
$("noise").value = localStorage.jpiNoise || "far_field";
$("noise").onchange = () => { localStorage.jpiNoise = $("noise").value; if (S.want && S.engine === "openai") restart("설정 바꾸는 중"); };
$("ttsOn").onchange = () => { $("out").muted = !$("ttsOn").checked; if (!$("ttsOn").checked && "speechSynthesis" in window) speechSynthesis.cancel(); };
$("vol").oninput = () => { $("out").volume = +$("vol").value; };
$("big").onclick = () => (S.want ? stopAll() : startAll());
$("recBtn").onclick = recToggle;
$("saveBtn").onclick = saveRec;
$("txtBtn").onclick = saveTxt;
$("logBtn").onclick = saveLog;
$("talkBtn").onclick = talkOpen;
$("talkMain").onclick = () => (T.finished ? talkRound() : talkFinish());
$("talkSay").onclick = () => { if ("speechSynthesis" in window) speechSynthesis.cancel(); speakJa(T.ja); };
$("talkClose").onclick = talkClose;
$("clrBtn").onclick = () => { $("subs").innerHTML = ""; S.blocks = []; S.cur = null; };
if (qs.get("engine")) { S.engine = qs.get("engine"); fillEngine(); }
if (qs.get("lang")) setLang(qs.get("lang"));
