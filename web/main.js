// "Write lamp": blinks in the top strip when an agent writes outside (MR/PR, push, infrastructure, a database, an MCP
// with writes). Only a signal: it does not stop the agents. The source is the session feeds (/api/timeline, as the page
// uses): the live snapshot does not carry the feeds, only their revisions (timeline_rev); the plugin fetches the changed
// ones itself. A step shows up when it is announced, not after its result; the lamp goes out 30 s after the step ends,
// the history keeps a day.
import { classify } from "./classify.js";

const AFTER = 30, DAY = 86400;
const ended = new Map();          // step id → when we saw it end (time on this page)
let open = false, hist = false;   // "Last 24 hours" is folded by default
// session → {epoch, rev, items, busy}; items are only the write steps (classify), not the whole feed: the lamp used to
// hold up to 300 steps of each session and parse them all again on every snapshot (half of the page memory and ~1 s
// out of 30 on 57 sessions)
const tl = {};
const hits = new WeakMap();       // step → classify(step); an edited step comes as a new object and is parsed again
const hitOf = (st) => { let h = hits.get(st); if (h === undefined) hits.set(st, h = classify(st)); return h; };
let redraw = () => {};
// at most PULLS feed requests at once: the browser has six connections to the hub, and the first snapshot used to call
// all sessions at once, so the open session's feed (the same /api/timeline) waited in the queue behind them
const PULLS = 2, queue = [];
let pulling = 0, snapNow = null;

// UI strings: English by default, Russian when the page language is Russian (hub.lang, Plugin API 1.25)
const RU_PLURAL = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const STR = {
  en: {
    s: "s", min: "min", h: "h", asks: "waits for approval", done: (t) => `done · ${t} ago`,
    title: "Agents writing outside: who and what", count: (n) => `${n} ${n === 1 ? "write" : "writes"}`,
    none: "no writes", max: "99 writes", head: "Writing outside now", nobody: "nobody right now",
    day: (n) => `Last 24 hours · ${n}`, foot: "click a row to open the session · only a signal, the agents are not stopped",
    kinds: {},
  },
  ru: {
    s: "с", min: "мин", h: "ч", asks: "ждёт подтверждения", done: (t) => `готово · ${t} назад`,
    title: "Агенты пишут наружу — кто и что", count: (n) => `${n} ${RU_PLURAL(n, "запись", "записи", "записей")}`,
    none: "записей нет", max: "99 записей", head: "Сейчас пишут наружу", nobody: "сейчас — никто",
    day: (n) => `За сутки · ${n}`, foot: "клик по строке — открыть сессию · только сигнал, агенты не останавливаются",
    kinds: { DB: "БД" },
  },
};
let L = STR.en;

function pull(name, snap) {
  const want = (snap.timeline_rev || {})[name] || 0, t = tl[name] || (tl[name] = { epoch: null, rev: 0, items: [] });
  if (t.busy || (t.epoch === snap.epoch && t.rev >= want)) return;
  t.busy = true;
  queue.push(name);
  next();
}
function next() {
  while (pulling < PULLS && queue.length) {
    pulling++;
    load(queue.shift()).finally(() => { pulling--; next(); });
  }
}
async function load(name) {
  const t = tl[name];
  try {
    const since = t.epoch === snapNow?.epoch ? t.rev : 0;
    const q = new URLSearchParams({ session: name, since: String(since), epoch: t.epoch || "" });
    const r = await (await fetch(`/api/timeline?${q}`)).json();
    const mine = r.items.filter((x) => x.kind === "tool" && hitOf(x));
    if (r.full) t.items = mine.slice(-300);
    else {
      const at = new Map(t.items.map((x, i) => [x.k, i]));
      for (const x of mine) at.has(x.k) ? (t.items[at.get(x.k)] = x) : t.items.push(x);
      t.items = t.items.slice(-300);
    }
    t.epoch = r.epoch; t.rev = r.rev;
    redraw();
  } catch { /* network: with the next snapshot */ } finally { t.busy = false; }
}

