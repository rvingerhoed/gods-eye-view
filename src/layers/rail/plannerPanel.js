/**
 * @module layers/rail/plannerPanel
 * @description DOM for the Spoor NL journey planner: VAN/NAAR with station
 * autocomplete, date/time, VERTREK/AANKOMST, PLAN, and the option list with
 * per-leg detail (train type, direction, tracks, transfers, delays).
 *
 * The layer row can only hold chips and a list, so the text inputs live in
 * this floating panel. It is draggable by its header and remembers its
 * position. Everything is written with textContent — NS strings never reach
 * innerHTML. GEV's global shortcuts already ignore keys typed into inputs.
 */

import {
  formatDelay,
  formatDuration,
  formatLeg,
  formatOptionSummary,
  formatTransferLabel,
  hhmm,
  trackChanged,
} from '../../data/railTrips.js';
import { amsterdamWallValue } from '../../data/railStations.js';

const STYLE_ID = 'rail-planner-style';
const POSITION_KEY = 'gev.rail.panelPosition';

const CSS = `
.rail-panel{position:fixed;z-index:900;width:340px;max-width:calc(100vw - 32px);max-height:calc(100vh - 140px);
  display:flex;flex-direction:column;background:rgba(6,12,18,.93);color:#d8f6ff;border:1px solid rgba(57,208,255,.35);
  border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,.55);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  backdrop-filter:blur(6px)}
.rail-panel[hidden]{display:none}
.rail-head{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;cursor:move;user-select:none;
  border-bottom:1px solid rgba(57,208,255,.2);letter-spacing:.08em;color:#39d0ff;font-weight:700}
.rail-head button{all:unset;cursor:pointer;color:#9fb9c4;padding:0 4px;font-size:14px}
.rail-head button:hover{color:#fff}
.rail-body{padding:9px 10px;overflow:auto}
.rail-field{position:relative;display:flex;align-items:center;gap:6px;margin-bottom:6px}
.rail-field label{width:42px;color:#7fa3b1;font-size:11px;letter-spacing:.06em}
.rail-field input{flex:1;min-width:0;background:rgba(255,255,255,.05);color:#e9fbff;border:1px solid rgba(57,208,255,.25);
  border-radius:4px;padding:5px 7px;font:inherit}
.rail-field input:focus{outline:none;border-color:#39d0ff;background:rgba(57,208,255,.08)}
.rail-swap{all:unset;cursor:pointer;color:#39d0ff;padding:0 4px;font-size:14px}
.rail-ac{position:absolute;left:48px;right:0;top:100%;z-index:2;margin:2px 0 0;padding:2px 0;list-style:none;
  background:#0b1720;border:1px solid rgba(57,208,255,.35);border-radius:4px;max-height:220px;overflow:auto}
.rail-ac li{padding:4px 8px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
.rail-ac li.active,.rail-ac li:hover{background:rgba(57,208,255,.18)}
.rail-ac small{color:#7fa3b1}
.rail-row{display:flex;gap:6px;align-items:center;margin:4px 0 8px}
.rail-row input{flex:1}
.rail-toggle{display:flex;border:1px solid rgba(57,208,255,.3);border-radius:4px;overflow:hidden}
.rail-toggle button,.rail-btn{all:unset;cursor:pointer;padding:5px 8px;font-size:11px;letter-spacing:.06em;color:#9fc7d4}
.rail-toggle button.on{background:rgba(57,208,255,.22);color:#fff}
.rail-btn{border:1px solid rgba(57,208,255,.45);border-radius:4px;color:#39d0ff;text-align:center}
.rail-btn.primary{background:rgba(57,208,255,.18);color:#fff;font-weight:700;flex:1}
.rail-btn:disabled,.rail-btn[aria-disabled=true]{opacity:.45;cursor:default}
.rail-status{margin:6px 0;color:#9fb9c4;min-height:1em}
.rail-status.error{color:#ff8a8a}
.rail-status.busy{color:#39d0ff}
.rail-options{list-style:none;margin:0;padding:0}
.rail-opt{border:1px solid rgba(57,208,255,.18);border-radius:5px;margin:0 0 6px;cursor:pointer}
.rail-opt:hover{border-color:rgba(57,208,255,.5)}
.rail-opt.sel{border-color:#39d0ff;background:rgba(57,208,255,.08)}
.rail-opt.cancelled .rail-opt-sum{text-decoration:line-through;color:#8a99a0}
.rail-opt-sum{padding:6px 8px;display:flex;justify-content:space-between;gap:6px}
.rail-opt-sum b{color:#fff}
.rail-tag{font-size:10px;padding:0 4px;border-radius:3px;border:1px solid currentColor}
.rail-tag.red{color:#ff6b6b}.rail-tag.amber{color:#ffb347}.rail-tag.green{color:#5dff9f}
.rail-legs{padding:0 8px 7px;border-top:1px dashed rgba(57,208,255,.18)}
.rail-leg{margin-top:6px}
.rail-leg-head{color:#e9fbff}
.rail-leg-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.rail-leg-line{color:#9fb9c4;padding-left:14px}
.rail-old{text-decoration:line-through;color:#7d8c93;margin-right:4px}
.rail-new{color:#ffb347;font-weight:700}
.rail-delay{color:#ff6b6b;font-weight:700;margin-left:3px}
.rail-xfer{margin:5px 0 0 14px;color:#ff9be9}
.rail-note{color:#ffb347;margin-top:5px}
.rail-popup{position:fixed;z-index:901;background:rgba(6,12,18,.95);border:1px solid rgba(57,208,255,.45);border-radius:5px;
  padding:6px;font:12px ui-monospace,Menlo,Consolas,monospace;color:#d8f6ff;box-shadow:0 6px 18px rgba(0,0,0,.5)}
.rail-popup b{display:block;margin:0 2px 5px;color:#fff}
.rail-popup .rail-btn{margin:0 2px}
`;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeStorage(read, key, value) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    if (read) return storage.getItem(key);
    storage.setItem(key, value);
  } catch {
    /* private mode or blocked storage */
  }
  return null;
}

