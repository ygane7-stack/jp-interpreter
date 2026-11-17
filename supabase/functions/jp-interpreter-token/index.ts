// ============================================================
// jp-interpreter-token — 일본여행 실시간 통역 페이지용 "임시 열쇠" 발급 v1.1 (2026-11-17: 사진 번역·정리본 추가)
//   코드 원본: ~/jp-interpreter/supabase/functions/jp-interpreter-token/index.ts
//   기준 문서: 0.어플제작/일본여행_통역/02_기준_일본여행통역.md
//
// ★ 규칙
//   1. 진짜 API 키(OPENAI_API_KEY, SONIOX_API_KEY)는 함수 시크릿에만 있다. 화면에는 절대 내보내지 않는다.
//   2. 화면은 암호(JPI_PASSCODE, 승관님이 시크릿으로 넣음)를 x-jpi-pass 머리글로 보내야 임시 열쇠를 받는다.
//   3. 임시 열쇠: OpenAI 는 10분 안에 연결 시작(연결된 뒤에는 계속), Soniox 는 5분 안에 연결 시작 + 한 번만 + 최대 3시간.
//   4. 표를 쓰지 않는다. 사용 기록은 함수 로그(console)에만 남긴다(엔진·시각).
// 라우트
//   POST {engine:"openai", lang:"ko", noise:"far_field"|"near_field"}  → {engine, value, expires_at}
//   POST {engine:"soniox"}                                              → {engine, api_key, expires_at}
//   POST {kind:"vision", image:"data:image/jpeg;base64,…", mode:"scan"|"detail"} → {items:[{ja,ko,kind}], note}  (v1.1 간판·상품 카메라)
//   POST {kind:"summary", step:"part"|"final", text, bld, terms}        → {md}  (v1.1 강연 정리본, 긴 강연은 화면이 잘라 차례로)
//   GET  ?r=ping                                                        → 어떤 시크릿이 들어 있는지(값 말고 있음/없음)
//   사진·정리본은 OpenAI 키로 함수가 대신 묻는다(키는 화면에 안 나감). 모델은 시크릿 JPI_VISION_MODEL / JPI_TEXT_MODEL 로 바꿀 수 있음(기본 gpt-5-mini)
// 배포: supabase functions deploy jp-interpreter-token --no-verify-jwt --project-ref trjsxwcekqmlnwfyswky
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-jpi-pass, authorization, apikey",
  "Cache-Control": "no-store",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function sameText(a: string, b: string) {
  // 길이·내용 비교를 한 글자씩 끝까지(시간 차이로 암호를 추측하기 어렵게)
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const OUT_LANGS = new Set(["ko", "en", "ja", "zh", "es", "fr", "de", "pt", "ru", "hi", "id", "vi", "it"]);

async function openaiSecret(lang: string, noise: string) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY 시크릿이 아직 없습니다");
  const r = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "jpi-owner",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        model: "gpt-realtime-translate",
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper" },
            noise_reduction: { type: noise === "near_field" ? "near_field" : "far_field" },
          },
          output: { language: lang },
        },
      },
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`);
  const d = JSON.parse(t);
  const value = d.value ?? d.client_secret?.value;
  if (!value) throw new Error("OpenAI 응답에 임시 열쇠가 없습니다");
  return { engine: "openai", value, expires_at: d.expires_at ?? d.client_secret?.expires_at ?? null };
}

async function sonioxKey() {
  const key = Deno.env.get("SONIOX_API_KEY");
  if (!key) throw new Error("SONIOX_API_KEY 시크릿이 아직 없습니다");
  const r = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      usage_type: "transcribe_websocket",
      expires_in_seconds: 300,
      single_use: true,
      max_session_duration_seconds: 10800,
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Soniox ${r.status}: ${t.slice(0, 300)}`);
  const d = JSON.parse(t);
  return { engine: "soniox", api_key: d.api_key, expires_at: d.expires_at ?? null };
}


