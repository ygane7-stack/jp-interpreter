// ============================================================
// jp-interpreter-token — 일본여행 실시간 통역 페이지용 "임시 열쇠" 발급 v1.0 (2026-11-15, 새 함수)
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
//   GET  ?r=ping                                                        → 어떤 시크릿이 들어 있는지(값 말고 있음/없음)
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
  const engine = body.engine;
  try {
    let out;
    if (engine === "openai") {
      const lang = OUT_LANGS.has(body.lang) ? body.lang : "ko";
      out = await openaiSecret(lang, body.noise || "far_field");
    } else if (engine === "soniox") {
      out = await sonioxKey();
    } else {
      return json({ ok: false, error: "engine 은 openai 또는 soniox" }, 400);
    }
    console.log(JSON.stringify({ ev: "mint", engine, at: new Date().toISOString() }));
    return json({ ok: true, ...out });
  } catch (e) {
    console.log(JSON.stringify({ ev: "mint_fail", engine, err: String(e).slice(0, 300) }));
    return json({ ok: false, error: String((e as Error).message || e) }, 502);
  }
});