/** Leg colours shared with the globe (cyan / magenta alternating). */
export const RAIL_LEG_COLORS = Object.freeze(['#39d0ff', '#ff4fd8']);

/**
 * @param {{documentRef: Document, search: (q: string) => Array<object>,
 *   onPlan: (q: {from: object, to: object, wall: string, arrival: boolean}) => void,
 *   onSelect: (index: number) => void, onClear: () => void,
 *   onVisibility?: (visible: boolean) => void}} options
 */
export function createRailPlannerPanel({
  documentRef,
  search,
  onPlan,
  onSelect,
  onClear,
  onVisibility = () => {},
}) {
  const doc = documentRef;
  let root = null;
  let removers = [];
  let fromStation = null;
  let toStation = null;
  let arrival = false;
  let options = [];
  let selected = -1;
  let busy = false;
  let notes = new Map();
  let refs = {};

  const listen = (node, type, handler, opts) => {
    node.addEventListener(type, handler, opts);
    removers.push(() => node.removeEventListener(type, handler, opts));
  };

  function injectStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const style = el(doc, 'style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function stationField(labelText, placeholder, onPick) {
    const field = el(doc, 'div', 'rail-field');
    const label = el(doc, 'label', '', labelText);
    const input = el(doc, 'input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const id = `rail-${labelText.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
    input.id = id;
    label.htmlFor = id;
    const list = el(doc, 'ul', 'rail-ac');
    list.hidden = true;
    field.append(label, input, list);
    let hits = [];
    let active = -1;
    const close = () => {
      list.hidden = true;
      active = -1;
    };
    const paint = () => {
      list.replaceChildren(
        ...hits.map((station, i) => {
          const item = el(doc, 'li', i === active ? 'active' : '');
          item.append(
            el(doc, 'span', '', station.name),
            el(doc, 'small', '', station.code),
          );
          item.addEventListener('mousedown', (event) => {
            event.preventDefault();
            choose(i);
          });
          return item;
        }),
      );
      list.hidden = hits.length === 0;
    };
    const choose = (i) => {
      const station = hits[i];
      if (!station) return;
      input.value = station.name;
      close();
      onPick(station);
    };
    listen(input, 'input', () => {
      onPick(null);
      hits = search(input.value);
      active = hits.length ? 0 : -1;
      paint();
    });
    listen(input, 'keydown', (event) => {
      if (event.key === 'ArrowDown' && hits.length) {
        active = (active + 1) % hits.length;
        paint();
        event.preventDefault();
      } else if (event.key === 'ArrowUp' && hits.length) {
        active = (active - 1 + hits.length) % hits.length;
        paint();
        event.preventDefault();
      } else if (event.key === 'Enter') {
        if (!list.hidden && active >= 0) choose(active);
        else if (!list.hidden && hits.length === 1) choose(0);
        else if (input.dataset.planOnEnter === '1') plan();
        event.preventDefault();
      } else if (event.key === 'Escape') {
        if (!list.hidden) {
          close();
          event.stopPropagation();
        }
      }
    });
    listen(input, 'blur', () => {
      setTimeout(() => {
        // Typing a full name without picking: take the best match.
        if (!list.hidden && hits.length && input.value.trim()) {
          const exact = hits.find(
            (s) => s.name.toLowerCase() === input.value.trim().toLowerCase(),
          );
          if (exact) choose(hits.indexOf(exact));
        }
        close();
      }, 120);
    });
    return { field, input };
  }

  function build() {
    injectStyle();
    root = el(doc, 'section', 'rail-panel');
    root.setAttribute('aria-label', 'Spoor NL reisplanner');
    const head = el(doc, 'div', 'rail-head');
    head.append(el(doc, 'span', '', '🚆 SPOOR NL · REISPLANNER'));
    const close = el(doc, 'button', '', '×');
    close.type = 'button';
    close.title = 'Paneel sluiten (PLANNER-chip opent het weer)';
    head.append(close);
    const body = el(doc, 'div', 'rail-body');

    const from = stationField('VAN', 'bv. Leiden Centraal', (s) => {
      fromStation = s;
      if (s) safeStorage(false, 'gev.rail.from', s.code);
      sync();
    });
    const to = stationField('NAAR', 'bv. Castricum', (s) => {
      toStation = s;
      if (s) safeStorage(false, 'gev.rail.to', s.code);
      sync();
    });
    to.input.dataset.planOnEnter = '1';
    const swap = el(doc, 'button', 'rail-swap', '⇅');
    swap.type = 'button';
    swap.title = 'VAN en NAAR omwisselen';
    from.field.append(swap);

    const row = el(doc, 'div', 'rail-row');
    const when = el(doc, 'input');
    when.type = 'datetime-local';
    when.value = amsterdamWallValue();
    when.className = 'rail-when';
    when.style.cssText =
      'background:rgba(255,255,255,.05);color:#e9fbff;border:1px solid rgba(57,208,255,.25);border-radius:4px;padding:4px 6px;font:inherit;color-scheme:dark';
    const nowBtn = el(doc, 'button', 'rail-btn', 'NU');
    nowBtn.type = 'button';
    nowBtn.title = 'Tijd op nu zetten';
    row.append(when, nowBtn);

    const row2 = el(doc, 'div', 'rail-row');
    const toggle = el(doc, 'div', 'rail-toggle');
    const dep = el(doc, 'button', 'on', 'VERTREK');
    const arr = el(doc, 'button', '', 'AANKOMST');
    dep.type = arr.type = 'button';
    toggle.append(dep, arr);
    const planBtn = el(doc, 'button', 'rail-btn primary', 'PLAN');
    planBtn.type = 'button';
    const clearBtn = el(doc, 'button', 'rail-btn', 'WISSEN');
    clearBtn.type = 'button';
    row2.append(toggle, planBtn, clearBtn);

    const status = el(doc, 'div', 'rail-status');
    status.setAttribute('role', 'status');
    const list = el(doc, 'ol', 'rail-options');

    body.append(from.field, to.field, row, row2, status, list);
    root.append(head, body);
    doc.body.appendChild(root);
    refs = {
      from: from.input,
      to: to.input,
      when,
      dep,
      arr,
      planBtn,
      clearBtn,
      status,
      list,
      head,
    };

    listen(close, 'click', () => setVisible(false));
    listen(swap, 'click', () => {
      [fromStation, toStation] = [toStation, fromStation];
      [refs.from.value, refs.to.value] = [refs.to.value, refs.from.value];
      sync();
    });
    listen(nowBtn, 'click', () => {
      when.value = amsterdamWallValue();
    });
    listen(dep, 'click', () => {
      arrival = false;
      sync();
    });
    listen(arr, 'click', () => {
      arrival = true;
      sync();
    });
    listen(planBtn, 'click', plan);
    listen(clearBtn, 'click', () => onClear());
    listen(list, 'click', (event) => {
      const item = event.target?.closest?.('[data-option]');
      if (item) onSelect(Number(item.dataset.option));
    });
    installDrag(head);
    restorePosition();
    sync();
  }

  function installDrag(handle) {
    let start = null;
    listen(handle, 'pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = root.getBoundingClientRect();
      start = {
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
      };
      handle.setPointerCapture?.(event.pointerId);
    });
    listen(handle, 'pointermove', (event) => {
      if (!start) return;
      place(
        start.left + event.clientX - start.x,
        start.top + event.clientY - start.y,
      );
    });
    const end = () => {
      if (!start) return;
      start = null;
      const rect = root.getBoundingClientRect();
      safeStorage(
        false,
        POSITION_KEY,
        JSON.stringify({ left: rect.left, top: rect.top }),
      );
    };
    listen(handle, 'pointerup', end);
    listen(handle, 'pointercancel', end);
  }

  function place(left, top) {
    const w = doc.defaultView?.innerWidth || 1280;
    const h = doc.defaultView?.innerHeight || 800;
    const x = Math.min(Math.max(8, left), Math.max(8, w - 120));
    const y = Math.min(Math.max(8, top), Math.max(8, h - 60));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
  }

  function restorePosition() {
    let saved = null;
    try {
      saved = JSON.parse(safeStorage(true, POSITION_KEY) || 'null');
    } catch {
      saved = null;
    }
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top))
      place(saved.left, saved.top);
    else {
      // Right-hand side, below the DISPLAY/CCTV/CONTEXT column — the Data
      // Layers panel owns the left edge.
      const w = doc.defaultView?.innerWidth || 1280;
      place(w - 360, 290);
    }
  }

  function sync() {
    if (!root) return;
    refs.dep.classList.toggle('on', !arrival);
    refs.arr.classList.toggle('on', arrival);
    const ready = Boolean(
      fromStation && toStation && fromStation.code !== toStation.code,
    );
    refs.planBtn.disabled = !ready || busy;
    refs.planBtn.textContent = busy ? 'PLANNEN…' : 'PLAN';
    refs.clearBtn.disabled = options.length === 0;
  }

  function plan() {
    if (busy) return;
    if (!fromStation || !toStation) {
      setStatus('error', 'Kies eerst een VAN- en NAAR-station uit de lijst.');
      return;
    }
    if (fromStation.code === toStation.code) {
      setStatus('error', 'VAN en NAAR zijn hetzelfde station.');
      return;
    }
    onPlan({
      from: fromStation,
      to: toStation,
      wall: refs.when.value,
      arrival,
    });
  }

  function setStatus(kind, text) {
    if (!root) return;
    refs.status.className = `rail-status${kind ? ` ${kind}` : ''}`;
    refs.status.textContent = text || '';
  }

  function trackNode(endpoint) {
    const wrap = el(doc, 'span');
    if (trackChanged(endpoint)) {
      wrap.append(
        el(doc, 'span', 'rail-old', endpoint.plannedTrack),
        el(doc, 'span', 'rail-new', endpoint.track),
      );
    } else wrap.textContent = endpoint.track || '?';
    return wrap;
  }

  function endpointLine(prefix, endpoint) {
    const line = el(doc, 'div', 'rail-leg-line');
    line.append(`${prefix} ${hhmm(endpoint.planned)}`);
    const delay = formatDelay(endpoint.delayMin);
    if (delay) line.append(el(doc, 'span', 'rail-delay', delay));
    line.append(` ${endpoint.name} · spoor `, trackNode(endpoint));
    return line;
  }

  function legsNode(option, index) {
    const box = el(doc, 'div', 'rail-legs');
    option.legs.forEach((leg, i) => {
      const block = el(doc, 'div', 'rail-leg');
      const head = el(doc, 'div', 'rail-leg-head');
      const dot = el(doc, 'span', 'rail-leg-dot');
      dot.style.background = RAIL_LEG_COLORS[i % RAIL_LEG_COLORS.length];
      head.append(
        dot,
        leg.walking
          ? formatLeg(leg)
          : `${leg.productLong || leg.product}${leg.number ? ` ${leg.number}` : ''}${leg.direction ? ` richting ${leg.direction}` : ''}`,
      );
      if (leg.cancelled)
        head.append(' ', el(doc, 'span', 'rail-tag red', 'UITGEVALLEN'));
      block.append(
        head,
        endpointLine('vertrek', leg.from),
        endpointLine('aankomst', leg.to),
      );
      box.append(block);
      const transfer = option.transfersDetail[i];
      if (transfer)
        box.append(
          el(
            doc,
            'div',
            'rail-xfer',
            `⇄ overstap ${formatTransferLabel(transfer)}`,
          ),
        );
    });
    const note = notes.get(index);
    if (note) box.append(el(doc, 'div', 'rail-note', note));
    return box;
  }

  function renderOptions() {
    if (!root) return;
    refs.list.replaceChildren(
      ...options.map((option, index) => {
        const item = el(doc, 'li', 'rail-opt');
        item.dataset.option = String(index);
        item.classList.toggle('sel', index === selected);
        item.classList.toggle('cancelled', option.cancelled);
        const sum = el(doc, 'div', 'rail-opt-sum');
        const left = el(doc, 'span');
        left.append(
          el(
            doc,
            'b',
            '',
            `${hhmm(option.departure.planned)} → ${hhmm(option.arrival.planned)}`,
          ),
        );
        const depDelay = formatDelay(
          Math.max(option.departure.delayMin, option.arrival.delayMin),
        );
        if (depDelay) left.append(el(doc, 'span', 'rail-delay', depDelay));
        left.append(
          ` · ${formatDuration(option.durationMin)} · ${option.transfers ? `${option.transfers}× over` : 'direct'}`,
        );
        const right = el(doc, 'span');
        if (option.cancelled)
          right.append(el(doc, 'span', 'rail-tag red', 'UITGEVALLEN'));
        else if (
          option.legs.some((l) => trackChanged(l.from) || trackChanged(l.to))
        )
          right.append(el(doc, 'span', 'rail-tag amber', 'SPOOR GEWIJZIGD'));
        else right.append(`spoor ${option.departure.track || '?'}`);
        sum.append(left, right);
        sum.title = formatOptionSummary(option);
        item.append(sum);
        if (index === selected) item.append(legsNode(option, index));
        return item;
      }),
    );
    sync();
  }

  function setVisible(visible) {
    if (!root) return;
    root.hidden = !visible;
    onVisibility(Boolean(visible));
  }

  return {
    mount() {
      if (!root) build();
      setVisible(true);
    },
    isVisible: () => Boolean(root && !root.hidden),
    setVisible,
    setBusy(value) {
      busy = Boolean(value);
      sync();
    },
    setStatus,
    setStation(which, station) {
      if (!root || !station) return;
      if (which === 'from') {
        fromStation = station;
        refs.from.value = station.name;
      } else {
        toStation = station;
        refs.to.value = station.name;
      }
      sync();
    },
    restoreStations(byCode) {
      if (!root) return;
      const from = byCode.get(safeStorage(true, 'gev.rail.from') || '');
      const to = byCode.get(safeStorage(true, 'gev.rail.to') || '');
      if (from && !fromStation) this.setStation('from', from);
      if (to && !toStation) this.setStation('to', to);
    },
    setOptions(next, nextSelected, nextNotes = new Map()) {
      options = Array.isArray(next) ? next : [];
      selected = nextSelected;
      notes = nextNotes;
      renderOptions();
    },
    setSelected(index) {
      selected = index;
      renderOptions();
    },
    destroy() {
      for (const remove of removers) remove();
      removers = [];
      root?.remove();
      root = null;
      refs = {};
    },
  };
}