// ---------- v1.1 사진 번역(간판·상품) · 강연 정리본 ----------
async function chat(model: string, messages: unknown[], maxTok: number, jsonOut: boolean) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY 시크릿이 아직 없습니다");
  const body: Record<string, unknown> = { model, messages, max_completion_tokens: maxTok };
  if (jsonOut) body.response_format = { type: "json_object" };
  if (/^gpt-5/.test(model)) body.reasoning_effort = "minimal"; // 빠르게(생각 단계 최소)
  const call = (b: Record<string, unknown>) => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": "jpi-owner" },
    body: JSON.stringify(b),
  });
  let r = await call(body);
  if (r.status === 400 && body.reasoning_effort) { // 모델이 그 설정을 안 받으면 빼고 한 번 더
    const t = await r.text();
    if (/reasoning/i.test(t)) { delete body.reasoning_effort; r = await call(body); }
    else throw new Error(`OpenAI 400: ${t.slice(0, 300)}`);
  }
  const t = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`);
  const d = JSON.parse(t);
  return { text: d.choices?.[0]?.message?.content ?? "", usage: d.usage ?? null };
}

const VISION_SCAN = `너는 일본 여행 중인 한국인 건축가 옆의 통역사다. 사진 속 일본어(간판·안내문·상품 포장·가격표·메뉴)를 읽고 한국어로 옮긴다.
- 중요한 글자부터 최대 8개. 작은 글씨·법적 문구는 빼도 된다. 가격은 "¥1,280 (세금 포함)"처럼 그대로.
- 고유명사(건물·건축가·상호)는 한국어 발음 + 필요하면 괄호에 뜻.
- kind 는 sign(간판·안내)·product(상품)·price(가격)·menu(메뉴)·other 중 하나.
- note 는 사진 전체를 한 줄로(예: "녹차맛 킷캣 12개입, 1,080엔"). 일본어 글자가 없으면 items 는 빈 배열, note 는 "일본어 글자가 안 보여요".
JSON 으로만 답한다: {"items":[{"ja":"…","ko":"…","kind":"…"}],"note":"…"}`;
const VISION_DETAIL = `너는 일본 여행 중인 한국인 옆의 통역사다. 사진 속 상품·간판·안내문을 자세히 설명한다.
- items: 보이는 일본어를 빠짐없이(최대 20개) {"ja","ko","kind"}.
- note: 한국어 3~6문장. 무엇인지, 맛·용도·특징, 가격과 세금 포함 여부, 주의할 점(유통기한·알레르기·면세 가능 등), 비슷한 한국 물건이 있으면 비교.
JSON 으로만 답한다: {"items":[…],"note":"…"}`;

async function vision(image: string, mode: string) {
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 1_500_000) throw new Error("사진 형식이 맞지 않거나 너무 큽니다");
  const model = Deno.env.get("JPI_VISION_MODEL") || "gpt-5-mini";
  const detail = mode === "detail";
  const { text, usage } = await chat(model, [
    { role: "system", content: detail ? VISION_DETAIL : VISION_SCAN },
    { role: "user", content: [{ type: "image_url", image_url: { url: image, detail: detail ? "high" : "auto" } }] },
  ], detail ? 1500 : 600, true);
  let o: { items?: unknown[]; note?: string } = {};
  try { o = JSON.parse(text); } catch (_) { o = { items: [], note: text.slice(0, 300) }; }
  return { items: Array.isArray(o.items) ? o.items.slice(0, 20) : [], note: o.note || "", usage, model };
}

const SUM_BASE = `너는 건축 답사 여행에 동행한 한국인 통역사다. 아래는 일본어(또는 중국어) 건축 해설·강연을 실시간 기계 통역한 자막이다.
엔진 A(Soniox)는 원문+번역, 엔진 B(GPT)는 번역만 있을 수 있다. 둘이 다르면 원문과 용어집을 근거로 맞는 쪽을 고른다.
용어집의 이름·용어 표기를 반드시 따른다. 알아듣기 어려운 부분은 지어내지 말고 "(잘 안 들림)"으로 둔다.`;
const SUM_PART = SUM_BASE + `
이것은 긴 강연의 한 부분이다. 한국어 마크다운으로:
### 이 부분 핵심 (3~8개 글머리표)
### 다듬은 통역문 (시간 순서, 오역을 바로잡은 자연스러운 한국어 문단. 군더더기 말은 줄여도 됨)
### 기계 통역이 틀렸던 곳 (있으면 "자막 → 바로잡음" 몇 개, 없으면 생략)`;
const SUM_FINAL = `너는 건축 답사 여행에 동행한 한국인 통역사다. 아래는 한 강연·해설을 부분별로 정리한 메모다. 용어집 표기를 따른다.
한국어 마크다운으로:
## 한 줄 요약
## 핵심 내용 (5~12개 글머리표, 말한 사람이 강조한 것 위주)
## 나온 건물·사람·용어 (원어 표기 함께)`;

