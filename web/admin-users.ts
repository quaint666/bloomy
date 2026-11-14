// Bloomy — Staff accounts ("Nhân sự"), owner only.
// Table of accounts with a role dropdown, activate/deactivate and a password
// reset (owner types the new password) per row, plus a form to add an account.
// The owner's own row is read-only here: changing your own role or password
// has its own rules (see routes/admin-users.js). Everything shown from the
// server is put in with textContent, never innerHTML.

import type { AdminUser, AdminUsersBody, ApiErrorBody } from "../shared/api-types";
import { ROLE_LABELS } from "./lib/admin";
import { adminApi } from "./lib/api";
import { byId, el } from "./lib/dom";

let me: number | null = null; // the logged-in owner's id, sent with the list
let resetTarget: { id: string; username: string } | null = null; // while the reset dialog is open

function errorText(data: ApiErrorBody | null): string {
  switch (data && data.error) {
    case "username_taken":
      return "Tên đăng nhập này đã có người dùng.";
    case "invalid_username":
      return `Tên đăng nhập gồm chữ thường, số, dấu chấm, gạch dưới, từ ${data?.min} đến ${data?.max} ký tự.`;
    case "invalid_password":
      return `Mật khẩu cần ít nhất ${data?.min} ký tự (tối đa ${data?.max} byte).`;
    case "last_owner":
      return "Không thể hạ quyền hoặc vô hiệu hóa chủ shop cuối cùng.";
    case "cannot_change_self":
      return "Bạn không thể đổi quyền hoặc vô hiệu hóa chính mình.";
    case "use_account_page":
      return "Dùng trang “Đổi mật khẩu” để đổi mật khẩu của chính bạn.";
    case "invalid_role":
      return "Vai trò không hợp lệ.";
    case "user_not_found":
      return "Không tìm thấy tài khoản.";
    default:
      return "Có lỗi xảy ra. Vui lòng thử lại.";
  }
}

function showNotice(text: string, ok: boolean): void {
  const notice = byId("admin-users-notice");
  notice.textContent = text;
  notice.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  notice.hidden = false;
}

function roleSelect(selected: string): HTMLSelectElement {
  const select = el("select", "admin-table__status-select");
  Object.entries(ROLE_LABELS).forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    if (value === selected) option.selected = true;
    select.appendChild(option);
  });
  return select;
}

function renderTable(users: AdminUser[]): void {
  const body = byId("admin-users-body");
  body.innerHTML = "";
  users.forEach((user) => {
    const isSelf = user.id === me;
    const row = el("tr");

    const nameCell = el("td", null, user.username);
    if (isSelf) nameCell.appendChild(el("span", "admin-table__sub", "(bạn)"));

    const roleCell = el("td");
    const select = roleSelect(user.role);
    select.classList.add("admin-users__role");
    select.dataset.id = String(user.id);
    select.disabled = isSelf;
    roleCell.appendChild(select);

    const statusCell = el("td", null, user.active ? "Đang hoạt động" : "Đã vô hiệu hóa");

    const actionsCell = el("td");
    const actions = el("div", "admin-users__actions");
    const reset = el("button", "btn btn-outline admin-table__action-btn", "Đặt lại mật khẩu");
    reset.type = "button";
    reset.dataset.action = "reset";
    reset.dataset.id = String(user.id);
    reset.dataset.username = user.username;
    reset.disabled = isSelf;
    const toggle = el("button", "btn btn-outline admin-table__action-btn", user.active ? "Vô hiệu hóa" : "Kích hoạt");
    toggle.type = "button";
    toggle.dataset.action = "toggle";
    toggle.dataset.id = String(user.id);
    toggle.dataset.username = user.username;
    toggle.dataset.active = String(user.active);
    toggle.disabled = isSelf;
    if (isSelf) {
      reset.title = "Dùng trang “Đổi mật khẩu” cho tài khoản của bạn";
      toggle.title = "Bạn không thể vô hiệu hóa chính mình";
    }
    actions.append(reset, toggle);
    actionsCell.appendChild(actions);

    row.append(nameCell, roleCell, statusCell, actionsCell);
    body.appendChild(row);
  });
}

