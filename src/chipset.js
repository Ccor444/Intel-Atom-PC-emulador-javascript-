'use strict';

export class Memory {
  constructor(sizeBytes) {
    this.size = sizeBytes;
    this.data = new Uint8Array(sizeBytes);
  }
  _chk(a, n) {
    const x = a & 0xFFFFFF;
    return (x + n) <= this.size ? x : -1;
  }
  read8(a)  { const i = this._chk(a, 1); return i < 0 ? 0 : this.data[i]; }
  read16(a) {
    const i = this._chk(a, 2);
    return i < 0 ? 0 : (this.data[i] | (this.data[i+1] << 8));
  }
  read32(a) {
    const i = this._chk(a, 4);
    return i < 0 ? 0 :
      ((this.data[i] | (this.data[i+1] << 8) |
        (this.data[i+2] << 16) | (this.data[i+3] << 24)) >>> 0);
  }
  write8(a, v)  { const i = this._chk(a, 1); if (i >= 0) this.data[i] = v & 0xFF; }
  write16(a, v) {
    const i = this._chk(a, 2); if (i < 0) return;
    this.data[i]   = v & 0xFF;
    this.data[i+1] = (v >>> 8) & 0xFF;
  }
  write32(a, v) {
    const i = this._chk(a, 4); if (i < 0) return;
    this.data[i]   = v & 0xFF;
    this.data[i+1] = (v >>> 8)  & 0xFF;
    this.data[i+2] = (v >>> 16) & 0xFF;
    this.data[i+3] = (v >>> 24) & 0xFF;
  }
}

export class ATXPowerSupply {
  constructor() {
    this.state = 'off';
    this.listeners = [];
  }
  plugIn()  { this.state = 'standby'; this._emit('standby'); }
  turnOn()  {
    if (this.state === 'on') return;
    this.state = 'on';
    this._emit('on');
    setTimeout(() => this._emit('powergood'), 200);
  }
  turnOff() { this.state = 'standby'; this._emit('off'); }
  reset()   { this._emit('reset'); setTimeout(() => this._emit('powergood'), 100); }
  onEvent(fn) { this.listeners.push(fn); }
  _emit(ev) { for (const fn of this.listeners) fn(ev); }
}