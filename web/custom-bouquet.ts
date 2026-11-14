// Bloomy — Custom bouquet builder ("Bó hoa tùy chỉnh").
// Everything the page knows comes from the server: GET /api/flowers gives the
// flowers (price per stem, in stock yes/no), the wrap styles with their fees and
// the limits; POST /api/orders/quote prices the bouquet exactly as an order
// would be. This page does no money maths and types no limit of its own.
// All server text goes in with textContent.

import type { BuilderFlower, CustomStyle, FlowersBody, QuoteLine } from "../shared/api-types";
import { MAX_QUANTITY } from "../shared/rules";
import { byId, el } from "./lib/dom";

const BUILDER_QUOTE_DELAY_MS = 300;

interface FlowerRowRef { row: HTMLElement; count: HTMLElement; minus: HTMLButtonElement; plus: HTMLButtonElement }

let builderData: FlowersBody | null = null; // { flowers, styles, limits }
const builderStems = new Map<number, number>(); // flowerId -> stems chosen
const builderRows = new Map<number, FlowerRowRef>(); // flowerId -> its row and buttons
let builderStyle: CustomStyle | null = null; // style key
let builderQuantity = 1;
let builderLine: QuoteLine | null = null; // the quote line for the current selection (null = nothing to price)
let builderSeq = 0;
let builderTimer: number | undefined;
let builderPricing = false;

// The server's data; it is set before anything on the page can use it.
function data(): FlowersBody {
  if (!builderData) throw new Error("The builder has not loaded");
  return builderData;
}

const money = (n: number): string => window.Bloomy.formatVND(n);
const totalStems = (): number => [...builderStems.values()].reduce((sum, n) => sum + n, 0);
function flowerById(id: number): BuilderFlower {
  const flower = data().flowers.find((f) => f.id === id);
  if (!flower) throw new Error(`No flower ${id}`);
  return flower;
}

// ---- the flower list, grouped by family; built once, then updated in place so
// the keyboard focus stays on the button that was pressed.
function buildFlowerList(): void {
  const box = byId("custom-families");
  const families = new Map<string, BuilderFlower[]>();
  data().flowers.forEach((f) => {
    let group = families.get(f.family);
    if (!group) {
      group = [];
      families.set(f.family, group);
    }
    group.push(f);
  });
  families.forEach((flowers, family) => {
    const group = el("div", "custom-family");
    group.appendChild(el("h3", "custom-family__title", family));
    flowers.forEach((f) => {
      const row = el("div", `custom-flower${f.in_stock ? "" : " is-out"}`);
      const info = el("div", "custom-flower__info");
      info.append(el("span", "custom-flower__name", f.name), el("span", "custom-flower__price", `${money(f.price)} / cành`));
      if (!f.in_stock) info.appendChild(el("span", "custom-flower__out", "Tạm hết"));
      const stepper = el("div", "custom-flower__stepper");
      const minus = el("button", null, "−");
      minus.type = "button";
      minus.setAttribute("aria-label", `Bớt một cành ${f.name}`);
      const count = el("span", "custom-flower__count", "0");
      const plus = el("button", null, "+");
      plus.type = "button";
      plus.setAttribute("aria-label", `Thêm một cành ${f.name}`);
      minus.addEventListener("click", () => changeStems(f.id, -1));
      plus.addEventListener("click", () => changeStems(f.id, 1));
      stepper.append(minus, count, plus);
      row.append(info, stepper);
      group.appendChild(row);
      builderRows.set(f.id, { row, count, minus, plus });
    });
    box.appendChild(group);
  });
}

function changeStems(flowerId: number, delta: number): void {
  const next = (builderStems.get(flowerId) || 0) + delta;
  if (next < 0 || (delta > 0 && totalStems() >= data().limits.max_stems)) return;
  if (next === 0) builderStems.delete(flowerId);
  else builderStems.set(flowerId, next);
  onChange();
}

function updateRows(): void {
  const atMax = totalStems() >= data().limits.max_stems;
  data().flowers.forEach((f) => {
    const ref = builderRows.get(f.id);
    if (!ref) throw new Error(`No row for flower ${f.id}`);
    const n = builderStems.get(f.id) || 0;
    ref.count.textContent = String(n);
    ref.row.classList.toggle("is-picked", n > 0);
    ref.minus.disabled = n === 0;
    ref.plus.disabled = !f.in_stock || atMax;
  });
}

function renderChosen(): void {
  const list = byId("custom-chosen");
  list.innerHTML = "";
  [...builderStems.entries()].forEach(([id, n]) => {
    const li = el("li");
    li.append(el("span", null, flowerById(id).name), el("span", null, `${n} cành`));
    list.appendChild(li);
  });
  byId("custom-empty").hidden = builderStems.size > 0;
  const { min_stems, max_stems } = data().limits;
  byId("custom-count").textContent = `${totalStems()} cành (tối thiểu ${min_stems}, tối đa ${max_stems})`;
}

function buildStyles(): void {
  const box = byId("custom-styles");
  const first = data().styles[0];
  if (!first) throw new Error("The server sent no wrap styles");
  builderStyle = first.key;
  data().styles.forEach((s) => {
    const label = el("label", "custom-style");
    const input = el("input");
    input.type = "radio";
    input.name = "custom-style";
    input.value = s.key;
    input.checked = s.key === builderStyle;
    input.addEventListener("change", () => {
      builderStyle = s.key;
      onChange();
    });
    label.append(input, el("span", null, `${s.label} · +${money(s.fee)}`));
    box.appendChild(label);
  });
}

