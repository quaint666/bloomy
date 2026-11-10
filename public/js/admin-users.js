// Bloomy — Staff accounts ("Nhân sự"), owner only.
// Table of accounts with a role dropdown, activate/deactivate and a password
// reset (owner types the new password) per row, plus a form to add an account.
// The owner's own row is read-only here: changing your own role or password
// has its own rules (see routes/admin-users.js). Everything shown from the
// server is put in with textContent, never innerHTML.

// ROLE_LABELS comes from admin-nav.js, which every admin page loads first —
// declaring it again here would be a "already declared" error in the browser,
// since classic scripts on one page share one global scope.

let me = null; // the logged-in owner's id, sent with the list
let resetTarget = null; // { id, username } while the reset dialog is open

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function errorText(data) {
  switch (data && data.error) {
    case "username_taken":
      return "Tên đăng nhập này đã có người dùng.";
    case "invalid_username":
      return `Tên đăng nhập gồm chữ thường, số, dấu chấm, gạch dưới, từ ${data.min} đến ${data.max} ký tự.`;
    case "invalid_password":
      return `Mật khẩu cần ít nhất ${data.min} ký tự (tối đa ${data.max} byte).`;
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

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return { res, data: null };
  }
  const data = await res.json().catch(() => null);
  return { res, data };
}

function showNotice(text, ok) {
  const notice = document.getElementById("admin-users-notice");
  notice.textContent = text;
  notice.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  notice.hidden = false;
}

function roleSelect(selected) {
  const select = el("select", "admin-table__status-select");
  Object.entries(ROLE_LABELS).forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    if (value === selected) option.selected = true;
    select.appendChild(option);
  });
  return select;
}

function renderTable(users) {
  const body = document.getElementById("admin-users-body");
  body.innerHTML = "";
  users.forEach((user) => {
    const isSelf = user.id === me;
    const row = el("tr");

    const nameCell = el("td", null, user.username);
    if (isSelf) nameCell.appendChild(el("span", "admin-table__sub", "(bạn)"));

    const roleCell = el("td");
    const select = roleSelect(user.role);
    select.classList.add("admin-users__role");
    select.dataset.id = user.id;
    select.disabled = isSelf;
    roleCell.appendChild(select);

    const statusCell = el("td", null, user.active ? "Đang hoạt động" : "Đã vô hiệu hóa");

    const actionsCell = el("td");
    const actions = el("div", "admin-users__actions");
    const reset = el("button", "btn btn-outline admin-table__action-btn", "Đặt lại mật khẩu");
    reset.type = "button";
    reset.dataset.action = "reset";
    reset.dataset.id = user.id;
    reset.dataset.username = user.username;
    reset.disabled = isSelf;
    const toggle = el("button", "btn btn-outline admin-table__action-btn", user.active ? "Vô hiệu hóa" : "Kích hoạt");
    toggle.type = "button";
    toggle.dataset.action = "toggle";
    toggle.dataset.id = user.id;
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

async function loadUsers() {
  const errorEl = document.getElementById("admin-users-error");
  try {
    const { res, data } = await api("GET", "/api/admin/users");
    if (!res.ok) throw new Error(`users: ${res.status}`);
    me = data.me;
    renderTable(data.users);
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách tài khoản.";
    errorEl.hidden = false;
  }
}

// ---- add an account
function initCreateForm() {
  const roleField = document.getElementById("new-role");
  Object.entries(ROLE_LABELS).forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    roleField.appendChild(option);
  });
  roleField.value = "manager";

  document.getElementById("admin-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("new-username").value;
    const password = document.getElementById("new-password").value;
    const { res, data } = await api("POST", "/api/admin/users", { username, role: roleField.value, password });
    if (!res.ok) {
      showNotice(errorText(data), false);
      return;
    }
    e.target.reset();
    roleField.value = "manager";
    showNotice(`Đã tạo tài khoản “${data.username}” (${ROLE_LABELS[data.role]}).`, true);
    loadUsers();
  });
}

// ---- change a role / activate / deactivate / reset password
document.getElementById("admin-users-body").addEventListener("change", async (e) => {
  const select = e.target.closest(".admin-users__role");
  if (!select) return;
  const { res, data } = await api("PATCH", `/api/admin/users/${select.dataset.id}`, { role: select.value });
  if (!res.ok) showNotice(errorText(data), false);
  else showNotice(`Đã đổi vai trò thành ${ROLE_LABELS[data.role]}.`, true);
  loadUsers(); // always redraw from the real state
});

document.getElementById("admin-users-body").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-action]");
  if (!button || button.disabled) return;

  if (button.dataset.action === "reset") {
    resetTarget = { id: button.dataset.id, username: button.dataset.username };
    document.getElementById("admin-reset-title").textContent = `Đặt lại mật khẩu cho “${resetTarget.username}”`;
    document.getElementById("reset-password").value = "";
    document.getElementById("admin-reset-msg").hidden = true;
    document.getElementById("admin-reset-dialog").showModal();
    return;
  }

  if (button.dataset.action === "toggle") {
    const deactivating = button.dataset.active === "true";
    if (deactivating && !confirm(`Vô hiệu hóa “${button.dataset.username}”? Họ sẽ bị đăng xuất ngay.`)) return;
    const { res, data } = await api("PATCH", `/api/admin/users/${button.dataset.id}`, { active: !deactivating });
    if (!res.ok) showNotice(errorText(data), false);
    else showNotice(`Đã ${deactivating ? "vô hiệu hóa" : "kích hoạt"} “${data.username}”.`, true);
    loadUsers();
  }
});

// ---- reset-password dialog
document.getElementById("admin-reset-cancel").addEventListener("click", () => {
  document.getElementById("admin-reset-dialog").close();
});

document.getElementById("admin-reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("admin-reset-msg");
  const { res, data } = await api("POST", `/api/admin/users/${resetTarget.id}/password`, {
    password: document.getElementById("reset-password").value,
  });
  if (!res.ok) {
    msg.textContent = errorText(data);
    msg.hidden = false;
    return;
  }
  document.getElementById("admin-reset-dialog").close();
  showNotice(`Đã đặt lại mật khẩu cho “${resetTarget.username}”. Họ đã bị đăng xuất khỏi mọi thiết bị.`, true);
});

initCreateForm();
loadUsers();
