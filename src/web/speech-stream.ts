/**
 * Cuts a streamed answer into speakable pieces as soon as each sentence is complete,
 * so speech synthesis can start on the first sentence while the model is still writing.
 */
export class SentenceSplitter {
  private buf = '';
  private emitted = 0;

  /** @returns finished pieces, in order */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (piece) {
        out.push(piece);
        this.emitted++;
      }
    }
    return out;
  }

  flush(): string | undefined {
    const rest = this.buf.trim();
    this.buf = '';
    return rest || undefined;
  }

  private findCut(): number {
    const first = this.emitted === 0;
    // the first piece may be short (start talking fast); later ones are merged up to a comfortable length
    const min = first ? 12 : 40;
    const re = /[.!?…]+["»”)]?(?=\s)|\n+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length;
      if (end >= min) return end;
    }
    // no sentence end yet: break at a comma / dash (early for the first piece) so the voice does not wait
    const limit = first ? 60 : 180;
    if (this.buf.length > limit) {
      const soft = /,\s| — /g;
      let best = -1;
      let m: RegExpExecArray | null;
      while ((m = soft.exec(this.buf)) && m.index <= limit) {
        if (m.index < (first ? 18 : 60)) continue;
        best = m.index;
        if (first) break; // first piece: the earliest natural pause
      }
      if (best >= 0) return best + 1;
    }
    return -1;
  }
}

type Chunk = { audio: string } | { end: true };

/**
 * Synthesises pieces in parallel but delivers audio strictly in order:
 * chunks of the piece being played go out live, later pieces are buffered until it ends.
 */
export class OrderedSpeech {
  private jobs: Array<{ chunks: Chunk[] }> = [];
  private current = 0;
  private sent = 0;
  private all: Promise<void>[] = [];

  constructor(
    private synth: (text: string, onAudio: (b64: string) => void) => Promise<void>,
    private send: (seq: number, chunk: Chunk) => void,
  ) {}

  add(text: string): void {
    const job = { chunks: [] as Chunk[] };
    this.jobs.push(job);
    const push = (c: Chunk) => {
      job.chunks.push(c);
      this.pump();
    };
    this.all.push(
      this.synth(text, (audio) => push({ audio }))
        .catch(() => undefined)
        .finally(() => push({ end: true })),
    );
  }

  private pump(): void {
    for (;;) {
      const job = this.jobs[this.current];
      if (!job || this.sent >= job.chunks.length) return;
      const c = job.chunks[this.sent++]!;
      this.send(this.current, c);
      if ('end' in c) {
        this.current++;
        this.sent = 0;
      }
    }
  }

  get count(): number {
    return this.jobs.length;
  }

  async done(): Promise<void> {
    await Promise.all(this.all);
  }
}
