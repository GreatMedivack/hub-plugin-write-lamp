// «Лампа записи»: мигает в верхней полосе, когда агент пишет наружу (MR/PR, push, инфраструктура, база, MCP с записью).
// Только сигнал — агентов не останавливает. Источник — ленты сессий (/api/timeline, как у страницы): живой снимок ленты
// не везёт, только их правки (timeline_rev); плагин дотягивает изменившиеся сам. Шаг виден в момент, когда объявлен, а не
// после результата; лампа гаснет через 30 с после конца шага, в истории — сутки.
import { classify } from "./classify.js";

const AFTER = 30, DAY = 86400;
const ended = new Map();          // id шага → когда мы увидели его конец (время на этой странице)
let open = false, hist = false;   // «За сутки» — свёрнуто по умолчанию (владелец 07.10)
const tl = {};                    // сессия → {epoch, rev, items, busy}
let redraw = () => {};

async function pull(name, snap) {
  const want = (snap.timeline_rev || {})[name] || 0, t = tl[name] || (tl[name] = { epoch: null, rev: 0, items: [] });
  if (t.busy || (t.epoch === snap.epoch && t.rev >= want)) return;
  t.busy = true;
  try {
    const since = t.epoch === snap.epoch ? t.rev : 0;
    const q = new URLSearchParams({ session: name, since: String(since), epoch: t.epoch || "" });
    const r = await (await fetch(`/api/timeline?${q}`)).json();
    if (r.full) t.items = r.items.filter((x) => x.kind === "tool");
    else {
      const at = new Map(t.items.map((x, i) => [x.k, i]));
      for (const x of r.items) if (x.kind === "tool") at.has(x.k) ? (t.items[at.get(x.k)] = x) : t.items.push(x);
      t.items = t.items.slice(-300);
    }
    t.epoch = r.epoch; t.rev = r.rev;
    redraw();
  } catch { /* сеть — со следующим снимком */ } finally { t.busy = false; }
}

const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const ago = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`);

function scan(snap) {
  const now = Date.now() / 1000, live = [], day = [];
  const sessions = new Map((snap.sessions || []).map((s) => [s.name, s]));
  for (const name of Object.keys(snap.timeline_rev || {})) pull(name, snap);
  for (const [name, { items }] of Object.entries(tl)) {
    if (!sessions.has(name)) continue;
    for (const st of items || []) {
      if (st.kind !== "tool" || now - (st.ts || 0) > DAY) continue;
      const hit = classify(st);
      if (!hit) continue;
      const running = st.status === "running" || st.status == null && st.result == null;
      if (!running && !ended.has(st.id)) ended.set(st.id, Math.min(now, (st.ts || now) + AFTER));   // конец до загрузки — по старту
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
  it.append(hub.el("span", `wlamp-k${r.danger ? " danger" : ""}`, r.kind));
  it.append(hub.el("b", null, `${r.session}${r.where ? " → " + r.where : ""}`));
  const state = r.asks ? "ждёт подтверждения" : r.running ? ago(now - r.ts) : `готово · ${ago(now - (r.end || r.ts))} назад`;
  it.append(hub.el("span", "wlamp-w", `${r.what.slice(0, 140)} · ${state}`));
  it.title = r.what;
  it.addEventListener("click", () => { open = false; location.hash = `#/s/${encodeURIComponent(r.session)}`; });
  return it;
}

