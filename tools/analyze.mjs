// 측정 기록(JSON) 분석: 문장마다 "말 끝 → 한국어 자막 완성 / 한국어 음성 끝" 초 계산 + 문장별 한국어 모으기
// 쓰는 법: node tools/analyze.mjs 측정.json tests/syn_gapped.json
import { readFileSync } from "node:fs";
const [logF, refF] = process.argv.slice(2);
const L = JSON.parse(readFileSync(logF, "utf8"));
const R = JSON.parse(readFileSync(refF, "utf8"));
const ev = L.log;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const rows = [];
for (let i = 0; i < R.ends.length; i++) {
  const st = R.starts[i], end = R.ends[i], next = R.starts[i + 1] ?? end + 15;
  const inWin = (e) => e.t >= st && e.t < next;
  const ks = ev.filter((e) => e.k === "k" && inWin(e));
  const kx = ev.filter((e) => e.k === "kx" && inWin(e));
  const js = ev.filter((e) => e.k === "j" && inWin(e));
  const vOff = ev.filter((e) => (e.k === "a0" || e.k === "s0") && inWin(e) && e.t > end - 0.5);
  const vOn = ev.filter((e) => (e.k === "a1" || e.k === "s1") && inWin(e));
  rows.push({
    i: i + 1,
    textDone: ks.length ? +(ks.at(-1).t - end).toFixed(2) : null,
    firstKo: ks.length ? +(ks[0].t - st).toFixed(2) : null,
    voiceStart: vOn.length ? +(vOn[0].t - st).toFixed(2) : null,
    voiceDone: vOff.length ? +(vOff.at(-1).t - end).toFixed(2) : null,
    ja: js.map((e) => e.x).join(""),
    ko: ks.map((e) => e.x).join(""),
    skipped: kx.map((e) => e.x).join(""),
    lang: R.langs ? R.langs[i] : "ja",
  });
}
const pick = (k) => rows.map((r) => r[k]).filter((v) => v !== null);
console.log(`엔진: ${L.engine}  문장 ${rows.length}개`);
console.log(`말 끝→자막 완성(초)  중앙값 ${med(pick("textDone"))}  최대 ${Math.max(...pick("textDone"))}`);
console.log(`말 끝→음성 끝(초)    중앙값 ${med(pick("voiceDone"))}  최대 ${Math.max(...pick("voiceDone"))}`);
console.log(`말 시작→첫 한국어 자막(초) 중앙값 ${med(pick("firstKo"))} / 첫 음성 ${med(pick("voiceStart"))}`);
if (R.langs) {
  const jaRows = rows.filter((r) => r.lang === "ja");
  console.log(`[중국어만 시험] 통역사(일본어) 구간 ${jaRows.length}개 중 한국어가 새어 나온 구간 ${jaRows.filter((r) => r.ko.trim()).length}개`);
}
for (const r of rows) console.log(`#${r.i} [${r.lang}] 자막완성 ${r.textDone} 음성끝 ${r.voiceDone} | ${r.ko}${r.skipped ? "  (건너뜀: " + r.skipped + ")" : ""}\n      원문: ${r.ja}`);