async function loadUsers(): Promise<void> {
  const errorEl = byId("admin-users-error");
  try {
    const result = await adminApi<AdminUsersBody>("GET", "/api/admin/users");
    if (!result.ok) throw new Error(`users: ${result.res.status}`);
    me = result.data.me;
    renderTable(result.data.users);
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách tài khoản.";
    errorEl.hidden = false;
  }
}

// ---- add an account
function initCreateForm(): void {
  const roleField = byId("new-role", HTMLSelectElement);
  Object.entries(ROLE_LABELS).forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    roleField.appendChild(option);
  });
  roleField.value = "manager";

  const form = byId("admin-user-form", HTMLFormElement);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = byId("new-username", HTMLInputElement).value;
    const password = byId("new-password", HTMLInputElement).value;
    const result = await adminApi<AdminUser>("POST", "/api/admin/users", { username, role: roleField.value, password });
    if (!result.ok) {
      showNotice(errorText(result.data), false);
      return;
    }
    form.reset();
    roleField.value = "manager";
    showNotice(`Đã tạo tài khoản “${result.data.username}” (${ROLE_LABELS[result.data.role]}).`, true);
    loadUsers();
  });
}

// ---- change a role / activate / deactivate / reset password
byId("admin-users-body").addEventListener("change", async (e) => {
  if (!(e.target instanceof Element)) return;
  const select = e.target.closest<HTMLSelectElement>(".admin-users__role");
  if (!select) return;
  const result = await adminApi<AdminUser>("PATCH", `/api/admin/users/${select.dataset.id}`, { role: select.value });
  if (!result.ok) showNotice(errorText(result.data), false);
  else showNotice(`Đã đổi vai trò thành ${ROLE_LABELS[result.data.role]}.`, true);
  loadUsers(); // always redraw from the real state
});

byId("admin-users-body").addEventListener("click", async (e) => {
  if (!(e.target instanceof Element)) return;
  const button = e.target.closest<HTMLButtonElement>("[data-action]");
  if (!button || button.disabled) return;

  if (button.dataset.action === "reset") {
    const { id, username } = button.dataset;
    if (id === undefined || username === undefined) return;
    resetTarget = { id, username };
    byId("admin-reset-title").textContent = `Đặt lại mật khẩu cho “${resetTarget.username}”`;
    byId("reset-password", HTMLInputElement).value = "";
    byId("admin-reset-msg").hidden = true;
    byId("admin-reset-dialog", HTMLDialogElement).showModal();
    return;
  }

  if (button.dataset.action === "toggle") {
    const deactivating = button.dataset.active === "true";
    if (deactivating && !confirm(`Vô hiệu hóa “${button.dataset.username}”? Họ sẽ bị đăng xuất ngay.`)) return;
    const result = await adminApi<AdminUser>("PATCH", `/api/admin/users/${button.dataset.id}`, { active: !deactivating });
    if (!result.ok) showNotice(errorText(result.data), false);
    else showNotice(`Đã ${deactivating ? "vô hiệu hóa" : "kích hoạt"} “${result.data.username}”.`, true);
    loadUsers();
  }
});

// ---- reset-password dialog
byId("admin-reset-cancel").addEventListener("click", () => {
  byId("admin-reset-dialog", HTMLDialogElement).close();
});

byId("admin-reset-form", HTMLFormElement).addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!resetTarget) return;
  const msg = byId("admin-reset-msg");
  const result = await adminApi<{ success: true }>("POST", `/api/admin/users/${resetTarget.id}/password`, {
    password: byId("reset-password", HTMLInputElement).value,
  });
  if (!result.ok) {
    msg.textContent = errorText(result.data);
    msg.hidden = false;
    return;
  }
  byId("admin-reset-dialog", HTMLDialogElement).close();
  showNotice(`Đã đặt lại mật khẩu cho “${resetTarget.username}”. Họ đã bị đăng xuất khỏi mọi thiết bị.`, true);
});

initCreateForm();
loadUsers();
