// UI-only gesture state. A late connection must never revive a released gesture.
export class Hold {
  constructor({ begin, end, change }) {
    this.begin = begin; this.end = end; this.change = change;
    this.sequence = 0; this.active = null;
  }
  start(input) {
    if (this.active) return null;
    const token = ++this.sequence;
    this.active = { input, token };
    this.change(true);
    this.begin(token);
    return token;
  }
  stop(input) {
    if (!this.active || (input && input !== this.active.input)) return;
    const { token } = this.active;
    this.active = null;
    this.change(false);
    this.end(token);
  }
}
