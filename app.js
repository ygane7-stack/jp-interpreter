// 건축 통역 v1.5 (2026-11-17) — 일본어(·중국어) 해설 → 한국어 자막·음성 + 대화(내 말 한→日 / 상대 말 日→한) + 자주 쓰는 말(인터넷 없이)
// v1.5: 둘 다(Soniox 자막 + GPT 목소리) 켜고 끄기 · 📷 간판·상품 사진 번역(셔터 없이 계속) · 📝 강연 정리본 · 자막 휴대폰에 보관
// 엔진 1: OpenAI gpt-realtime-translate (WebRTC, 음성→음성)
// 엔진 2: Soniox stt-rt-v6 받아쓰기+번역 (WebSocket) → 브라우저 읽어주기(speechSynthesis)
// 진짜 API 키는 이 페이지에 없다. Supabase 함수(jp-interpreter-token)에서 몇 분짜리 임시 열쇠만 받는다.
import { BUILDINGS, allPairs, sonioxContext, talkContext } from "./glossary.js";
import { PHRASES } from "./phrases.js";

const FUNC = "https://trjsxwcekqmlnwfyswky.supabase.co/functions/v1/jp-interpreter-token";
const qs = new URLSearchParams(location.search);
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
// 시험용(내 맥에서만): ?tok=로컬 열쇠 대리 서버, ?src=소리 파일(마이크 대신), ?mon=1 원음 같이 듣기
const TOKEN_URL = LOCAL && qs.get("tok") ? qs.get("tok") : FUNC;
const TEST_SRC = LOCAL ? qs.get("src") : null;
const USD_KRW = 1400;
const PRICE_PER_MIN = { openai: 0.034, soniox: 0.18 / 60 }; // Soniox 는 번역 포함 요금으로 넉넉히

