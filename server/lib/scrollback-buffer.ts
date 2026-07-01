/**
 * Circular byte buffer for PTY scrollback replay.
 * Stores the last `capacity` bytes of PTY output; oldest bytes are silently
 * discarded when the buffer is full.
 * @module
 */

export class ScrollbackBuffer {
  private buf: Buffer;
  private writePos = 0;
  private stored = 0;
  readonly capacity: number;

  constructor(capacityBytes = 100 * 1024) {
    this.capacity = capacityBytes;
    this.buf = Buffer.allocUnsafe(capacityBytes);
  }

  write(data: string): void {
    const src = Buffer.from(data, 'binary');
    const len = src.length;
    if (len === 0) return;

    if (len >= this.capacity) {
      src.copy(this.buf, 0, len - this.capacity);
      this.writePos = 0;
      this.stored = this.capacity;
      return;
    }

    const end = this.writePos + len;
    if (end <= this.capacity) {
      src.copy(this.buf, this.writePos);
    } else {
      const tailLen = this.capacity - this.writePos;
      src.copy(this.buf, this.writePos, 0, tailLen);
      src.copy(this.buf, 0, tailLen);
    }
    this.writePos = end % this.capacity;
    this.stored = Math.min(this.stored + len, this.capacity);
  }

  read(): Buffer {
    if (this.stored === 0) return Buffer.alloc(0);
    if (this.stored < this.capacity) {
      return Buffer.from(this.buf.subarray(0, this.stored));
    }
    const out = Buffer.allocUnsafe(this.capacity);
    const tailLen = this.capacity - this.writePos;
    this.buf.copy(out, 0, this.writePos);
    this.buf.copy(out, tailLen, 0, this.writePos);
    return out;
  }
}
