// Small UI toolkit: ribbon, modals, toasts, hints.
import { icon } from './icons.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = 'info', ms = 2800) {
  const root = $('#toasts');
  const el = h(`<div class="toast ${kind}">${icon(kind === 'ok' ? 'check' : kind === 'error' ? 'x' : kind === 'warn' ? 'info' : 'info')}<span>${esc(msg)}</span></div>`);
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, ms);
}

// ---------------------------------------------------------------- tool hint banner
export function hint(text, onCancel) {
  const el = $('#hint');
  el.innerHTML = `<span class="hint-dot"></span><span>${esc(text)}</span>${onCancel ? `<button class="hint-x">${icon('x')}<span>Esc</span></button>` : ''}`;
  el.hidden = false;
  const b = el.querySelector('.hint-x'); if (b) b.onclick = onCancel;
}
export function hideHint() { $('#hint').hidden = true; }

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions = [], wide = false, onClose, dismissible = true, cls = '' }) {
  const root = $('#modal-root');
  const el = h(`<div class="modal-wrap"><div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="true">
      <header><h2>${esc(title)}</h2>${dismissible ? `<button class="icon-btn m-close" aria-label="Close">${icon('x')}</button>` : ''}</header>
      <div class="modal-body"></div>
      <footer></footer></div></div>`);
  const bodyEl = el.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const foot = el.querySelector('footer');
  let closed = false;
  const close = (v) => {
    if (closed) return; closed = true;
    el.classList.remove('in'); setTimeout(() => el.remove(), 180);
    document.removeEventListener('keydown', onKey);
    onClose && onClose(v);
  };
  for (const a of actions) {
    const b = h(`<button class="btn ${a.kind || ''}" ${a.id ? `id="${a.id}"` : ''}>${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span></button>`);
    if (a.left) b.classList.add('left');
    b.onclick = () => a.onClick ? a.onClick(close, el) : close();
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  const onKey = (e) => { if (e.key === 'Escape' && dismissible) close(); };
  document.addEventListener('keydown', onKey);
  if (dismissible) {
    el.querySelector('.m-close').onclick = () => close();
    el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  }
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  return { el, body: bodyEl, close };
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    modal({ title, body: `<p class="muted">${esc(text)}</p>`, onClose: (v) => res(!!v),
      actions: [{ label: 'Cancel', onClick: (c) => c(false) }, { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: (c) => c(true) }] });
  });
}
export function promptBox(title, label, value = '') {
  return new Promise((res) => {
    const m = modal({ title, body: `<label class="field"><span>${esc(label)}</span><input type="text" value="${esc(value)}"></label>`,
      onClose: (v) => res(v ?? null),
      actions: [{ label: 'Cancel', onClick: (c) => c(null) }, { label: 'OK', kind: 'primary', onClick: (c) => c(m.body.querySelector('input').value.trim()) }] });
    const inp = m.body.querySelector('input'); setTimeout(() => { inp.focus(); inp.select(); }, 60);
    inp.onkeydown = (e) => { if (e.key === 'Enter') m.close(inp.value.trim()); };
  });
}

// ---------------------------------------------------------------- ribbon
// def: [{ id, label, groups: [{ label, items: [{ cmd, icon, label, tip, toggle }] }] }]
export class Ribbon {
  constructor(tabsEl, ribbonEl, def, onCmd) {
    this.tabsEl = tabsEl; this.ribbonEl = ribbonEl; this.def = def; this.onCmd = onCmd;
    this.active = new Set(); this.disabled = new Set();
    this.current = def[0].id;
    this.render();
  }
  render() {
    this.tabsEl.innerHTML = this.def.map((t) => `<button role="tab" class="rtab ${t.id === this.current ? 'on' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('') + '<span class="rtab-ink"></span>';
    this.tabsEl.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) this.selectTab(b.dataset.tab); };
    this._renderPanel();
    requestAnimationFrame(() => this._ink());
  }
  _renderPanel() {
    const tab = this.def.find((t) => t.id === this.current);
    this.ribbonEl.innerHTML = tab.groups.map((g) => `
      <div class="rgroup"><div class="ritems">${g.items.map((it) => `
        <button class="rbtn ${this.active.has(it.cmd) ? 'on' : ''}" data-cmd="${it.cmd}" title="${esc(it.tip || it.label)}" ${this.disabled.has(it.cmd) ? 'disabled' : ''}>
          ${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('')}</div>
        <div class="rlabel">${esc(g.label)}</div></div>`).join('<div class="rsep"></div>');
    this.ribbonEl.onclick = (e) => { const b = e.target.closest('[data-cmd]'); if (b && !b.disabled) this.onCmd(b.dataset.cmd, b); };
    this.ribbonEl.scrollLeft = 0;
  }
  _ink() {
    const on = this.tabsEl.querySelector('.rtab.on'), ink = this.tabsEl.querySelector('.rtab-ink');
    if (on && ink) { ink.style.width = `${on.offsetWidth - 20}px`; ink.style.transform = `translateX(${on.offsetLeft + 10}px)`; }
  }
  selectTab(id) {
    this.current = id;
    this.tabsEl.querySelectorAll('.rtab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    this._ink();
    this._renderPanel();
  }
  setActive(cmd, on) {
    on ? this.active.add(cmd) : this.active.delete(cmd);
    this.ribbonEl.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((b) => b.classList.toggle('on', !!on));
  }
  setDisabled(cmd, off) {
    off ? this.disabled.add(cmd) : this.disabled.delete(cmd);
    this.ribbonEl.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((b) => (b.disabled = !!off));
  }
}

export function download(blobOrUrl, filename) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fileToDataURL(file, maxSize = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, maxSize / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot read image')); };
    img.src = url;
  });
}
