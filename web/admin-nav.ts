// Bloomy — Admin shared navigation and page gate. Loaded by every admin page
// except the login page.
//
// Asks GET /api/admin/me who is logged in, then:
//  - not logged in            -> the login page
//  - role too low for THIS page (the page says what it needs with
//    <body data-min-role="...">) -> that role's landing page
//  - otherwise builds the nav links this role may open, shows "who · role",
//    and wires the logout button.
//
// The list below only decides which links to SHOW. The server is what actually
// refuses a request (requireRole), so hiding a link is never the protection.
//
// The links live behind one button, "Menu ▾" (thirteen links wrapped onto two rows in
// the header). Click opens a panel with the page you are on marked; clicking the button
// again, clicking elsewhere or pressing Escape closes it (Escape puts focus back on the button).

import type { AdminMeBody, AdminRole } from "../shared/api-types";
import { ROLE_RANK } from "../shared/rules";
import { ADMIN_LAST_PAGE_KEY, ROLE_LABELS } from "./lib/admin";
import { byId } from "./lib/dom";

const ADMIN_PAGES: { href: string; label: string; minRole: AdminRole }[] = [
  { href: "admin-pos.html", label: "Bán tại quầy", minRole: "employee" },
  { href: "admin-products.html", label: "Sản phẩm", minRole: "manager" },
  { href: "admin-seo.html", label: "SEO", minRole: "manager" },
  { href: "admin-campaigns.html", label: "Chiến dịch", minRole: "manager" },
  { href: "admin-flowers.html", label: "Kho hoa", minRole: "manager" },
  { href: "admin-orders.html", label: "Đơn hàng", minRole: "manager" },
  { href: "admin-coupons.html", label: "Mã giảm giá", minRole: "manager" },
  { href: "admin-reviews.html", label: "Đánh giá", minRole: "manager" },
  { href: "admin-stats.html", label: "Thống kê", minRole: "manager" },
  { href: "admin-cutoffs.html", label: "Giờ chốt đơn", minRole: "manager" },
  { href: "admin-settings.html", label: "Cài đặt", minRole: "owner" },
  { href: "admin-users.html", label: "Nhân sự", minRole: "owner" },
  { href: "admin-account.html", label: "Đổi mật khẩu", minRole: "employee" },
];

const isRole = (value: string): value is AdminRole => Object.hasOwn(ROLE_RANK, value);

async function initAdminNav(): Promise<void> {
  let me: AdminMeBody;
  try {
    const res = await fetch("/api/admin/me");
    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!res.ok) throw new Error(`me: ${res.status}`);
    me = await res.json();
  } catch (err) {
    console.error("Bloomy: failed to load the admin identity", err);
    return;
  }

  const needed = document.body.dataset.minRole || "employee";
  // A data-min-role that names no role gates nothing, as before.
  if (isRole(needed) && ROLE_RANK[me.role] < ROLE_RANK[needed]) {
    window.location.href = me.landing;
    return;
  }

  const here = window.location.pathname.split("/").pop();
  // Remember where you were: the next login opens this page again (admin-login.js). Stored only once the
  // role check above has passed, so it is always a page this person may open.
  if (here !== undefined && ADMIN_PAGES.some((page) => page.href === here)) {
    try {
      localStorage.setItem(ADMIN_LAST_PAGE_KEY, here);
    } catch (err) {
      // storage blocked: the login just opens the usual first page
    }
  }
  const links = byId("admin-nav-links");
  ADMIN_PAGES.filter((page) => ROLE_RANK[me.role] >= ROLE_RANK[page.minRole]).forEach((page) => {
    const a = document.createElement("a");
    a.href = page.href;
    a.textContent = page.label;
    if (page.href === here) {
      a.classList.add("is-active");
      a.setAttribute("aria-current", "page");
    }
    links.appendChild(a);
  });

  // One button instead of a row of links.
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "admin-nav__menu";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "admin-nav-links");
  const label = document.createElement("span");
  label.textContent = "Menu";
  const chevron = document.createElement("span");
  chevron.className = "admin-nav__menu-chevron";
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(label, chevron);
  links.before(toggle);
  links.classList.add("is-collapsible");
  links.hidden = true;

  const setOpen = (open: boolean): void => {
    toggle.setAttribute("aria-expanded", String(open));
    links.hidden = !open;
  };
  toggle.addEventListener("click", () => setOpen(Boolean(links.hidden)));
  document.addEventListener("click", (e) => {
    if (!links.hidden && e.target instanceof Node && !links.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !links.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  const logout = byId("admin-logout");
  const who = document.createElement("span");
  who.className = "admin-nav__who";
  who.textContent = `${me.username} · ${ROLE_LABELS[me.role]}`;
  logout.before(who);

  logout.addEventListener("click", async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.href = "admin-login.html";
  });
}

initAdminNav();