/**
 * Small "VAN hier / NAAR hier" popup next to a clicked station.
 * @returns {{show: (station: object, x: number, y: number) => void, hide: () => void, destroy: () => void}}
 */
export function createRailStationPopup({ documentRef, onChoose }) {
  const doc = documentRef;
  let node = null;
  const onDocDown = (event) => {
    if (node && !node.contains(event.target)) hide();
  };
  function hide() {
    node?.remove();
    node = null;
    doc.removeEventListener('pointerdown', onDocDown, true);
  }
  function show(station, x, y) {
    hide();
    node = el(doc, 'div', 'rail-popup');
    node.append(el(doc, 'b', '', `🚆 ${station.name} (${station.code})`));
    for (const [which, label] of [
      ['from', 'VAN hier'],
      ['to', 'NAAR hier'],
    ]) {
      const button = el(doc, 'button', 'rail-btn', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        hide();
        onChoose(which, station);
      });
      node.append(button);
    }
    const w = doc.defaultView?.innerWidth || 1280;
    node.style.left = `${Math.min(x + 12, w - 220)}px`;
    node.style.top = `${Math.max(8, y - 16)}px`;
    doc.body.appendChild(node);
    setTimeout(() => doc.addEventListener('pointerdown', onDocDown, true), 0);
  }
  return { show, hide, destroy: hide };
}
