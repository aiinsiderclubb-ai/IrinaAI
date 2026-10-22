/** Loudness meter over any number of audio sources (mic, assistant voice) for the orb animation. */
export class LevelMeter {
  readonly ctx = new AudioContext();
  private analysers: AnalyserNode[] = [];
  private buf = new Uint8Array(256);

  addStream(stream: MediaStream): void {
    if (!stream.getAudioTracks().length) return;
    this.connect(this.ctx.createMediaStreamSource(stream));
  }

  addElement(el: HTMLAudioElement): void {
    const src = this.ctx.createMediaElementSource(el);
    src.connect(this.ctx.destination); // keep it audible
    this.connect(src);
  }

  private connect(node: AudioNode): AnalyserNode {
    const a = this.ctx.createAnalyser();
    a.fftSize = 512;
    node.connect(a);
    this.analysers.push(a);
    return a;
  }

  /** RMS of one analyser (0..1) */
  rms(index: number): number {
    const a = this.analysers[index];
    if (!a) return 0;
    a.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / this.buf.length);
  }

  /** loudest source, scaled for display */
  level(): number {
    let peak = 0;
    for (let i = 0; i < this.analysers.length; i++) peak = Math.max(peak, this.rms(i));
    return Math.min(1, peak * 5);
  }

  close(): void {
    void this.ctx.close().catch(() => {});
  }
}