const $ = (id) => document.getElementById(id);
const S = {
  engine: localStorage.jpiEngine || "soniox", // v1.5: 기본은 Soniox(용어집·싼 값)
  dual: localStorage.jpiDual === "1", // Soniox 자막 + GPT 목소리 같이
  focus: localStorage.jpiFocus !== "0", // 🎯 고른 말만 통역(우리끼리 한국어 대화 등은 무시). 기본 켬
  gptLog: [], // 둘 다 켰을 때 GPT 한국어 [시각, 글]
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
  const d = new Date(), today = `${d.getMonth() + 1}/${d.getDate()}`; // 여행 날이면 그날 건물을 맨 위에
  const tod = trip.filter((b) => b.day === today);
  sel.innerHTML = `<option value="">건물 선택 안 함 (전체 용어집)</option>` +
    (tod.length ? `<optgroup label="★ 오늘 ${today}">${tod.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="도쿄 일정 12/1~12/7">${trip.filter((b) => b.day !== today).map(opt).join("")}</optgroup>` +
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
  setTimeout(focusRefresh, 0);
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
  dualRefresh();
}
// ---------- 둘 다: Soniox 자막(용어집·원문) + GPT 목소리(자연스러움) ----------
function dualRefresh() {
  const b = $("dualBtn"); if (!b) return;
  b.style.display = S.engine === "soniox" ? "" : "none";
  b.classList.toggle("on", S.dual);
  b.innerHTML = S.dual ? "🎧 GPT 목소리 <b>켬</b> · 둘 다 사용 중 <span class='small'>(누르면 끔)</span>" : "🎧 GPT 목소리 더하기 <span class='small'>(중요한 강연 때 켜기)</span>";
  $("gptLine").style.display = S.dual && S.engine === "soniox" ? "" : "none";
}
async function dualToggle() {
  S.dual = !S.dual; localStorage.jpiDual = S.dual ? "1" : "0"; dualRefresh();
  const e = S.live;
  if (!e || e.name !== "soniox") return; // 통역이 꺼져 있으면 다음 시작 때 적용
  if (S.dual) attachGpt(e); else detachGpt(e);
}
async function attachGpt(e, tries = 0) {
  if (!S.dual || S.live !== e || e.gpt) return;
  msg("GPT 목소리 연결 중…");
  try {
    e.gpt = await startOpenAI(S.stream, { audioOnly: true, onLost: () => {
      if (S.live !== e || !e.gpt) return;
      e.gpt.stop().catch(() => {}); e.gpt = null; gptLine("(GPT 목소리 끊김 — 다시 연결 중, 자막·읽어주기는 계속)");
      if (tries < 4) setTimeout(() => attachGpt(e, tries + 1), 3000);
    } });
    if (S.live !== e || !S.dual) { e.gpt.stop().catch(() => {}); e.gpt = null; return; }
    if ("speechSynthesis" in window) speechSynthesis.cancel(); // 이제 목소리는 GPT 가 맡음
    msg(""); status("둘 다 통역 중", "on");
  } catch (err) {
    e.gpt = null;
    msg("GPT 목소리 연결 못 함 — Soniox 자막·읽어주기로 계속합니다 (" + String(err.message || err).slice(0, 80) + ")", true);
  }
}
async function detachGpt(e) {
  const g = e.gpt; e.gpt = null;
  if (g) { try { await g.stop(); } catch (_) {} }
  if (S.live === e) status("Soniox 통역 중", "on");
}
// ---------- 🎯 고른 말만 통역 ----------
const LANG_KO = { ja: "일본어", zh: "중국어", mix: "일본어·중국어" };
function allowedLangs() { return S.lang === "ja" ? ["ja"] : S.lang === "zh" ? ["zh", "ja"] : ["ja", "zh"]; } // zh 의 ja(통역사)는 따로 흐리게 처리
function focusRefresh() {
  const b = $("focusBtn"); if (!b) return;
  b.classList.toggle("on", S.focus);
  b.innerHTML = S.focus ? `🎯 <b>${LANG_KO[S.lang]}만</b> 통역 중 · 한국어 등 다른 말은 무시 <span class='small'>(누르면 모두 통역)</span>`
    : `🎯 다른 말도 모두 통역 중 <span class='small'>(누르면 ${LANG_KO[S.lang]}만)</span>`;
}
function focusToggle() { S.focus = !S.focus; localStorage.jpiFocus = S.focus ? "1" : "0"; focusRefresh(); msg(S.focus ? `${LANG_KO[S.lang]}만 통역합니다 — 우리끼리 하는 한국어는 자막·소리에 안 나와요` : "모든 말을 통역합니다"); }
function gptLine(t) { const el = $("gptLine"); if (el) el.textContent = "🎧 GPT: " + t; }
let gptCur = null;
function gptAdd(delta) {
  const t = now();
  if (!gptCur || t - gptCur[0] > 2.5 || gptCur[1].length > 200) { gptCur = [t, "", Date.now()]; S.gptLog.push(gptCur); }
  gptCur[1] += delta; gptCur.last = t;
  gptLine(S.gptLog.slice(-2).map((x) => x[1]).join(" ").slice(-140));
  saveSubsSoon();
}

function newBlock() {
  const el = document.createElement("div");
  el.className = "blk";
  el.innerHTML = `<div class="ko"></div><div class="ja"></div><div class="hints"></div>`;
  $("subs").appendChild(el);
  const b = { el, ja: "", ko: "", jaTmp: "", koTmp: "", hints: new Set(), t: now(), at: Date.now(), closing: false };
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
  dimUpdate(); saveSubsSoon();
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
  let speaking = false, quiet = 0, zero = 0;
  // 아이폰이 읽어주기 중에 마이크를 막아 버리는 일이 있어(WebKit 버그) 완전한 무음이 4초 이어지면 마이크를 다시 켠다
  if (!TEST_SRC) stream.getAudioTracks().forEach((t) => { t.onmute = () => { L("mute"); if (S.want && S.live && !T.on) restart("마이크가 멈춰 다시 켜는 중"); }; });
  node.port.onmessage = (e) => {
    const { pcm, db } = e.data;
    if (S.peek) S.peek(db);
    if (!TEST_SRC && db < -150) { if (++zero === 40 && S.want && S.live && !T.on) restart("마이크 소리가 끊겨 다시 켜는 중"); } else zero = 0;
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
async function startOpenAI(stream, opt = {}) {
  const tok = await getToken({ engine: "openai", lang: "ko", noise: $("noise").value });
  const pc = new RTCPeerConnection();
  const eng = { name: "openai", pc, closed: false };
  let lastDelta = 0;
  // 중국어만: 원문에 가나가 섞이면 일본어(통역사) 구간으로 보고, 몇 초 늦게 나오는 한국어를 흐리게·소리 끔 (추정)
  const langMarks = []; // [시각, "ja"|"zh"]
  const LAG = 2.0;
  const langAt = (t) => { let v = null; for (const [tt, l] of langMarks) { if (tt <= t) v = l; else break; } return v; };
  // 🎯 고른 말만: 원문에 한글이 나오면 한국어 구간으로 보고 그 뒤 몇 초의 번역을 버린다(추정 — GPT 는 언어를 알려 주지 않음)
  const skipWhy = () => { const l = langAt(now() - LAG); if (S.lang === "zh" && l === "ja") return "ja"; if (S.focus && l === "ko") return "ko"; return null; };
  const skipNow = () => !!skipWhy();
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
      const l = /[\uac00-\ud7a3]/.test(ev.delta) ? "ko" : /[\u3040-\u30ff]/.test(ev.delta) ? "ja" : /[\u4e00-\u9fff]/.test(ev.delta) ? "zh" : null;
      if (l && (!langMarks.length || langMarks.at(-1)[1] !== l)) langMarks.push([now(), l]);
      if (opt.audioOnly) return; // 둘 다: 원문 자막은 Soniox 것을 쓴다
      if (S.focus && l === "ko") { L("jx", ev.delta); return; } // 우리끼리 한국어: 자막에 안 씀
      gapBlock(); S.cur.ja += ev.delta; L("j", ev.delta); render(S.cur);
    } else if (ev.type === "session.output_transcript.delta" && opt.audioOnly) {
      if (!skipNow()) gptAdd(ev.delta); L("g", ev.delta);
    } else if (ev.type === "session.output_transcript.delta") {
      gapBlock();
      const why = skipWhy();
      if (why === "ko") { L("kx", ev.delta); return; }
      if (why) { S.cur.skipKo = (S.cur.skipKo || "") + ev.delta; L("kx", ev.delta); }
      else { S.cur.ko += ev.delta; L("k", ev.delta); }
      render(S.cur);
    }
    else if (ev.type === "session.closed") { eng.closedRes && eng.closedRes(); }
    else if (ev.type === "error") { L("err", ev.error); msg("GPT 오류: " + (ev.error?.message || ev.error?.code || ""), true); }
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected"].includes(pc.connectionState) && !eng.closed) (opt.onLost ? opt.onLost() : lost("GPT 연결 끊김"));
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
  if (S.live?.gpt) return; // 둘 다: 목소리는 GPT 가 냄
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
    enable_language_identification: true, // 🎯 고른 말만 통역하려면 말마다 언어를 알아야 함
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
      const tl = tr ? t.source_language : t.language;
      if (S.focus && tl && !allowedLangs().includes(tl)) { if (t.is_final) L(tr ? "kx" : "jx", t.text); continue; } // 🎯 다른 말(우리끼리 한국어 등)은 버림
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
  if (S.engine === "soniox" && S.dual) attachGpt(S.live);
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
  S.want = true; S.t0 = performance.now(); S.startedAt = Date.now(); S.log = []; S.billSec = 0; S.gptSec = 0;
  setBtn();
  wakeOn(); clockOn();
  try { await startEngine(); msg(""); }
  catch (e) { msg(String(e.message || e), true); status("오류", "err"); S.want = false; setBtn(); clockOff(); }
}
async function stopEngine() {
  const e = S.live; S.live = null;
  if (e?.gpt) { const g = e.gpt; e.gpt = null; try { await g.stop(); } catch (_) {} }
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
  if (!navigator.onLine) { S.waitOnline = true; status("인터넷 기다림", "err"); msg("인터넷이 끊겼어요 — 다시 연결되면 저절로 이어집니다 (📋 자주 쓰는 말은 지금도 됨)", true); return; }
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
    if (S.live) S.billSec = (S.billSec || 0) + 1, S.live.gpt && (S.gptSec = (S.gptSec || 0) + 1);
    const usd = (S.billSec || 0) / 60 * PRICE_PER_MIN[S.engine] + (S.gptSec || 0) / 60 * PRICE_PER_MIN.openai;
    const won = Math.round(usd * USD_KRW);
    $("clock").textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")} · 약 ${won.toLocaleString()}원`;
  }, 1000);
}
function clockOff() { clearInterval(S.clockT); }


