// Bloomy — the one place money is computed.
//
// Cart, Checkout and POST /api/orders all go through quote() below, so the
// number a customer sees and the number an order stores can't drift apart.
// The browser only ever sends WHAT it wants (product, size, quantity, a
// coupon code as text, delivery choices) — never a price or a discount.
//
//   subtotal  = Σ size price × quantity
//   discount  = coupon, applied to goods only (never to shipping)
//   shipping  = ring fee of the ward for delivery, 0 for pickup
//   total     = subtotal − discount + shipping      (all tax-inclusive)
//
// VAT is never added on top: prices already include it. Only the rate is
// returned/stored; the amount is computed for admin views with vatAmount().
//
// `db` is either the pool or a client inside a transaction — both expose
// the same .query().

import type { CouponRow, CouponType, CustomStyle, ProductSize, ProductStatus, Queryable, SizePrice } from "./types";
import type { CouponResult, CouponStatus, LineProblem, QuoteBody, QuoteFlower, QuoteLine } from "./shared/api-types";

// Hand-written to match schema.sql. Nothing checks that a query returns these
// shapes: a type here is an assertion about the SQL, not a proof.

// Rows the queries below return. Money is whole đồng (INTEGER); dates are
// "YYYY-MM-DD" strings (db.js).
interface SettingsRow {
  vat_rate: number; ring1_fee: number; ring2_fee: number; ring3_fee: number;
  style_fee_bo: number; style_fee_gio: number; style_fee_hop: number;
}
interface SizeRow {
  product_id: number; name: string; image: string | null; style: string | null;
  status: ProductStatus; product_type: "standard" | "external";
  size_id: number; size: ProductSize; price: number;
}
interface FlowerRow { id: number; name: string; price: number; stock: number }
interface RecipeRow { size_id: number; flower_id: number; name: string; price: number; stock: number; stems: number }
interface WardRow { id: number; name: string; ring: 1 | 2 | 3 }

// What a caller sends (already validated by the route's schema).
interface CatalogItem { productId: number; size: ProductSize; quantity: number; custom?: undefined }
interface CustomItem {
  custom: { flowers: { flowerId: number; stems: number }[]; style: CustomStyle; note?: string | null };
  quantity: number;
  key?: string | null;
}
type QuoteItem = CatalogItem | CustomItem;
interface QuoteInput {
  items?: QuoteItem[];
  couponCode?: string | null;
  fulfillmentType?: "delivery" | "pickup" | null;
  wardId?: number | null;
  deliveryDate?: string | null;
}

// What quote() returns: the body the quote route sends (shared/api-types.ts), plus the stems it needs, which only
// the order route reads.
interface Quote extends QuoteBody { stock_needed: { flower_id: number; stems: number }[] }

// VAT inside a tax-inclusive amount, rounded to the whole đồng. One formula
// for every admin view (the stats SQL uses the same expression).
function vatAmount(totalAmount: number, vatRate: number): number {
  return Math.round((totalAmount * vatRate) / (100 + vatRate));
}

// ---------------------------------------------------------------------------
// Custom bouquet ("Bó hoa tùy chỉnh"): the rules live here and only here. The
// builder page gets them from GET /api/flowers (limits + styles), the order
// schema imports them, so no page or route types a number of its own.
//   price = Σ (flower price × stems) + the style fee (settings), × quantity
// ---------------------------------------------------------------------------
const CUSTOM_LIMITS = { min_stems: 3, max_stems: 100, note_max: 300 };
const CUSTOM_STYLE_LABELS: Record<CustomStyle, string> = { bo: "Bó giấy", gio: "Giỏ", hop: "Hộp" };
const CUSTOM_STYLES = Object.keys(CUSTOM_STYLE_LABELS) as CustomStyle[];
const CUSTOM_NAME = "Bó hoa tùy chỉnh";

function normalizeCouponCode(raw?: string | null): string | null {
  const code = (raw || "").trim().toUpperCase();
  return code || null;
}

