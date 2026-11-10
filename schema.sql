-- Bloomy — database schema.
--
-- Rewritten cleanly for the 2026-10 data model (full wipe, so columns are in
-- logical order, not "appended last"). Applied declaratively by pgschema:
-- edit only this file, never hand-ALTER production.
--
-- Rule: every fact lives in one place and tables link by id. Anything on an
-- order that can change later (names, sizes, prices, flowers used, shipping
-- fee, coupon code, VAT rate) is COPIED onto the order; stable things (the
-- ward) are linked by id.

CREATE TYPE product_status AS ENUM ('available', 'sold_out_today', 'discontinued');
CREATE TYPE product_type AS ENUM ('standard', 'external');
CREATE TYPE product_style AS ENUM ('bo', 'gio', 'hop', 'vong', 'set');
CREATE TYPE product_size AS ENUM ('s', 'm', 'l');
CREATE TYPE tag_kind AS ENUM ('flower', 'color');
CREATE TYPE time_window AS ENUM ('morning', 'afternoon', 'evening');
CREATE TYPE order_channel AS ENUM ('web', 'pos');
CREATE TYPE fulfillment_type AS ENUM ('delivery', 'pickup');
CREATE TYPE payment_method AS ENUM ('cod', 'zalopay', 'cash');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
CREATE TYPE fulfillment_status AS ENUM ('new', 'delivering', 'delivered', 'cancelled');
CREATE TYPE coupon_type AS ENUM ('fixed', 'percent');
CREATE TYPE admin_role AS ENUM ('owner', 'manager', 'employee');
CREATE TYPE availability_result AS ENUM ('available', 'rejected_sold_out_today', 'rejected_discontinued', 'rejected_past_cutoff', 'rejected_window_passed', 'rejected_flower_shortage');
CREATE TYPE funnel_event AS ENUM ('visit', 'product_view', 'add_to_cart', 'checkout_view', 'order_placed');

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

-- parent_id NULL = top-level. Only "Hoa theo mùa" has children.
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT
);

-- No price column: prices live on product_sizes (every product has at least
-- one size row; single-size products have one 'm' row). `style` is NULL only
-- for external products (e.g. a vase sold on another site), which also need
-- an external_url and never enter the cart.
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_description TEXT,
  description TEXT,
  image TEXT,
  status product_status NOT NULL DEFAULT 'available',
  -- Shown on the homepage (discontinued ones are skipped there).
  featured BOOLEAN NOT NULL DEFAULT false,
  product_type product_type NOT NULL DEFAULT 'standard',
  style product_style,
  external_url TEXT,
  seo_keyword TEXT,
  seo_title TEXT,
  seo_description TEXT,
  CHECK ((product_type = 'external') = (external_url IS NOT NULL)),
  CHECK (product_type = 'external' OR style IS NOT NULL)
);

CREATE TABLE product_sizes (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size product_size NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  price INTEGER NOT NULL CHECK (price > 0),
  UNIQUE (product_id, size)
);

-- Main flowers only; greenery and packaging are description text.
-- stock never goes below 0 — the database itself refuses it.
CREATE TABLE flowers (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  -- Groups the flower list in the custom-bouquet builder (Hồng, Tulip, Cúc ...).
  family TEXT NOT NULL DEFAULT 'Khác',
  price INTEGER NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

-- Which flowers, and how many stems, make one bouquet of a given size.
CREATE TABLE recipes (
  size_id INTEGER NOT NULL REFERENCES product_sizes(id) ON DELETE CASCADE,
  flower_id INTEGER NOT NULL REFERENCES flowers(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (size_id, flower_id)
);

-- Gallery photos beyond the main products.image.
CREATE TABLE product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- "Hồng" exists as both a flower tag and a colour tag, hence (kind, name).
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  kind tag_kind NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE product_tags (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

-- Shown only once approved by an admin. No email or phone collected. The length
-- limits are REVIEW_LIMITS in routes/reviews.js — change both together.
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT NOT NULL CHECK (char_length(comment) BETWEEN 10 AND 500),
  approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Shop settings and reference data
-- ---------------------------------------------------------------------------

-- One coupon per order, applied to goods before shipping. Codes are A-Z, 0-9,
-- _ and - (3-20 characters, so always upper-case); the same rule is
-- COUPON_CODE_PATTERN in routes/admin-coupons.js. The date window is checked
-- against the DELIVERY date.
CREATE TABLE coupons (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,20}$'),
  type coupon_type NOT NULL,
  value INTEGER NOT NULL CHECK (value > 0),
  min_subtotal INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
  starts_on DATE,
  ends_on DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  CHECK (type = 'fixed' OR value <= 100),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
);

-- A campaign is one occasion's landing page (20/10, Teachers' Day...): its
-- wording, one coupon, and a hand-picked list of products. At most one is on at
-- a time: settings.active_campaign_id points at it (NULL = no landing page and
-- no card on the homepage). The coupon's code, value and dates are NOT copied
-- here: the pages read them live from `coupons`, so moving a coupon's window in
-- admin can never leave a page saying something else.
CREATE TABLE campaigns (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  headline TEXT NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 120),
  subheadline TEXT CHECK (subheadline IS NULL OR char_length(subheadline) <= 200),
  -- NULL = a campaign without a discount, just a hand-picked list.
  coupon_code TEXT REFERENCES coupons(code),
  -- Optional hero photo (a path under images/); empty = a plain brand-colour band.
  hero_image TEXT
);