// ---------- 대화: 내 말(한국어 → 일본어) / 상대 말(일본어 → 한국어) ----------
// 화면 위쪽(상대 쪽, 뒤집힘)은 일본어, 아래쪽(내 쪽)은 한국어. 듣기 통역이 켜져 있으면 잠시 멈추고, 닫으면 다시 켠다.
// 소리: 아이폰은 마이크가 켜져 있으면 소리를 수화기(귀대는 곳)로 작게 보내는 일이 있어서,
//       번역이 다 나오면 마이크를 끄고(오디오 모드 playback) 휴대폰이 읽는다 → 에어팟을 빼면 휴대폰 스피커로 나온다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setAS(type) { if (navigator.audioSession) { try { navigator.audioSession.type = type; } catch (_) {} } }
let jaVoice = null;
function pickJaVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
  jaVoice = vs.find((v) => /premium|enhanced|향상/i.test(v.name)) || vs.find((v) => /kyoko|o-ren/i.test(v.name)) || vs[0] || null;
}
if ("speechSynthesis" in window) { pickJaVoice(); speechSynthesis.addEventListener?.("voiceschanged", pickJaVoice); }
function unlockAudio() { // 아이폰: 손가락으로 누른 그 순간에 소리 재생을 미리 허용받는다
  if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  $("out").play().catch(() => {});
  if (S.ctx && S.ctx.state !== "running") S.ctx.resume().catch(() => {});
}
function say(text, lang) { // 다 읽으면 끝나는 약속(Promise). 아이폰이 끝 알림을 안 줄 때를 대비해 시간 제한
  text = (text || "").trim();
  return new Promise((res) => {
    if (!text || !("speechSynthesis" in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "ja" ? "ja-JP" : "ko-KR";
    const v = lang === "ja" ? jaVoice : koVoice; if (v) u.voice = v;
    u.rate = lang === "ja" ? 0.95 : +$("rate").value;
    let done = false; const end = () => { if (!done) { done = true; res(); } };
    u.onend = end; u.onerror = end;
    setTimeout(end, 2500 + text.length * 220);
    speechSynthesis.speak(u);
  });
}
const keyReady = () => !!localStorage.jpiPass || TOKEN_URL !== FUNC;

const T = { on: false, eng: null, who: "me", src: "", dst: "", srcTmp: "", dstTmp: "", lastIn: 0, lastOut: 0, t0: 0, finished: true, resume: false, gen: 0, watch: null };
if (LOCAL) window.JPT = { T, render: () => talkRender(), state: (a, b) => talkState(a, b) }; // 맥 시험용
const tmpSpan = (s) => (s ? `<span class="tmp">${esc(s)}</span>` : "");
function talkRender() {
  const me = T.who === "me";
  $("talk").classList.toggle("them", !me);
  $("themCap").textContent = me ? "🇰🇷→🇯🇵 韓国語からの翻訳" : "👂 あなたの日本語（聞き取り）";
  $("meCap").textContent = me ? "🗣 내 말 (한국어)" : "👂 상대 말 → 한국어 번역";
  $("talkJa").innerHTML = me ? esc(T.dst) + tmpSpan(T.dstTmp) : esc(T.src) + tmpSpan(T.srcTmp);
  $("talkKo").innerHTML = me ? esc(T.src) + tmpSpan(T.srcTmp) : esc(T.dst) + tmpSpan(T.dstTmp);
  $("talkJa").scrollTop = $("talkJa").scrollHeight; $("talkKo").scrollTop = $("talkKo").scrollHeight;
  const act = !!T.eng && !T.finished;
  $("meBtn").innerHTML = act && me ? "■ 다 말했어요" : "🗣 내 말<br><span>한국어 → 日本語</span>";
  $("meBtn").classList.toggle("act", act && me);
  $("themBtn").innerHTML = act && !me ? "■ 상대 말 끝" : "👂 상대 말<br><span>日本語 → 한국어</span>";
  $("themBtn").classList.toggle("act", act && !me);
  $("themBig").textContent = act && !me ? "■ 話し終わったら押してください" : "🎤 日本語で話す（押してから話してください）";
  $("themBig").classList.toggle("act", act && !me);
}
function talkState(ko, ja) { $("talkSt").textContent = ko; if (ja !== undefined) $("themSt").textContent = ja; }

async function talkEngOpenAI(stream, src, dst) {
  const tok = await getToken({ engine: "openai", lang: dst, noise: "near_field" });
  const pc = new RTCPeerConnection();
  const eng = { name: "openai-talk", closed: false };
  // GPT 의 실시간 목소리는 끈다(마이크가 켜진 동안은 수화기로 작게 나갈 수 있음). 다 끝난 뒤 휴대폰이 읽는다.
  pc.ontrack = (e) => { const o = $("out"); o.srcObject = e.streams[0]; o.muted = true; };
  stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
  const dc = pc.createDataChannel("oai-events");
  const ready = new Promise((res, rej) => { dc.onopen = res; setTimeout(() => rej(new Error("GPT 연결 시간 초과")), 15000); });
  dc.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    if (ev.type === "session.input_transcript.delta") { T.src += ev.delta; T.lastIn = performance.now(); talkRender(); }
    else if (ev.type === "session.output_transcript.delta") { T.dst += ev.delta; T.lastOut = performance.now(); talkRender(); }
    else if (ev.type === "session.closed") { eng.closedRes && eng.closedRes(); }
    else if (ev.type === "error") talkState("GPT 오류: " + (ev.error?.message || ev.error?.code || ""));
  };
  pc.onconnectionstatechange = () => { if (["failed", "disconnected"].includes(pc.connectionState) && !eng.closed) talkState("연결 끊김 — 버튼을 다시 눌러 주세요"); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const r = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${tok.value}`, "Content-Type": "application/sdp" },
  });
  if (!r.ok) throw new Error("GPT 연결 실패 " + r.status);
  await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
  await ready;
  eng.finish = async () => { // 번역이 다 나올 때까지: 1.5초 동안 새 번역이 없으면 끝(최대 8초)
    const t0 = performance.now();
    while (performance.now() - t0 < 8000 && performance.now() - Math.max(T.lastOut, t0) < 1500) await sleep(200);
  };
  eng.stop = async () => {
    eng.closed = true;
    try { const done = new Promise((res) => { eng.closedRes = res; setTimeout(res, 2000); }); dc.send(JSON.stringify({ type: "session.close" })); await done; } catch (_) {}
    pc.close(); $("out").srcObject = null; $("out").muted = !$("ttsOn").checked;
  };
  return eng;
}

async function talkEngSoniox(stream, src, dst) {
  const tok = await getToken({ engine: "soniox" });
  const ws = await openSoniox(tok, {
    model: "stt-rt-v6", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
    language_hints: [src], enable_language_identification: true,
    enable_endpoint_detection: true, max_endpoint_delay_ms: 1000,
    translation: { type: "one_way", target_language: dst },
    context: src === "ko" ? talkContext(S.bld) : sonioxContext(S.bld, "ja"),
  });
  const eng = { name: "soniox-talk", ws, closed: false };
  let finRes = null, lastTmp = "";
  ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.error_code) { talkState(`Soniox 오류 ${d.error_code}: ${d.error_message || d.error_type}`); return; }
    let nfS = "", nfD = "";
    for (const t of d.tokens || []) {
      if (t.text === "<end>") continue;
      if (t.text === "<fin>") { finRes && finRes(); continue; }
      const tr = t.translation_status === "translation";
      if ((tr ? t.source_language : t.language) === dst) continue; // 휴대폰에서 나온 소리가 되들어온 것 등은 버림
      if (!t.is_final) { if (tr) nfD += t.text; else nfS += t.text; continue; }
      if (tr) { T.dst += t.text; T.lastOut = performance.now(); } else { T.src += t.text; T.lastIn = performance.now(); }
    }
    if (nfS !== lastTmp) { lastTmp = nfS; if (nfS) T.lastIn = performance.now(); }
    T.srcTmp = nfS; T.dstTmp = nfD; talkRender();
    if (d.finished) eng.closedRes && eng.closedRes();
  };
  ws.onclose = () => { if (!eng.closed) talkState("연결 끊김 — 버튼을 다시 눌러 주세요"); };
  eng.pcm = (buf) => { if (ws.readyState === 1) ws.send(buf); };
  eng.finish = async () => { // 남은 말을 바로 확정 → 번역이 따라올 시간 조금
    const fin = new Promise((r) => { finRes = r; });
    try { ws.send(JSON.stringify({ type: "finalize" })); } catch (_) {}
    await Promise.race([fin, sleep(4000)]);
    await sleep(600);
  };
  eng.stop = async () => {
    eng.closed = true;
    try { const done = new Promise((res) => { eng.closedRes = res; setTimeout(res, 2000); }); ws.send(""); await done; } catch (_) {}
    try { ws.close(); } catch (_) {}
  };
  return eng;
}

async function talkStopEng() {
  clearInterval(T.watch);
  const e = T.eng; T.eng = null;
  if (S.live === e) S.live = null;
  if (e) { try { await e.stop(); } catch (_) {} releaseStream(); }
}
// 말 끝 자동 감지: 알아들은 말이 있고 1.8초(상대는 2.2초) 동안 새 말이 없으면 끝. 25초 동안 아무 말이 없으면 듣기를 멈춤(요금 아끼기)
function talkWatch() {
  clearInterval(T.watch);
  T.watch = setInterval(() => {
    if (!T.eng || T.finished) return clearInterval(T.watch);
    const heard = (T.src + T.srcTmp).trim();
    const idle = performance.now() - Math.max(T.lastIn, T.t0);
    if (heard && $("autoEnd").checked && idle > (T.who === "me" ? 1800 : 2200)) talkFinish();
    else if (!heard && idle > 25000) { talkStopEng().then(() => { T.finished = true; talkRender(); talkState("아무 말이 없어 듣기를 멈췄어요", "下のボタンを押して話してください"); }); }
  }, 250);
}
async function talkTurn(who) {
  if (!keyReady()) { talkState("설정에서 암호를 먼저 넣어 주세요 (📋 자주 쓰는 말은 암호 없이 됩니다)"); return; }
  if (!navigator.onLine) { talkState("인터넷이 없어요 — 📋 자주 쓰는 말을 쓰세요", "インターネットに接続できません"); return; }
  const gen = ++T.gen;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  await talkStopEng();
  Object.assign(T, { who, src: "", dst: "", srcTmp: "", dstTmp: "", lastIn: 0, lastOut: 0, t0: performance.now(), finished: false });
  talkRender(); talkState("연결 중…", "接続中…");
  const [src, dst] = who === "me" ? ["ko", "ja"] : ["ja", "ko"];
  setAS("play-and-record");
  try {
    const stream = await getStream();
    let eng;
    try { eng = S.engine === "openai" ? await talkEngOpenAI(stream, src, dst) : await talkEngSoniox(stream, src, dst); }
    catch (e) { releaseStream(); throw e; }
    if (gen !== T.gen || !T.on) { try { await eng.stop(); } catch (_) {} releaseStream(); return; }
    T.eng = eng; S.live = eng; T.t0 = performance.now();
    talkState(who === "me" ? "듣는 중… 한국어로 말하세요" : "상대 말 듣는 중… (일본어)",
      who === "me" ? "韓国語で話しています。少々お待ちください" : "どうぞ、日本語で話してください");
    talkRender(); talkWatch();
  } catch (e) {
    if (gen !== T.gen) return;
    T.finished = true; T.eng = null; talkRender();
    talkState("오류: " + (e.message || e), "エラーが発生しました");
  }
}
function logTurn() { // 자막 목록에도 남김(자막 저장에 들어감)
  const b = newBlock(); b.el.classList.add(T.who === "me" ? "me" : "them");
  if (T.who === "me") { b.ko = "🗣 나: " + T.src.trim(); b.ja = T.dst.trim(); }
  else { b.ko = "👂 상대: " + T.dst.trim(); b.ja = T.src.trim(); }
  render(b);
}
async function talkFinish() {
  if (!T.eng || T.finished) return;
  T.finished = true; clearInterval(T.watch);
  const gen = T.gen, who = T.who;
  talkState("번역 마무리 중…", "翻訳しています…"); talkRender();
  try { await T.eng.finish(); } catch (_) {}
  await talkStopEng();
  if (gen !== T.gen) return;
  T.srcTmp = ""; T.dstTmp = ""; talkRender();
  if (!T.dst.trim()) {
    talkState(T.src.trim() ? "번역이 안 나왔어요 — 다시 해 주세요" : "알아들은 말이 없어요 — 다시 해 주세요", "すみません、もう一度お願いします");
    return;
  }
  logTurn();
  setAS("playback"); // 마이크를 끈 뒤에 읽는다 → 에어팟을 빼 두면 휴대폰 스피커로 나감
  if ($("talkVoice").checked) {
    talkState(who === "me" ? "🔊 일본어로 읽는 중…" : "🔊 한국어로 읽는 중…", who === "me" ? "🔊" : "翻訳を読み上げています…");
    await say(T.dst, who === "me" ? "ja" : "ko");
  }
  if (gen !== T.gen || !T.on) return;
  if (who === "me" && $("autoTurn").checked) { await sleep(250); if (gen === T.gen && T.on) talkTurn("them"); return; }
  talkState(who === "me" ? "끝 — 🔊 다시 듣기 · 👂 상대 말" : "끝 — 🗣 내 말로 대답하세요", who === "me" ? "下のボタンを押して日本語で話してください" : "ありがとうございます");
}
async function talkOpen(start = true) {
  unlockAudio();
  if (!T.on) {
    T.on = true; $("talk").classList.add("on"); wakeOn();
    Object.assign(T, { who: "me", src: "", dst: "", srcTmp: "", dstTmp: "", finished: true });
    talkRender(); talkState("🗣 내 말 / 👂 상대 말을 누르세요", "下のボタンを押して日本語で話してください");
    T.resume = S.want;
    if (S.want) { S.want = false; setBtn(); await stopEngine(); clockOff(); status("대기"); }
  }
  if (start) await talkTurn("me");
}
async function talkClose() {
  T.gen++; T.finished = true;
  await talkStopEng();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  T.on = false; $("talk").classList.remove("on");
  if (T.resume) { T.resume = false; startAll(); } else if (!S.rec) wakeOff();
}
function talkBtn(who) { // 같은 차례가 듣는 중이면 "끝", 아니면 그 차례 시작
  unlockAudio();
  if (T.eng && !T.finished && T.who === who) talkFinish(); else talkTurn(who);
}
async function talkReplay() {
  if (!T.dst.trim()) return;
  unlockAudio(); if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (T.eng && !T.finished) return; // 듣는 중에는 읽지 않음(소리가 다시 들어감)
  setAS("playback"); await say(T.dst, T.who === "me" ? "ja" : "ko");
}

// ---------- 자주 쓰는 말 (미리 번역, 인터넷 없이도 됨) + 내가 저장한 말 ----------
function myPhrases() { try { return JSON.parse(localStorage.jpiMy || "[]"); } catch (_) { return []; } }
function saveMine() {
  if (T.who !== "me" || !T.finished || !T.src.trim() || !T.dst.trim()) return talkState("내 말을 번역한 뒤에 ⭐ 저장할 수 있어요");
  const my = myPhrases().filter((p) => p[1] !== T.dst.trim());
  my.unshift([T.src.trim(), T.dst.trim()]);
  localStorage.jpiMy = JSON.stringify(my.slice(0, 60));
  talkState("⭐ 자주 쓰는 말 맨 위에 저장했어요 (인터넷 없이도 다시 쓸 수 있어요)");
}
function fillPhrases() {
  const my = myPhrases();
  const item = (ko, ja, i) => `<button class="ph" data-ko="${esc(ko).replace(/"/g, "&quot;")}" data-ja="${esc(ja).replace(/"/g, "&quot;")}">` +
    `<b>${esc(ko)}</b><small>${esc(ja)}</small>${i !== undefined ? `<i data-del="${i}">✕</i>` : ""}</button>`;
  let h = "";
  if (my.length) h += `<h3>⭐ 내가 저장한 말</h3>` + my.map(([ko, ja], i) => item(ko, ja, i)).join("");
  for (const g of PHRASES) h += `<h3>${g.cat}</h3>` + g.items.map(([ko, ja]) => item(ko, ja)).join("");
  $("phList").innerHTML = h;
}
function openPhrases() { unlockAudio(); fillPhrases(); $("phr").classList.add("on"); }
function closePhrases() { $("phr").classList.remove("on"); }
async function showPhrase(ko, ja) {
  closePhrases();
  if (!T.on) talkOpen(false); // 손가락 누른 순간에 바로(소리 허용)
  T.gen++; const gen = T.gen;
  await talkStopEng();
  Object.assign(T, { who: "me", src: ko, dst: ja, srcTmp: "", dstTmp: "", finished: true });
  talkRender(); logTurn();
  setAS("playback"); talkState("🔊 일본어로 읽는 중…", "🔊");
  await say(ja, "ja");
  if (gen !== T.gen || !T.on) return;
  if ($("autoTurn").checked && keyReady() && navigator.onLine) { await sleep(250); if (gen === T.gen && T.on) return talkTurn("them"); }
  talkState("끝 — 🔊 다시 듣기 · 👂 상대 말", "下のボタンを押して日本語で話してください");
}
$("phList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); const my = myPhrases(); my.splice(+del.dataset.del, 1); localStorage.jpiMy = JSON.stringify(my); fillPhrases(); return; }
  const b = e.target.closest(".ph"); if (!b) return;
  unlockAudio(); showPhrase(b.dataset.ko, b.dataset.ja);
});

// ---------- 절전 화면 (검은 화면 + 최신 자막만 흐리게: 아이폰 13 Pro 는 검은 화면에서 전기를 덜 씀) ----------
function dimOn() { $("dim").classList.add("on"); dimUpdate(); }
function dimUpdate() {
  if (!$("dim").classList.contains("on")) return;
  const b = S.cur; $("dimTxt").textContent = b ? (b.ko + (b.koTmp || "")).slice(-120) : "통역을 기다리는 중";
}

// ---------- 출발 전 점검 ----------
async function preflight() {
  const box = $("chk"), rows = [];
  const add = (ok, t) => { rows.push(`${ok === true ? "✅" : ok === false ? "❌" : "⚠️"} ${t}`); box.innerHTML = rows.join("<br>"); };
  box.textContent = "점검 중…"; unlockAudio();
  add(navigator.onLine, navigator.onLine ? "인터넷 연결됨" : "인터넷 없음 (📋 자주 쓰는 말만 됩니다)");
  try {
    const d = await (await fetch(FUNC + "?r=ping")).json(); const h = d.has || {};
    add(h.SONIOX_API_KEY ? true : null, "Soniox 엔진 열쇠 " + (h.SONIOX_API_KEY ? "준비됨" : "아직 없음"));
    add(h.OPENAI_API_KEY ? true : null, "GPT 엔진 열쇠 " + (h.OPENAI_API_KEY ? "준비됨" : "아직 없음"));
    const eng = h.SONIOX_API_KEY ? "soniox" : h.OPENAI_API_KEY ? "openai" : null;
    if (eng && h.JPI_PASSCODE) {
      try { await getToken({ engine: eng, lang: "ko", noise: "far_field" }); add(true, "내 암호 맞음 — 통역 시작 가능"); }
      catch (e) { add(false, "암호 확인 실패: " + (e.message || e)); }
      if (!h[S.engine === "openai" ? "OPENAI_API_KEY" : "SONIOX_API_KEY"]) add(false, `지금 고른 엔진(${S.engine === "openai" ? "GPT" : "Soniox"})은 열쇠가 없어요 — 위에서 다른 엔진을 고르세요`);
      if (!h.OPENAI_API_KEY) add(false, "OpenAI 열쇠 없음 — 🎧 GPT 목소리(둘 다)·📷 간판·상품·📝 정리본은 안 됩니다 (Soniox 통역·대화는 됨)");
    } else add(null, "열쇠가 들어오면 암호도 여기서 확인합니다");
  } catch (_) { add(false, "통역 서버에 닿지 않음"); }
  try {
    setAS("play-and-record");
    let max = -200; S.peek = (db) => { if (db > max) max = db; };
    const st = await getStream();
    add(null, "🎤 3초 동안 아무 말이나 해 보세요…");
    await sleep(3000);
    const label = st.getAudioTracks()[0]?.label || "알 수 없음";
    S.peek = null; releaseStream(); rows.pop();
    add(max > -45, `마이크: ${label} · 소리 크기 ${Math.round(max)}dB ${max > -45 ? "(잘 들림)" : "(너무 작음 — 마이크 가까이)"}`);
  } catch (e) { S.peek = null; add(false, "마이크 사용 불가: " + (e.message || e) + " — 설정 > Safari > 마이크 허용"); }
  pickVoice(); pickJaVoice();
  add(!!koVoice, "한국어 목소리: " + (koVoice?.name || "없음"));
  add(!!jaVoice, "일본어 목소리: " + (jaVoice?.name || "없음 — 설정 > 손쉬운 사용 > 읽기 및 말하기 > 음성에서 일본어 받기"));
  add("wakeLock" in navigator ? true : null, "wakeLock" in navigator ? "화면 꺼짐 막기 됨" : "화면 꺼짐 막기 안 됨 — 설정 > 디스플레이 > 자동 잠금 '안 함'");
  try { const est = await navigator.storage?.estimate?.(); if (est) add(true, `저장 공간 여유 약 ${Math.round((est.quota - est.usage) / 1e6).toLocaleString()}MB (원음 녹음 1시간 ≈ 29MB)`); } catch (_) {}
  const sa = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  add(sa ? true : null, sa ? "홈 화면 앱으로 실행 중" : "홈 화면에 추가하면 주소창 없이 크게 쓸 수 있어요 (공유 → 홈 화면에 추가)");
  setAS("playback");
  add(null, "🔊 소리 시험: 한국어와 일본어가 차례로 들리면 정상");
  await say("한국어 소리 시험입니다.", "ko"); await say("日本語の音声テストです。", "ja");
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
  const lines = subsText().map((l) => l + "\n");
  if (!lines.length) return msg("저장할 자막이 없습니다");
  const head = `건축 통역 자막 ${new Date().toLocaleString("ko-KR")} · 엔진 ${S.engine} · 듣는 말 ${S.lang} · 건물 ${S.bld || "-"}\n\n`;
  await shareFile(new Blob([head + lines.join("\n")], { type: "text/plain" }), `자막_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.txt`);
}
async function saveLog() {
  const data = { engine: S.engine, bld: S.bld, lang: S.lang, ua: navigator.userAgent, src: TEST_SRC, log: S.log };
  await shareFile(new Blob([JSON.stringify(data)], { type: "application/json" }), `측정_${S.engine}_${Date.now()}.json`);
}


// ---------- 자막 보관(새로고침·앱 재시작에도 남게) ----------
let subsT = null;
function saveSubsSoon() { clearTimeout(subsT); subsT = setTimeout(saveSubs, 3000); }
function saveSubs() {
  try {
    const blocks = S.blocks.filter((b) => b.ja || b.ko).slice(-600).map((b) => ({ at: b.at, ja: b.ja, ko: b.ko }));
    localStorage.jpiSubs = JSON.stringify({ blocks, gpt: S.gptLog.slice(-600).map((g) => [g[2], g[1]]), bld: S.bld });
  } catch (_) {}
}
function loadSubs() {
  try {
    const d = JSON.parse(localStorage.jpiSubs || "null"); if (!d) return;
    for (const x of d.blocks || []) { const b = newBlock(); Object.assign(b, { at: x.at, ja: x.ja, ko: x.ko, closing: true }); render(b); }
    S.gptLog = (d.gpt || []).map(([at, t]) => { const g = [0, t, at]; return g; });
    S.cur = null;
  } catch (_) {}
}
const hm = (at) => { const d = new Date(at || Date.now()); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// ---------- 📝 강연 정리본: 두 엔진 자막 + 용어집 → AI 가 다듬은 한국어 (OpenAI 키 필요) ----------
function subsText() { // 시간 순서로 A(Soniox 원문+번역)와 B(GPT 번역)를 섞는다
  const rows = [];
  for (const b of S.blocks) if (b.ja || b.ko) rows.push([b.at, `[${hm(b.at)}] 원문: ${b.ja}\n  A: ${b.ko}`]);
  for (const g of S.gptLog) if (g[1]) rows.push([g[2], `[${hm(g[2])}] B: ${g[1]}`]);
  return rows.sort((a, b) => a[0] - b[0]).map((r) => r[1]);
}
async function summarize() {
  const lines = subsText();
  if (!lines.length) return msg("정리할 자막이 없습니다 — 통역을 켜고 들은 뒤 누르세요", true);
  if (!keyReady()) return msg("설정에서 암호를 먼저 넣어 주세요", true);
  if (!navigator.onLine) return msg("정리본은 인터넷이 필요해요 — 자막은 휴대폰에 남아 있으니 나중에 누르세요", true);
  const parts = []; let cur = "";
  for (const l of lines) { if (cur.length + l.length > 18000 && cur) { parts.push(cur); cur = ""; } cur += l + "\n"; }
  if (cur) parts.push(cur);
  const terms = allPairs(S.bld, S.lang).map(([ja, ko]) => `${ja} = ${ko}`).join("\n");
  const bld = BUILDINGS.find((b) => b.id === S.bld)?.ko || S.bld || "";
  const box = $("sumTxt"); $("sum").classList.add("on"); $("sumSave").disabled = true;
  const out = []; const t0 = Date.now();
  try {
    for (let i = 0; i < parts.length; i++) {
      box.textContent = `정리하는 중… ${i + 1}/${parts.length} 부분 (한 부분에 30초~1분)`;
      const d = await getToken({ kind: "summary", step: "part", text: parts[i], bld, terms });
      out.push(d.md);
    }
    box.textContent = "전체 요약 만드는 중…";
    const fin = await getToken({ kind: "summary", step: "final", text: out.join("\n\n"), bld, terms });
    const head = `# 강연 정리본 — ${bld || "건축 해설"}\n${new Date().toLocaleString("ko-KR")} · 자막 ${lines.length}줄 · ${Math.round((Date.now() - t0) / 1000)}초\n\n`;
    const md = head + fin.md + "\n\n---\n\n## 부분별 다듬은 통역문\n\n" + out.map((m, i) => `### 부분 ${i + 1}\n${m}`).join("\n\n");
    localStorage.jpiLastSum = md; showSum(md);
  } catch (e) { box.textContent = "정리 실패: " + (e.message || e) + "\n\n(자막은 그대로 남아 있어요. '자막 저장'으로 파일을 보관해 두면 귀국 후 다시 정리할 수 있어요.)"; }
}
function showSum(md) {
  $("sum").classList.add("on"); $("sumSave").disabled = false;
  $("sumTxt").innerHTML = esc(md).replace(/^#{1,3} (.*)$/gm, "<b class='h'>$1</b>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}
async function saveSum() {
  const md = localStorage.jpiLastSum; if (!md) return;
  await shareFile(new Blob([md], { type: "text/markdown" }), `정리본_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.md`);
}

// ---------- 📷 간판·상품: 셔터 없이 비추기만 하면 2~3초마다 번역 (OpenAI 키 필요) ----------
// 휴대폰이 멈춰 있고(흔들림 없음) 장면이 바뀌었을 때만 사진을 보낸다 → 같은 간판을 계속 보내지 않아 값이 덜 든다.
const C = { on: false, stream: null, paused: false, lastSig: null, n: 0, won: 0, idleAt: 0, gen: 0 };
const VPRICE = { in: 0.25, out: 2.0 }; // gpt-5-mini 백만 토큰당 달러(공식 문서 기준, 바뀔 수 있음)
function camSig() { // 화면을 16×12 흑백으로 줄인 지문
  const v = $("camV"), c = camSig.c || (camSig.c = document.createElement("canvas"));
  c.width = 16; c.height = 12; const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(v, 0, 0, 16, 12); const d = g.getImageData(0, 0, 16, 12).data; const o = new Uint8Array(192);
  for (let i = 0; i < 192; i++) o[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return o;
}
const sigDiff = (a, b) => { if (!a || !b) return 999; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function camShot(max) {
  const v = $("camV"), k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}
function camCost(u) { if (!u) return; C.won += ((u.prompt_tokens || 0) * VPRICE.in + (u.completion_tokens || 0) * VPRICE.out) / 1e6 * USD_KRW; }
function camShow(d, detail) {
  const kindIco = { sign: "🪧", product: "🛍", price: "💴", menu: "🍽", other: "·" };
  $("camNote").textContent = d.note || "";
  $("camNote").classList.toggle("big", !!detail);
  $("camList").innerHTML = (d.items || []).map((x) => `<div class="ci"><span class="k">${kindIco[x.kind] || "·"}</span><div><div class="cko">${esc(String(x.ko || ""))}</div><div class="cja">${esc(String(x.ja || ""))}</div></div></div>`).join("");
  $("camSt").textContent = `${detail ? "자세히" : "실시간"} · 사진 ${C.n}장 · 약 ${Math.round(C.won).toLocaleString()}원`;
}
async function camOpen() {
  if (!keyReady()) return msg("설정에서 암호를 먼저 넣어 주세요", true);
  if (S.want) await stopAll(); // 마이크 통역과 동시에 쓰지 않음(아이폰 자원)
  $("cam").classList.add("on"); $("camSt").textContent = "카메라 켜는 중…";
  try {
    C.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    $("camV").srcObject = C.stream; await $("camV").play();
  } catch (e) { $("camSt").textContent = "카메라를 못 켰어요: " + (e.message || e); return; }
  C.on = true; C.paused = false; C.lastSig = null; C.idleAt = Date.now(); camPauseBtn(); wakeOn();
  camLoop(++C.gen);
}
function camPauseBtn() { $("camPause").textContent = C.paused ? "▶ 다시 실시간" : "⏸ 멈추고 자세히"; }
async function camLoop(gen) {
  while (C.on && gen === C.gen) {
    if (C.paused || document.hidden || !$("camV").videoWidth) { await sleep(300); continue; }
    if (Date.now() - C.idleAt > 120000) { C.paused = true; camPauseBtn(); $("camSt").textContent = "2분 지나 쉬는 중(값 아끼기) — ▶ 를 누르면 계속"; continue; }
    if (!navigator.onLine) { $("camSt").textContent = "인터넷 기다리는 중…"; await sleep(1000); continue; }
    const a = camSig(); await sleep(250); if (!C.on || gen !== C.gen) break; const b = camSig();
    if (sigDiff(a, b) > 9) { $("camHint").textContent = "휴대폰을 잠깐 멈춰 주세요"; continue; } // 흔들리는 중
    if (sigDiff(b, C.lastSig) < 7) { $("camHint").textContent = "✓ 번역됨 — 다른 곳을 비추면 새로 번역"; await sleep(300); continue; } // 같은 장면
    $("camHint").textContent = "번역 중…";
    const t0 = performance.now();
    try {
      const d = await getToken({ kind: "vision", mode: "scan", image: camShot(1024) });
      if (!C.on || gen !== C.gen || C.paused) continue;
      C.n++; camCost(d.usage); C.lastSig = b; camShow(d);
      $("camHint").textContent = `✓ ${((performance.now() - t0) / 1000).toFixed(1)}초`;
    } catch (e) { $("camHint").textContent = "번역 실패: " + String(e.message || e).slice(0, 80); await sleep(2000); }
  }
}
async function camDetail() {
  C.idleAt = Date.now();
  if (C.paused) { C.paused = false; C.lastSig = null; $("camV").play(); camPauseBtn(); return; } // 다시 실시간
  C.paused = true; camPauseBtn();
  const img = camShot(1600); $("camV").pause(); // 화면을 그 장면에 멈춤
  $("camHint").textContent = "자세히 보는 중… (5~10초)";
  try { const d = await getToken({ kind: "vision", mode: "detail", image: img }); C.n++; camCost(d.usage); camShow(d, true); $("camHint").textContent = "▶ 를 누르면 다시 실시간"; }
  catch (e) { $("camHint").textContent = "실패: " + String(e.message || e).slice(0, 80); }
}
function camClose() {
  C.on = false; C.gen++; $("cam").classList.remove("on");
  if (C.stream) C.stream.getTracks().forEach((t) => t.stop()); C.stream = null; $("camV").srcObject = null;
  if (!S.want && !S.rec) wakeOff();
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
$("talkBtn").onclick = () => talkOpen(true);
$("meBtn").onclick = () => talkBtn("me");
$("themBtn").onclick = () => talkBtn("them");
$("themBig").onclick = () => talkBtn("them");
$("talkSay").onclick = talkReplay;
$("talkStar").onclick = saveMine;
$("talkPh").onclick = openPhrases;
$("talkClose").onclick = talkClose;
$("phrBtn").onclick = openPhrases;
$("phClose").onclick = closePhrases;
$("dimBtn").onclick = dimOn;
$("dim").onclick = () => $("dim").classList.remove("on");
$("chkBtn").onclick = preflight;
// 상대 쪽 일본어 뒤집기(기본 켬). 내가 직접 읽거나 휴대폰을 건네줄 때는 끈다. 선택은 이 휴대폰에 기억.
function setFlip(on) {
  $("talk").classList.toggle("flip", on);
  $("talkFlip").textContent = on ? "↕ 뒤집기 끄기" : "↕ 상대 쪽으로 뒤집기";
  try { localStorage.setItem("jpi_flip", on ? "1" : "0"); } catch {}
}
let flip0 = true; try { flip0 = localStorage.getItem("jpi_flip") !== "0"; } catch {}
setFlip(flip0);
$("talkFlip").onclick = () => setFlip(!$("talk").classList.contains("flip"));
// 켜고 끄는 설정은 이 휴대폰에 기억
for (const id of ["ttsOn", "autoEnd", "autoTurn", "talkVoice"]) {
  const el = $(id), k = "jpiChk_" + id;
  if (localStorage[k]) el.checked = localStorage[k] === "1";
  el.addEventListener("change", () => { localStorage[k] = el.checked ? "1" : "0"; });
}
$("out").muted = !$("ttsOn").checked;
for (const id of ["rate", "vol"]) { const el = $(id); if (localStorage["jpiR_" + id]) el.value = localStorage["jpiR_" + id]; el.addEventListener("input", () => { localStorage["jpiR_" + id] = el.value; }); }
// 자막 글자 크기
function setFs(v) { document.documentElement.style.setProperty("--fs", v + "px"); localStorage.jpiFs = v; }
$("fs").value = localStorage.jpiFs || 21; setFs($("fs").value);
$("fs").oninput = () => setFs($("fs").value);
// 인터넷 끊김·다시 연결
window.addEventListener("offline", () => { if (!S.want) msg("인터넷 끊김 — 📋 자주 쓰는 말은 인터넷 없이도 됩니다", true); });
window.addEventListener("online", async () => {
  msg("인터넷 다시 연결됨");
  if (S.waitOnline && S.want && !S.live) { S.waitOnline = false; S.retries = 0; try { await startEngine(); msg("다시 연결됨"); } catch (e) { lost(String(e.message || e)); } }
});
// 첫 손가락 터치에 소리 허용(아이폰)
document.addEventListener("touchend", () => unlockAudio(), { once: true });
// 홈 화면 앱 + 인터넷 없을 때도 화면이 열리게(파일을 휴대폰에 보관)
if ("serviceWorker" in navigator && !qs.get("nosw")) navigator.serviceWorker.register("sw.js").catch(() => {});
$("clrBtn").onclick = () => { $("subs").innerHTML = ""; S.blocks = []; S.cur = null; S.gptLog = []; gptCur = null; try { delete localStorage.jpiSubs; } catch (_) {} };
$("dualBtn").onclick = dualToggle;
$("sumBtn").onclick = () => (localStorage.jpiLastSum && !S.blocks.length ? showSum(localStorage.jpiLastSum) : summarize());
$("sumRun").onclick = summarize;
$("sumSave").onclick = saveSum;
$("sumClose").onclick = () => $("sum").classList.remove("on");
$("camBtn").onclick = camOpen;
$("camPause").onclick = camDetail;
$("camClose").onclick = camClose;
$("cam").addEventListener("touchstart", () => (C.idleAt = Date.now()), { passive: true });
loadSubs(); dualRefresh(); focusRefresh();
$("focusBtn").onclick = focusToggle;
if (qs.get("engine")) { S.engine = qs.get("engine"); fillEngine(); }
if (qs.get("lang")) setLang(qs.get("lang"));