// Coupon result statuses (the UI maps each to a sentence):
//   applied        discount counts
//   not_found      no such code
//   inactive       switched off in admin
//   below_minimum  goods total under min_subtotal
//   needs_date     has a date window but no delivery date picked yet (cart)
//   outside_dates  delivery date outside the window
async function evaluateCoupon(db: Queryable, code: string, subtotal: number, deliveryDate: string | null): Promise<CouponResult> {
  const { rows } = await db.query<CouponRow>(
    `SELECT code, type, value, min_subtotal, starts_on, ends_on, active
     FROM coupons WHERE code = $1`,
    [code]
  );
  if (rows.length === 0) return { code, status: "not_found", discount: 0 };
  const c = rows[0];
  const info = {
    code: c.code,
    type: c.type,
    value: c.value,
    min_subtotal: c.min_subtotal,
    starts_on: c.starts_on,
    ends_on: c.ends_on,
  };
  if (!c.active) return { ...info, status: "inactive", discount: 0 };
  if (subtotal < c.min_subtotal) return { ...info, status: "below_minimum", discount: 0 };
  const hasWindow = c.starts_on !== null || c.ends_on !== null;
  if (hasWindow) {
    if (!deliveryDate) return { ...info, status: "needs_date", discount: 0 };
    // Dates are plain "YYYY-MM-DD" strings (see db.js), so string order is date order.
    if ((c.starts_on && deliveryDate < c.starts_on) || (c.ends_on && deliveryDate > c.ends_on)) {
      return { ...info, status: "outside_dates", discount: 0 };
    }
  }
  const discount =
    c.type === "fixed" ? Math.min(c.value, subtotal) : Math.floor((subtotal * c.value) / 100);
  return { ...info, status: "applied", discount };
}