CREATE TABLE campaign_products (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, product_id)
);

-- Exactly one row: the primary key can only ever be `true`.
-- vat_rate is a whole percent (10 = 10%).
CREATE TABLE settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  shop_address TEXT NOT NULL,
  vat_rate SMALLINT NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),
  -- One number for both the hotline (tel:) and Zalo (zalo.me/<digits>), digits
  -- only. Shown in every page's floating contact widget, footer and terms.
  -- The DEFAULTs only let an existing database take the new columns; the seed
  -- sets the real values, and the Settings page changes them.
  contact_phone TEXT NOT NULL DEFAULT '0900000000' CHECK (contact_phone ~ '^[0-9]{8,12}$'),
  contact_email TEXT NOT NULL DEFAULT 'hello@bloomy.example' CHECK (contact_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$'),
  ring1_fee INTEGER NOT NULL CHECK (ring1_fee >= 0),
  ring2_fee INTEGER NOT NULL CHECK (ring2_fee >= 0),
  ring3_fee INTEGER NOT NULL CHECK (ring3_fee >= 0),
  -- What a custom bouquet costs on top of its flowers, by style: paper wrap
  -- (bo), basket (gio), box (hop). Owner-editable in Cài đặt.
  style_fee_bo INTEGER NOT NULL DEFAULT 30000 CHECK (style_fee_bo >= 0),
  style_fee_gio INTEGER NOT NULL DEFAULT 80000 CHECK (style_fee_gio >= 0),
  style_fee_hop INTEGER NOT NULL DEFAULT 100000 CHECK (style_fee_hop >= 0),
  -- The campaign whose landing page is on (see campaigns above); NULL = none.
  -- Owner-chosen in Cài đặt. Deleting a campaign switches it off.
  active_campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL
);

-- HCMC wards (post-2025 names) the shop delivers to; ring decides the fee.
CREATE TABLE wards (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ring SMALLINT NOT NULL CHECK (ring BETWEEN 1 AND 3)
);

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

-- Roles (enforced in routes/admin-auth.js): owner = everything, including
-- Settings and staff accounts; manager = everything day-to-day; employee =
-- POS only. role defaults to the middle one; create-admin.js and the staff
-- page ask explicitly. active = false locks an account out without deleting it.
-- The username rule is the same as USERNAME_PATTERN in admin-auth.js — change
-- both together. totp_secret NULL = 2FA not set up; it is stored encrypted (AES-256-GCM, key in the
-- TOTP_ENCRYPTION_KEY env var, see totp.js). totp_last_step is the 30-second step of the last app
-- code accepted, so a code cannot be used twice.
CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._]{3,30}$'),
  password TEXT NOT NULL,
  role admin_role NOT NULL DEFAULT 'manager',
  active BOOLEAN NOT NULL DEFAULT true,
  totp_secret TEXT,
  totp_last_step BIGINT
);

