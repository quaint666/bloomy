// Bloomy — Custom bouquet builder ("Bó hoa tùy chỉnh").
// Everything the page knows comes from the server: GET /api/flowers gives the
// flowers (price per stem, in stock yes/no), the wrap styles with their fees and
// the limits; POST /api/orders/quote prices the bouquet exactly as an order
// would be. This page does no money maths and types no limit of its own.
// All server text goes in with textContent.

const BUILDER_QUOTE_DELAY_MS = 300;

let builderData = null; // { flowers, styles, limits }
const builderStems = new Map(); // flowerId -> stems chosen
const builderRows = new Map(); // flowerId -> { row, count, minus, plus }
let builderStyle = null; // style key
let builderQuantity = 1;
let builderLine = null; // the quote line for the current selection (null = nothing to price)
let builderSeq = 0;
let builderTimer = null;
let builderPricing = false;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const money = (n) => window.Bloomy.formatVND(n);
const totalStems = () => [...builderStems.values()].reduce((sum, n) => sum + n, 0);
const flowerById = (id) => builderData.flowers.find((f) => f.id === id);

// ---- the flower list, grouped by family; built once, then updated in place so
// the keyboard focus stays on the button that was pressed.
function buildFlowerList() {
  const box = $("custom-families");
  const families = new Map();
  builderData.flowers.forEach((f) => {
    if (!families.has(f.family)) families.set(f.family, []);
    families.get(f.family).push(f);
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

function changeStems(flowerId, delta) {
  const next = (builderStems.get(flowerId) || 0) + delta;
  if (next < 0 || (delta > 0 && totalStems() >= builderData.limits.max_stems)) return;
  if (next === 0) builderStems.delete(flowerId);
  else builderStems.set(flowerId, next);
  onChange();
}

function updateRows() {
  const atMax = totalStems() >= builderData.limits.max_stems;
  builderData.flowers.forEach((f) => {
    const ref = builderRows.get(f.id);
    const n = builderStems.get(f.id) || 0;
    ref.count.textContent = String(n);
    ref.row.classList.toggle("is-picked", n > 0);
    ref.minus.disabled = n === 0;
    ref.plus.disabled = !f.in_stock || atMax;
  });
}

function renderChosen() {
  const list = $("custom-chosen");
  list.innerHTML = "";
  [...builderStems.entries()].forEach(([id, n]) => {
    const li = el("li");
    li.append(el("span", null, flowerById(id).name), el("span", null, `${n} cành`));
    list.appendChild(li);
  });
  $("custom-empty").hidden = builderStems.size > 0;
  const { min_stems, max_stems } = builderData.limits;
  $("custom-count").textContent = `${totalStems()} cành (tối thiểu ${min_stems}, tối đa ${max_stems})`;
}

function buildStyles() {
  const box = $("custom-styles");
  builderStyle = builderData.styles[0].key;
  builderData.styles.forEach((s) => {
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
function onChange() {
  updateRows();
  renderChosen();
  $("custom-added").hidden = true;
  clearTimeout(builderTimer);
  builderLine = null;
  if (totalStems() < builderData.limits.min_stems) {
    builderPricing = false;
    renderPrice();
    return;
  }
  builderPricing = true;
  renderPrice();
  builderTimer = setTimeout(requestQuote, BUILDER_QUOTE_DELAY_MS);
}

async function requestQuote() {
  const seq = ++builderSeq;
  try {
    const result = await window.Bloomy.quoteItems([
      {
        custom: {
          flowers: [...builderStems.entries()].map(([flowerId, stems]) => ({ flowerId, stems })),
          style: builderStyle,
          note: $("custom-note").value.trim() || null,
        },
        quantity: builderQuantity,
      },
    ]);
    if (seq !== builderSeq) return; // a newer change is already on its way
    builderLine = result.lines[0];
    $("custom-error").hidden = true;
  } catch (err) {
    if (seq !== builderSeq) return;
    builderLine = null;
    $("custom-error").textContent = "Không tính được giá. Vui lòng thử lại.";
    $("custom-error").hidden = false;
  }
  builderPricing = false;
  renderPrice();
}

function renderPrice() {
  const line = builderLine;
  const usable = line && !line.problem;
  const style = builderData.styles.find((s) => s.key === builderStyle);
  $("custom-style-label").textContent = `Kiểu gói: ${style.label}`;
  $("custom-flowers-total").textContent = usable ? money(line.unitPrice - line.style_fee) : "—";
  $("custom-style-fee").textContent = usable ? money(line.style_fee) : "—";
  $("custom-unit").textContent = usable ? money(line.unitPrice) : "—";
  $("custom-line-label").textContent = `Tạm tính (${builderQuantity} bó)`;
  $("custom-line-total").textContent = usable ? money(line.lineTotal) : "—";
  $("custom-qty").textContent = String(builderQuantity);

  const { min_stems } = builderData.limits;
  let message = "";
  if (totalStems() > 0 && totalStems() < min_stems) message = `Chọn tối thiểu ${min_stems} cành.`;
  else if (usable && line.short_flowers.length > 0) message = `Bloomy tạm thiếu hoa: ${line.short_flowers.join(", ")}. Hãy bớt số cành hoặc chọn loại khác.`;
  else if (line && line.problem) message = "Bó hoa chưa hợp lệ. Vui lòng kiểm tra lại số cành.";
  $("custom-message").textContent = message;
  $("custom-message").hidden = !message;

  $("custom-add").disabled = builderPricing || !usable || line.short_flowers.length > 0;
}

function addToCart() {
  window.Bloomy.cart.addCustomItem(
    {
      flowers: [...builderStems.entries()].map(([flowerId, stems]) => ({ flowerId, name: flowerById(flowerId).name, stems })),
      style: builderStyle,
      note: $("custom-note").value,
    },
    builderQuantity
  );
  $("custom-added").hidden = false;
  window.Bloomy.toast?.("Đã thêm bó hoa tự chọn vào giỏ", [
    { label: "Xem giỏ hàng", href: "cart.html" },
    { label: "Thanh toán", href: "checkout.html" },
  ]);
}

function changeQuantity(delta) {
  const next = Math.min(99, Math.max(1, builderQuantity + delta));
  if (next === builderQuantity) return;
  builderQuantity = next;
  onChange();
}

async function initBuilder() {
  try {
    const res = await fetch("/api/flowers");
    if (!res.ok) throw new Error(`flowers: ${res.status}`);
    builderData = await res.json();
    buildFlowerList();
    buildStyles();
    const note = $("custom-note");
    note.maxLength = builderData.limits.note_max;
    const noteCount = () => {
      $("custom-note-count").textContent = `${note.value.length}/${builderData.limits.note_max}`;
    };
    note.addEventListener("input", () => {
      noteCount();
      onChange();
    });
    noteCount();
    $("custom-qty-minus").addEventListener("click", () => changeQuantity(-1));
    $("custom-qty-plus").addEventListener("click", () => changeQuantity(1));
    $("custom-add").addEventListener("click", addToCart);
    onChange();
  } catch (err) {
    console.error("Bloomy: builder failed to load", err);
    $("custom-error").textContent = "Không tải được danh sách hoa. Vui lòng tải lại trang.";
    $("custom-error").hidden = false;
  } finally {
    document.body.classList.add("is-ready");
  }
}

document.addEventListener("DOMContentLoaded", initBuilder);