const ago = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} ${L.s}` : s < 3600 ? `${Math.round(s / 60)} ${L.min}` : `${Math.round(s / 3600)} ${L.h}`);

function scan(snap) {
  const now = Date.now() / 1000, live = [], day = [];
  const sessions = new Map((snap.sessions || []).map((s) => [s.name, s]));
  snapNow = snap;
  for (const name of Object.keys(snap.timeline_rev || {})) {
    // free or asleep for more than a day: it has no steps in the last day (steps happen only in a turn), skip its feed
    const s = sessions.get(name);
    if (!tl[name] && s && ["idle", "asleep", "failed", "closed"].includes(s.state) && now - (s.since || now) > DAY) continue;
    pull(name, snap);
  }
  for (const [name, { items }] of Object.entries(tl)) {
    if (!sessions.has(name)) continue;
    for (const st of items || []) {
      if (st.kind !== "tool" || now - (st.ts || 0) > DAY) continue;
      const hit = hitOf(st);
      if (!hit) continue;
      const running = st.status === "running" || st.status == null && st.result == null;
      if (!running && !ended.has(st.id)) ended.set(st.id, Math.min(now, (st.ts || now) + AFTER));   // ended before loading: by its start
      const sess = sessions.get(name) || {};
      const asks = (sess.pending || []).some((p) => JSON.stringify(p).includes(st.id)) || sess.state === "dialog";
      const rec = { ...hit, id: st.id, session: name, ts: st.ts || now, running, asks: running && asks, end: ended.get(st.id) };
      day.push(rec);
      if (running || now - rec.end < AFTER) live.push(rec);
    }
  }
  const byTs = (a, b) => b.ts - a.ts;
  return { live: live.sort(byTs), day: day.sort(byTs) };
}

function line(hub, r, now) {
  const it = hub.el("button", "wlamp-it");
  it.type = "button";
  it.append(hub.el("span", `wlamp-k${r.danger ? " danger" : ""}`, L.kinds[r.kind] || r.kind));
  it.append(hub.el("b", null, `${r.session}${r.where ? " → " + r.where : ""}`));
  const state = r.asks ? L.asks : r.running ? ago(now - r.ts) : L.done(ago(now - (r.end || r.ts)));
  it.append(hub.el("span", "wlamp-w", `${r.what.slice(0, 140)} · ${state}`));
  it.title = r.what;
  it.addEventListener("click", () => { open = false; location.hash = `#/s/${encodeURIComponent(r.session)}`; });
  return it;
}