// input: {
//   items: [{ productId, size, quantity }  or  a custom bouquet:
//            { custom: { flowers: [{ flowerId, stems }], style, note }, quantity, key }],
//   couponCode, fulfillmentType ('delivery' | 'pickup' | null),
//   wardId, deliveryDate ('YYYY-MM-DD' | null)
// }
async function quote(db: Queryable, input: QuoteInput): Promise<Quote> {
  const items = input.items || [];

  const { rows: settingsRows } = await db.query<SettingsRow>(
    `SELECT vat_rate, ring1_fee, ring2_fee, ring3_fee, style_fee_bo, style_fee_gio, style_fee_hop FROM settings`
  );
  const settings = settingsRows[0];

  // Every requested product with all of its sizes, in one query.
  const isCustom = (item: QuoteItem): item is CustomItem => item.custom !== undefined;
  const productIds = [...new Set(items.filter((i) => !isCustom(i)).map((i) => i.productId))];
  const { rows: sizeRows } = await db.query<SizeRow>(
    `SELECT p.id AS product_id, p.name, p.image, p.style, p.status, p.product_type,
            ps.id AS size_id, ps.size, ps.price
     FROM products p
     JOIN product_sizes ps ON ps.product_id = p.id
     WHERE p.id = ANY($1)`,
    [productIds]
  );
  const sizeByKey = new Map<string, SizeRow>(sizeRows.map((r) => [`${r.product_id}:${r.size}`, r]));

  // Every size each product comes in (Nhỏ, Vừa, Lớn order), so the cart can
  // offer a size switch without another request.
  const SIZE_ORDER: Record<ProductSize, number> = { s: 0, m: 1, l: 2 };
  const sizesByProduct = new Map<number, SizePrice[]>();
  for (const r of sizeRows) {
    if (!sizesByProduct.has(r.product_id)) sizesByProduct.set(r.product_id, []);
    sizesByProduct.get(r.product_id)!.push({ size: r.size, price: r.price });
  }
  for (const list of sizesByProduct.values()) list.sort((a, b) => SIZE_ORDER[a.size] - SIZE_ORDER[b.size]);
  const knownProducts = new Set(sizeRows.map((r) => r.product_id));

  // Recipes for exactly the sizes in the cart.
  const sizeIds: number[] = [];
  for (const item of items) {
    if (isCustom(item)) continue;
    const row = sizeByKey.get(`${item.productId}:${item.size}`);
    if (row) sizeIds.push(row.size_id);
  }
  // The flowers behind every custom bouquet in the cart.
  const customFlowerIds = [...new Set(items.filter(isCustom).flatMap((i) => i.custom.flowers.map((f) => f.flowerId)))];
  const { rows: flowerRows } = customFlowerIds.length
    ? await db.query<FlowerRow>(`SELECT id, name, price, stock FROM flowers WHERE id = ANY($1)`, [customFlowerIds])
    : { rows: [] as FlowerRow[] };
  const flowerById = new Map<number, FlowerRow>(flowerRows.map((f) => [f.id, f]));
  const { rows: recipeRows } = await db.query<RecipeRow>(
    `SELECT r.size_id, f.id AS flower_id, f.name, f.price, f.stock, r.quantity AS stems
     FROM recipes r JOIN flowers f ON f.id = r.flower_id
     WHERE r.size_id = ANY($1)
     ORDER BY r.size_id, f.id`,
    [sizeIds]
  );
  const recipeBySize = new Map<number, RecipeRow[]>();
  for (const r of recipeRows) {
    if (!recipeBySize.has(r.size_id)) recipeBySize.set(r.size_id, []);
    recipeBySize.get(r.size_id)!.push(r);
  }

  // Build lines. `problem` is null for a line that can be sold; otherwise:
  //   unknown_product | unknown_size | external
  // (status-based rejections — discontinued, sold out today — stay in the
  // order route's availability check, which also logs them.)
  const needed = new Map<number, { name: string; stock: number; stems: number }>(); // flower_id -> { name, stock, stems needed in total }
  const lines: QuoteLine[] = items.map((item): QuoteLine => {
    if (isCustom(item)) return customLine(item);
    const row = sizeByKey.get(`${item.productId}:${item.size}`);
    let problem: LineProblem | null = null;
    if (!knownProducts.has(item.productId)) problem = "unknown_product";
    else if (!row) problem = "unknown_size";
    else if (row.product_type === "external") problem = "external";

    // `!row` cannot be true once problem is null; it is here so TypeScript knows row exists below.
    if (problem || !row) {
      return {
        productId: item.productId, size: item.size, quantity: item.quantity,
        problem, unitPrice: 0, lineTotal: 0, flowers: [], short_flowers: [], sizes: [],
      };
    }

    const flowers = (recipeBySize.get(row.size_id) || []).map((f) => ({
      flower_id: f.flower_id, name: f.name, stems: f.stems, price: f.price,
    }));
    for (const f of recipeBySize.get(row.size_id) || []) {
      const entry = needed.get(f.flower_id) || { name: f.name, stock: f.stock, stems: 0 };
      entry.stems += f.stems * item.quantity;
      needed.set(f.flower_id, entry);
    }

    return {
      productId: item.productId,
      size: item.size,
      quantity: item.quantity,
      problem: null,
      name: row.name,
      image: row.image,
      style: row.style,
      status: row.status,
      unitPrice: row.price,
      lineTotal: row.price * item.quantity,
      flowers,
      sizes: sizesByProduct.get(item.productId) || [],
      short_flowers: [], // filled below, once all lines are counted
    };
  });

  // A custom bouquet line. `problem` is "invalid_custom" for a duplicate or
  // unknown flower, a style that isn't offered, or a stem total outside the
  // limits. Its stems count toward the SAME per-flower totals as every other
  // line, so shortage works across a custom bouquet and a catalog one.
  function customLine(item: CustomItem): QuoteLine {
    const c = item.custom;
    const ids = c.flowers.map((f) => f.flowerId);
    const total = c.flowers.reduce((sum, f) => sum + f.stems, 0);
    let problem: LineProblem | null = null;
    if (!CUSTOM_STYLES.includes(c.style)) problem = "invalid_custom";
    else if (new Set(ids).size !== ids.length) problem = "invalid_custom";
    else if (!ids.every((id) => flowerById.has(id))) problem = "invalid_custom";
    else if (total < CUSTOM_LIMITS.min_stems || total > CUSTOM_LIMITS.max_stems) problem = "invalid_custom";

    const common = {
      custom: true as const,
      key: item.key ?? null, // the browser's own id for this line, echoed back untouched
      productId: null,
      size: null,
      quantity: item.quantity,
      name: CUSTOM_NAME,
      status: "available" as const,
      sizes: [],
      note: c.note || null,
    };
    if (problem) {
      return { ...common, problem, style: null, style_label: null, unitPrice: 0, lineTotal: 0, flowers: [], short_flowers: [] };
    }

    const flowers = c.flowers.map((f) => {
      const fl = flowerById.get(f.flowerId)!;
      return { flower_id: fl.id, name: fl.name, stems: f.stems, price: fl.price };
    });
    for (const f of c.flowers) {
      const fl = flowerById.get(f.flowerId)!;
      const entry = needed.get(fl.id) || { name: fl.name, stock: fl.stock, stems: 0 };
      entry.stems += f.stems * item.quantity;
      needed.set(fl.id, entry);
    }
    const styleFee = settings[`style_fee_${c.style}` as const];
    const unitPrice = flowers.reduce((sum, f) => sum + f.price * f.stems, 0) + styleFee;
    return {
      ...common,
      problem: null,
      style: c.style,
      style_label: CUSTOM_STYLE_LABELS[c.style],
      style_fee: styleFee,
      unitPrice,
      lineTotal: unitPrice * item.quantity,
      flowers,
      short_flowers: [], // filled below, once all lines are counted
    };
  }

  // Shortage is checked across ALL lines together: two different bouquets
  // can both use "Hồng đỏ", and only the sum has to fit in stock.
  const shortIds = new Set<number>();
  for (const [flowerId, entry] of needed) {
    if (entry.stems > entry.stock) shortIds.add(flowerId);
  }
  for (const line of lines) {
    line.short_flowers = line.flowers.filter((f) => shortIds.has(f.flower_id)).map((f) => f.name);
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);

  const code = normalizeCouponCode(input.couponCode);
  const coupon = code ? await evaluateCoupon(db, code, subtotal, input.deliveryDate || null) : null;
  const discount = coupon ? coupon.discount : 0;

  // Shipping: null = not known yet (delivery chosen but no ward, or no
  // fulfillment type chosen at all — the cart's case).
  let shippingFee: number | null = null;
  let ward: WardRow | null = null;
  if (input.fulfillmentType === "pickup") {
    shippingFee = 0;
  } else if (input.fulfillmentType === "delivery" && input.wardId) {
    const { rows } = await db.query<WardRow>(`SELECT id, name, ring FROM wards WHERE id = $1`, [input.wardId]);
    if (rows.length > 0) {
      ward = rows[0];
      shippingFee = settings[`ring${ward.ring}_fee` as const];
    }
  }

  return {
    lines,
    subtotal,
    coupon,
    discount,
    ward,
    shipping_fee: shippingFee,
    total: subtotal - discount + (shippingFee || 0),
    vat_rate: settings.vat_rate,
    short_flowers: [...shortIds].map((id) => needed.get(id)!.name),
    // Per flower, the stems the whole order takes — used by the order route
    // to subtract stock. Sorted by id so concurrent orders lock rows in the
    // same order.
    stock_needed: [...needed.entries()]
      .map(([flower_id, e]) => ({ flower_id, stems: e.stems }))
      .sort((a, b) => a.flower_id - b.flower_id),
  };
}

export { quote, vatAmount, normalizeCouponCode, CUSTOM_LIMITS, CUSTOM_STYLES, CUSTOM_STYLE_LABELS, CUSTOM_NAME };
