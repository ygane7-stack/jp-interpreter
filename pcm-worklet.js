// 마이크 소리 → 16kHz 16비트 PCM 조각(약 100ms) + 소리 크기(dB)
// Soniox 로 보낼 조각을 만들고, 화면의 소리 막대와 말 끝 감지(측정용)에 크기를 쓴다.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // 보통 48000/16000 = 3
    this.acc = 0; // 다음 출력 샘플 위치(입력 기준, 소수)
    this.sum = 0; this.cnt = 0; // 구간 평균(간단한 저역 통과)
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sq = 0; this.sqN = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.sq += v * v; this.sqN++;
      this.sum += v; this.cnt++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.sum / this.cnt));
        this.sum = 0; this.cnt = 0;
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.out.length) {
          const rms = Math.sqrt(this.sq / Math.max(1, this.sqN));
          const db = 20 * Math.log10(rms + 1e-9);
          this.port.postMessage({ pcm: this.out.buffer, db }, [this.out.buffer]);
          this.out = new Int16Array(1600);
          this.n = 0; this.sq = 0; this.sqN = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-worklet", PcmWorklet);