// step "part": 자막 한 부분(약 2만 자까지) → 핵심+다듬은 통역문 / step "final": 부분 메모들 → 전체 요약
// 화면이 긴 강연을 잘라 차례로 보낸다(한 번 호출이 1~2분 안에 끝나게).
async function summary(text: string, bld: string, terms: string, step: string) {
  if (!text || text.length < 20) throw new Error("정리할 자막이 거의 없습니다");
  const model = Deno.env.get("JPI_TEXT_MODEL") || "gpt-5-mini";
  const fin = step === "final";
  const { text: md, usage } = await chat(model, [
    { role: "system", content: fin ? SUM_FINAL : SUM_PART },
    { role: "user", content: `건물·행사: ${bld || "-"}\n\n[용어집]\n${(terms || "").slice(0, 6000)}\n\n[${fin ? "부분 메모" : "자막"}]\n${text.slice(0, 40_000)}` },
  ], fin ? 3000 : 6000, false);
  return { md, usage, model };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("r") === "ping") {
    return json({
      ok: true,
      has: {
        JPI_PASSCODE: !!Deno.env.get("JPI_PASSCODE"),
        OPENAI_API_KEY: !!Deno.env.get("OPENAI_API_KEY"),
        SONIOX_API_KEY: !!Deno.env.get("SONIOX_API_KEY"),
      },
    });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST 만 받습니다" }, 405);

  const pass = Deno.env.get("JPI_PASSCODE") || "";
  if (!pass) return json({ ok: false, error: "JPI_PASSCODE 시크릿이 아직 없습니다" }, 503);
  if (!sameText(req.headers.get("x-jpi-pass") || "", pass)) {
    await new Promise((r) => setTimeout(r, 800)); // 연속 추측 늦추기
    return json({ ok: false, error: "암호가 맞지 않습니다" }, 401);
  }

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch (_) { /* 빈 몸 */ }
  const engine = body.engine || body.kind;
  try {
    let out;
    if (body.kind === "vision") {
      out = await vision(body.image || "", body.mode || "scan");
      console.log(JSON.stringify({ ev: "vision", mode: body.mode, usage: out.usage, at: new Date().toISOString() }));
      return json({ ok: true, ...out });
    } else if (body.kind === "summary") {
      out = await summary(body.text || "", body.bld || "", body.terms || "", body.step || "part");
      console.log(JSON.stringify({ ev: "summary", usage: out.usage, at: new Date().toISOString() }));
      return json({ ok: true, ...out });
    } else if (engine === "openai") {
      const lang = OUT_LANGS.has(body.lang) ? body.lang : "ko";
      out = await openaiSecret(lang, body.noise || "far_field");
    } else if (engine === "soniox") {
      out = await sonioxKey();
    } else {
      return json({ ok: false, error: "engine 은 openai 또는 soniox, kind 는 vision 또는 summary" }, 400);
    }
    console.log(JSON.stringify({ ev: "mint", engine, at: new Date().toISOString() }));
    return json({ ok: true, ...out });
  } catch (e) {
    console.log(JSON.stringify({ ev: "mint_fail", engine, err: String(e).slice(0, 300) }));
    return json({ ok: false, error: String((e as Error).message || e) }, 502);
  }
});