-- One-time 2FA recovery codes, stored hashed. used_at NULL = still usable.
CREATE TABLE recovery_codes (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

-- channel: 'web' (the site) or 'pos' (counter sale). `source` is NOT the
-- channel: it stays the UTM traffic source used by the stats page.
-- Money: total_amount = subtotal − discount + shipping_fee, all in đồng and
-- tax-inclusive. Only the VAT *rate* is stored; the amount is computed when
-- shown (admin only).
-- Delivery orders need a ward and address; pickup orders have neither and no
-- shipping fee. POS orders are pickups handed over on the spot, so they have
-- no time window. Payment follows the fulfillment type: delivery pays COD or
-- ZaloPay, pickup (web or POS) pays cash at the shop or ZaloPay.
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  channel order_channel NOT NULL DEFAULT 'web',
  fulfillment_type fulfillment_type NOT NULL,
  sender_name TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  ward_id INTEGER REFERENCES wards(id) ON DELETE RESTRICT,
  delivery_address TEXT,
  delivery_date DATE NOT NULL,
  delivery_window time_window,
  notes TEXT,
  customer_email TEXT,
  source TEXT,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  shipping_fee INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL,
  vat_rate SMALLINT NOT NULL,
  coupon_code TEXT,
  payment_method payment_method NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  fulfillment_status fulfillment_status NOT NULL DEFAULT 'new',
  tracking_code TEXT,
  admin_note TEXT,
  -- The employee who rang up a counter (POS) sale; NULL for web orders.
  created_by INTEGER REFERENCES admin_users(id) ON DELETE RESTRICT,
  app_trans_id TEXT,
  zp_trans_id TEXT,
  -- Optional "yêu cầu xuất hóa đơn" from checkout: who the invoice is for.
  invoice_requested BOOLEAN NOT NULL DEFAULT false,
  invoice_company_name TEXT,
  invoice_tax_code TEXT,
  invoice_address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CHECK (total_amount = subtotal - discount + shipping_fee),
  CHECK (subtotal >= 0 AND discount >= 0 AND discount <= subtotal AND shipping_fee >= 0),
  CHECK (
    (fulfillment_type = 'delivery' AND ward_id IS NOT NULL AND delivery_address IS NOT NULL)
    OR (fulfillment_type = 'pickup' AND ward_id IS NULL AND delivery_address IS NULL AND shipping_fee = 0)
  ),
  CHECK (
    (channel = 'web' AND delivery_window IS NOT NULL)
    OR (channel = 'pos' AND fulfillment_type = 'pickup' AND delivery_window IS NULL)
  ),
  CHECK ((channel = 'pos') = (created_by IS NOT NULL)),
  CHECK (payment_method <> 'cod' OR fulfillment_type = 'delivery'),
  CHECK (payment_method <> 'cash' OR fulfillment_type = 'pickup')
);

-- The admin day view (routes/admin-orders.js) filters orders by delivery_date.
CREATE INDEX idx_orders_delivery_date ON orders (delivery_date);

-- product_id NULL = custom bouquet ("Bó hoa tùy chỉnh"), which has no size and
-- may carry the customer's free-text note (the flowers it was made of are in
-- order_item_flowers). name / size / style / price are snapshots taken when
-- the order is placed. The note limit is CUSTOM_LIMITS.note_max in pricing.js.
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  size product_size,
  style product_style NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_at_purchase INTEGER NOT NULL CHECK (price_at_purchase >= 0),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  CHECK (product_id IS NOT NULL OR size IS NULL),
  CHECK (note IS NULL OR product_id IS NULL)
);

-- Flowers used by ONE bouquet of each line (every line, not just custom).
-- Stock taken = stems × line quantity. Cancelling or a failed payment
-- returns stock by reading this table, not the current recipe.
CREATE TABLE order_item_flowers (
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  flower_id INTEGER NOT NULL REFERENCES flowers(id) ON DELETE RESTRICT,
  stems INTEGER NOT NULL CHECK (stems > 0),
  price_per_stem INTEGER NOT NULL CHECK (price_per_stem >= 0),
  PRIMARY KEY (order_item_id, flower_id)
);

CREATE TABLE availability_checks (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  requested_date DATE NOT NULL,
  requested_window time_window NOT NULL,
  result availability_result NOT NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Anonymous checkout-funnel events for the admin stats page. session_id is a
-- random per-visit id made in the browser (sessionStorage), not tied to a
-- person or an order. The browser logs visit / product_view / add_to_cart /
-- checkout_view through POST /api/events; order_placed is written by
-- POST /api/orders itself after the order commits, never by the browser.
CREATE TABLE funnel_events (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  event funnel_event NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Holiday/peak-day cutoff overrides. One row per calendar date; the absence
-- of a row means that date falls back to the default same-day 14:00 (VN)
-- cutoff computed in routes/orders.js. `deadline` is a real instant
-- (TIMESTAMPTZ), not an hour-of-day, because a holiday's real deadline can
-- fall the night BEFORE the delivery date itself (e.g. 14/2 orders closing
-- at 20:00 on 13/2) — an hour-of-day column couldn't express that.
CREATE TABLE cutoff_overrides (
  id SERIAL PRIMARY KEY,
  override_date DATE NOT NULL UNIQUE,
  deadline TIMESTAMPTZ NOT NULL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE session (
  sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX idx_session_expire ON session (expire);