export default function register(hub) {
  hub.addStyle("web/style.css");
  let last = null, tick = null;
  // место: «top» — по центру строки шапки (на одной линии с её кнопками), «bottom» — справа внизу над полем ввода.
  // Считается от колонки с лентой (main): слева список сессий переменной ширины
  const place = (root) => {
    const main = document.querySelector("main"), head = main?.querySelector(":scope > .head"), dock = main?.querySelector(":scope > .dock");
    const m = main?.getBoundingClientRect();
    if (!m) return;
    const pos = localStorage.getItem("wlamp.pos") === "bottom" ? "bottom" : "top";
    // сверху — в пустом промежутке шапки между её левой частью (имя, состояние, плашки) и правой (кнопки), чтобы не
    // закрыть ничего; промежутка не хватает (узкое окно, длинные плашки) — справа внизу
    let gap = null;
    if (pos === "top" && head) {
      const kids = [...head.children].filter((c) => c.offsetParent !== null);
      const spacer = kids.findIndex((c) => c.classList.contains("spacer"));
      const leaves = (els) => els.flatMap((c) => c.children.length ? [...c.querySelectorAll("*")].filter((x) => !x.children.length) : [c])
        .map((x) => x.getBoundingClientRect()).filter((r) => r.width);
      const left = leaves(spacer >= 0 ? kids.slice(0, spacer) : []), right = leaves(spacer >= 0 ? kids.slice(spacer + 1) : []);
      const a = Math.max(m.left, ...left.map((r) => r.right)), b = Math.min(m.right, ...right.map((r) => r.left));
      const need = (root.firstElementChild?.getBoundingClientRect().width || 140) + 32;
      if (b - a >= need) gap = [a, b];
    }
    root.dataset.pos = gap || pos === "top" && !head ? "top" : "bottom";
    if (root.dataset.pos === "top") {
      const h = head?.getBoundingClientRect();
      // у правого края промежутка — рядом с «Кратко / Подробно» (владелец 07.10)
      root.style.setProperty("--wlamp-x", `${Math.round(gap ? gap[1] - 12 : m.left + m.width / 2)}px`);
      root.style.setProperty("--wlamp-y", `${Math.round(h ? h.top + h.height / 2 : 30)}px`);
    } else {
      const d = dock?.getBoundingClientRect();
      root.style.setProperty("--wlamp-r", `${Math.round(innerWidth - m.right + 24)}px`);
      root.style.setProperty("--wlamp-b", `${Math.round(innerHeight - (d ? d.top : m.bottom) + 10)}px`);
    }
  };
  window.addEventListener("resize", () => last && place(last[0]));
  const draw = (root, snap) => {
    const { live, day } = scan(snap), now = Date.now() / 1000;
    place(root);
    root.classList.toggle("on", live.length > 0);
    // гаснуть через 30 с и обновлять «N с» — без нового снимка: пока горит или открыт список, раз в секунду
    clearTimeout(tick);
    if (live.length || open) tick = setTimeout(() => last && draw(...last), 1000);
    if (!live.length && !open) { root.replaceChildren(); return; }
    const lamp = hub.el("button", `wlamp${live.some((r) => r.danger) ? " danger" : ""}`);
    lamp.type = "button";
    lamp.setAttribute("aria-expanded", String(open));
    lamp.append(hub.el("i"), hub.el("span", "wlamp-n", live.length ? `${live.length} ${plural(live.length, "запись", "записи", "записей")}` : "записей нет"));
    lamp.title = "Агенты пишут наружу — кто и что";
    lamp.addEventListener("click", (e) => { e.stopPropagation(); open = !open; draw(root, snap); });
    const nodes = [lamp];
    if (open) {
      const pop = hub.el("div", "wlamp-pop");
      pop.addEventListener("click", (e) => e.stopPropagation());
      pop.append(hub.el("b", "wlamp-h", "Сейчас пишут наружу"));
      if (!live.length) pop.append(hub.el("div", "wlamp-f", "сейчас — никто"));
      for (const r of live) pop.append(line(hub, r, now));
      const old = day.filter((r) => !live.includes(r)).slice(0, 15);
      if (old.length) {
        const t = hub.el("button", "wlamp-h wlamp-hist", `${hist ? "▾" : "▸"} За сутки · ${old.length}`);
        t.type = "button";
        t.setAttribute("aria-expanded", String(hist));
        t.addEventListener("click", (e) => { e.stopPropagation(); hist = !hist; draw(root, snap); });
        pop.append(t);
        if (hist) for (const r of old) pop.append(line(hub, r, now));
      }
      pop.append(hub.el("div", "wlamp-f", "клик по строке — открыть сессию · только сигнал, агенты не останавливаются"));
      nodes.push(pop);
    }
    root.replaceChildren(...nodes);
    place(root);   // по размеру уже нарисованной лампы
  };
  document.addEventListener("click", () => { if (open) { open = false; if (last) draw(...last); } });
  redraw = () => { if (last) draw(...last); };
  hub.addSlot("topbar", {
    id: "write-lamp",
    order: 100,
    render(root, snap) {
      last = [root, snap];
      draw(root, snap);
    },
  });
}
