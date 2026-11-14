# jp-interpreter — 일본여행 건축 해설 실시간 통역 (日→韓)

- `web/` 아이폰 사파리에서 여는 페이지 (설치 없음). 엔진 2개: OpenAI `gpt-realtime-translate`(WebRTC) / Soniox `stt-rt-v6`+브라우저 읽어주기
- `supabase/functions/jp-interpreter-token/` 임시 열쇠 함수 (workbench-portal 프로젝트). 진짜 키는 함수 시크릿에만.
- `tools/serve.mjs` 맥 시험 서버(http://localhost:8787, /token 대리), `tools/analyze.mjs` 측정 기록 분석
- `tests/script_ja.txt` 합성 시험 대본(정답). 소리 파일(*.wav)은 저장소에 넣지 않는다.

기준·기록 문서: SynologyDrive `0.어플제작/일본여행_통역/`