// ---- pricing: the server prices it, we only show the answer
function onChange(): void {
  updateRows();
  renderChosen();
  byId("custom-added").hidden = true;
  clearTimeout(builderTimer);
  builderLine = null;
  if (totalStems() < data().limits.min_stems) {
    builderPricing = false;
    renderPrice();
    return;
  }
  builderPricing = true;
  renderPrice();
  builderTimer = setTimeout(requestQuote, BUILDER_QUOTE_DELAY_MS);
}

async function requestQuote(): Promise<void> {
  const seq = ++builderSeq;
  try {
    if (!builderStyle) throw new Error("No wrap style is chosen");
    const result = await window.Bloomy.quoteItems([
      {
        custom: {
          flowers: [...builderStems.entries()].map(([flowerId, stems]) => ({ flowerId, stems })),
          style: builderStyle,
          note: byId("custom-note", HTMLTextAreaElement).value.trim() || null,
        },
        quantity: builderQuantity,
      },
    ]);
    if (seq !== builderSeq) return; // a newer change is already on its way
    builderLine = result.lines[0] ?? null;
    byId("custom-error").hidden = true;
  } catch (err) {
    if (seq !== builderSeq) return;
    builderLine = null;
    byId("custom-error").textContent = "Không tính được giá. Vui lòng thử lại.";
    byId("custom-error").hidden = false;
  }
  builderPricing = false;
  renderPrice();
}

function renderPrice(): void {
  const line = builderLine;
  // The line, when it can be sold (no problem); null otherwise.
  const priced = line && !line.problem ? line : null;
  const style = data().styles.find((s) => s.key === builderStyle);
  if (!style) throw new Error("The chosen wrap style is not in the list");
  byId("custom-style-label").textContent = `Kiểu gói: ${style.label}`;
  byId("custom-flowers-total").textContent = priced ? money(priced.unitPrice - (priced.style_fee ?? 0)) : "—";
  byId("custom-style-fee").textContent = priced ? money(priced.style_fee ?? 0) : "—";
  byId("custom-unit").textContent = priced ? money(priced.unitPrice) : "—";
  byId("custom-line-label").textContent = `Tạm tính (${builderQuantity} bó)`;
  byId("custom-line-total").textContent = priced ? money(priced.lineTotal) : "—";
  byId("custom-qty").textContent = String(builderQuantity);

  const { min_stems } = data().limits;
  let message = "";
  if (totalStems() > 0 && totalStems() < min_stems) message = `Chọn tối thiểu ${min_stems} cành.`;
  else if (priced && priced.short_flowers.length > 0) message = `Bloomy tạm thiếu hoa: ${priced.short_flowers.join(", ")}. Hãy bớt số cành hoặc chọn loại khác.`;
  else if (line && line.problem) message = "Bó hoa chưa hợp lệ. Vui lòng kiểm tra lại số cành.";
  byId("custom-message").textContent = message;
  byId("custom-message").hidden = !message;

  byId("custom-add", HTMLButtonElement).disabled = builderPricing || !priced || priced.short_flowers.length > 0;
}

function addToCart(): void {
  if (!builderStyle) throw new Error("No wrap style is chosen");
  window.Bloomy.cart.addCustomItem(
    {
      flowers: [...builderStems.entries()].map(([flowerId, stems]) => ({ flowerId, name: flowerById(flowerId).name, stems })),
      style: builderStyle,
      note: byId("custom-note", HTMLTextAreaElement).value,
    },
    builderQuantity
  );
  byId("custom-added").hidden = false;
  window.Bloomy.toast?.("Đã thêm bó hoa tự chọn vào giỏ", [
    { label: "Xem giỏ hàng", href: "cart.html" },
    { label: "Thanh toán", href: "checkout.html" },
  ]);
}

function changeQuantity(delta: number): void {
  const next = Math.min(MAX_QUANTITY, Math.max(1, builderQuantity + delta));
  if (next === builderQuantity) return;
  builderQuantity = next;
  onChange();
}

async function initBuilder(): Promise<void> {
  try {
    const res = await fetch("/api/flowers");
    if (!res.ok) throw new Error(`flowers: ${res.status}`);
    builderData = await res.json();
    buildFlowerList();
    buildStyles();
    const note = byId("custom-note", HTMLTextAreaElement);
    note.maxLength = data().limits.note_max;
    const noteCount = () => {
      byId("custom-note-count").textContent = `${note.value.length}/${data().limits.note_max}`;
    };
    note.addEventListener("input", () => {
      noteCount();
      onChange();
    });
    noteCount();
    byId("custom-qty-minus").addEventListener("click", () => changeQuantity(-1));
    byId("custom-qty-plus").addEventListener("click", () => changeQuantity(1));
    byId("custom-add").addEventListener("click", addToCart);
    onChange();
  } catch (err) {
    console.error("Bloomy: builder failed to load", err);
    byId("custom-error").textContent = "Không tải được danh sách hoa. Vui lòng tải lại trang.";
    byId("custom-error").hidden = false;
  } finally {
    document.body.classList.add("is-ready");
  }
}

document.addEventListener("DOMContentLoaded", initBuilder);