export default function register(hub) {
  L = hub.lang === "ru" ? STR.ru : STR.en;
  hub.addStyle("web/style.css");
  let last = null, tick = null, hintW = 0, lampW = 0, lampH = 0;
  // the place: where there is an input field, in it, left of the paperclip, always (not only when the header is
  // crowded); where there is no field ("Flow", plugin views), in the view's title bar, in its widest empty gap near the
  // right edge; if it does not fit, above the bottom edge of the column. Measured from the feed column (main): on the
  // left the session list has a variable width
  const place = (root) => {
    const main = document.querySelector("main"), m = main?.getBoundingClientRect();
    if (!m) return;
    // in the input field the lamp sits over the end of the line, so the field text does not reach it (right padding of its width)
    const pad = (px) => main.style.setProperty("--wlamp-pad", `${px}px`);
    if (!root.firstElementChild) return pad(0);
    // the width is the last non-zero one: while the slot is redrawn the lamp may not be laid out yet (0 → the default
    // 140), and the field padding jumped by 28px once a second, so the text in the field jumped between lines
    const lamp = root.firstElementChild, lw = lamp?.getBoundingClientRect().width;
    if (lw) lampW = lw;
    const w = lampW || 140, lh = lamp?.offsetHeight || lampH || 20;
    if (lamp?.offsetHeight) lampH = lamp.offsetHeight;
    let clip = main.querySelector(".composer .attach, .attach")?.getBoundingClientRect();
    // left of the "Ctrl I" hint at the paperclip (visible while the field has no focus): the room for it is kept with
    // focus too, so the lamp does not jump (it used to overlap that element)
    const hk = main.querySelector(".composer .kbd-hint")?.getBoundingClientRect();
    if (hk?.width && clip?.width) hintW = clip.left - hk.left;
    if (clip?.width && main.querySelector(".composer .kbd-hint"))
      clip = { left: clip.left - hintW, bottom: clip.bottom, height: clip.height, width: clip.width };
    let bar = null, gap = null;
    if (!clip?.width) {
      bar = main.querySelector(":scope > .head") || main.querySelector(":scope > .ext-view > * > :first-child");
      const r = bar?.getBoundingClientRect();
      if (r?.width && r.height < 90) {   // the widest gap between the row's elements where the lamp fits
        const xs = [...bar.querySelectorAll("*")].filter((x) => !x.children.length).map((x) => x.getBoundingClientRect())
          .filter((x) => x.width).sort((a, b) => a.left - b.left);
        let edge = r.left;
        for (const x of [...xs, { left: r.right - 4, right: r.right }]) {
          if (x.left - edge >= w + 32 && (!gap || x.left - edge > gap[1] - gap[0])) gap = [edge, x.left];
          edge = Math.max(edge, x.right);
        }
      }
      if (!gap) bar = null;
    }
    root.dataset.pos = bar ? "top" : "bottom";
    pad(!bar && clip?.width ? Math.round(w + 12 + (main.querySelector(".composer .kbd-hint") ? hintW : 0)) : 0);
    if (bar) {
      const r = bar.getBoundingClientRect();
      root.style.setProperty("--wlamp-x", `${Math.round(gap[1] - 16)}px`);   // at the right edge of the gap
      root.style.setProperty("--wlamp-y", `${Math.round(r.top + r.height / 2)}px`);
    } else if (clip?.width) {
      root.style.setProperty("--wlamp-r", `${Math.round(innerWidth - clip.left + 8)}px`);
      root.style.setProperty("--wlamp-b", `${Math.round(innerHeight - clip.bottom + (clip.height - lh) / 2)}px`);
    } else {
      const d = main.querySelector(":scope > .dock")?.getBoundingClientRect();
      root.style.setProperty("--wlamp-r", `${Math.round(innerWidth - m.right + 24)}px`);
      root.style.setProperty("--wlamp-b", `${Math.round(innerHeight - (d ? d.top : m.bottom) + 10)}px`);
    }
  };
  window.addEventListener("resize", () => last && place(last[0]));
  for (const ev of ["focusin", "focusout"]) document.addEventListener(ev, () => last && setTimeout(() => place(last[0])));
  const draw = (root, snap) => {
    const { live, day } = scan(snap), now = Date.now() / 1000;
    place(root);
    root.classList.toggle("on", live.length > 0);
    // go out after 30 s and update "N s" without a new snapshot: once a second while lit or while the list is open
    clearTimeout(tick);
    if (live.length || open) tick = setTimeout(() => last && draw(...last), 1000);
    // the lamp is always visible: while nobody writes it is dim and does not blink, a click shows the last day's history
    // (better a steady lamp than one that disappears when there is nothing)
    // the lamp is the same button, only its text changes: a new button once a second restarted the blinking and
    // replaced the element under the mouse
    let lamp = root.querySelector(":scope > .wlamp");
    if (!lamp) {
      lamp = hub.el("button", "wlamp");
      lamp.type = "button";
      const n = hub.el("span", "wlamp-n");
      // the longest captions in the same cell keep the lamp one size in every state (web/style.css)
      n.dataset.max = L.max;
      n.dataset.none = L.none;
      n.append(hub.el("span", "wlamp-t"));
      lamp.append(hub.el("i"), n);
      lamp.title = L.title;
      lamp.addEventListener("click", (e) => { e.stopPropagation(); open = !open; if (last) draw(...last); });
    }
    lamp.className = `wlamp${!live.length ? " idle" : live.some((r) => r.danger) ? " danger" : ""}`;
    lamp.setAttribute("aria-expanded", String(open));
    const txt = live.length ? L.count(live.length) : L.none, n = lamp.querySelector(".wlamp-t");
    if (n.textContent !== txt) n.textContent = txt;
    const nodes = [lamp];
    if (open) {
      const pop = hub.el("div", "wlamp-pop");
      pop.addEventListener("click", (e) => e.stopPropagation());
      pop.append(hub.el("b", "wlamp-h", L.head));
      if (!live.length) pop.append(hub.el("div", "wlamp-f", L.nobody));
      for (const r of live) pop.append(line(hub, r, now));
      const old = day.filter((r) => !live.includes(r)).slice(0, 15);
      if (old.length) {
        const t = hub.el("button", "wlamp-h wlamp-hist", `${hist ? "▾" : "▸"} ${L.day(old.length)}`);
        t.type = "button";
        t.setAttribute("aria-expanded", String(hist));
        t.addEventListener("click", (e) => { e.stopPropagation(); hist = !hist; draw(root, snap); });
        pop.append(t);
        if (hist) for (const r of old) pop.append(line(hub, r, now));
      }
      pop.append(hub.el("div", "wlamp-f", L.foot));
      nodes.push(pop);
    }
    if (root.firstElementChild !== lamp) root.replaceChildren(...nodes);
    else { while (lamp.nextSibling) lamp.nextSibling.remove(); root.append(...nodes.slice(1)); }
    place(root);   // by the size of the lamp already drawn
  };
  document.addEventListener("click", () => { if (open) { open = false; if (last) draw(...last); } });
  // a feed arrived: redraw once per frame, not on every answer (the first snapshot brings dozens of answers in a row)
  let frame = 0;
  redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (last) draw(...last); }); };
  hub.addSlot("topbar", {
    id: "write-lamp",
    order: 100,
    render(root, snap) {
      last = [root, snap];
      draw(root, snap);
    },
  });
}
