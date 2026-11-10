// Bloomy — "Đổi mật khẩu": every role changes their OWN password here. The
// current password is required. Other devices signed in as this user are
// signed out by the server; this one stays signed in.
//
// The owner also gets "Xác thực hai bước" (two-factor login) below it: turn it on with the password and a
// first code, replace the recovery codes, or turn it off. The server decides who may use it
// (routes/admin-auth.js); this page only asks, and keeps the section hidden when the answer is 403.

function showMessage(text, ok) {
  const msg = document.getElementById("admin-account-msg");
  msg.textContent = text;
  msg.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  msg.hidden = false;
}

function errorText(res, data) {
  if (res.status === 429) return "Bạn thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.";
  switch (data && data.error) {
    case "wrong_current_password":
      return "Mật khẩu hiện tại không đúng.";
    case "invalid_password":
      return `Mật khẩu mới cần ít nhất ${data.min} ký tự (tối đa ${data.max} byte).`;
    default:
      return "Có lỗi xảy ra. Vui lòng thử lại.";
  }
}

document.getElementById("admin-account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const current = document.getElementById("current-password").value;
  const next = document.getElementById("new-password").value;
  if (next !== document.getElementById("confirm-password").value) {
    showMessage("Hai mật khẩu mới không giống nhau.", false);
    return;
  }
  try {
    const res = await fetch("/api/admin/me/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showMessage(errorText(res, data), false);
      return;
    }
    e.target.reset();
    showMessage("Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.", true);
  } catch (err) {
    showMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// ---------------------------------------------------------------------------
// Two-factor login (owner only)
// ---------------------------------------------------------------------------
const twofa = {
  section: document.getElementById("twofa"),
  status: document.getElementById("twofa-status"),
  start: document.getElementById("twofa-start-form"),
  enable: document.getElementById("twofa-enable-form"),
  codes: document.getElementById("twofa-codes"),
  on: document.getElementById("twofa-on"),
  msg: document.getElementById("twofa-msg"),
};

function twofaMessage(text, ok) {
  twofa.msg.textContent = text;
  twofa.msg.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  twofa.msg.hidden = false;
}

// One call to the server. Returns { res, data }, or null after sending a signed-out person to the login page.
async function twofaCall(method, path, body) {
  const res = await fetch(`/api/admin/me/2fa${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "admin-login.html";
    return null;
  }
  return { res, data: await res.json().catch(() => null) };
}

function twofaErrorText(res, data) {
  switch (data && data.error) {
    case "wrong_current_password":
      return "Mật khẩu hiện tại không đúng.";
    case "invalid_code":
      return "Mã không đúng hoặc đã được dùng rồi. Kiểm tra lại mã trong ứng dụng rồi thử lại.";
    case "two_factor_locked": {
      const minutes = Math.max(1, Math.ceil((data.retry_after || 300) / 60));
      return `Bạn đã nhập sai mã 3 lần. Vui lòng thử lại sau ${minutes} phút.`;
    }
    default:
      return res.status === 429 ? "Bạn thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại." : "Có lỗi xảy ra. Vui lòng thử lại.";
  }
}

// Which of the pieces is on screen. `state` is { enabled, recovery_remaining } from GET /me/2fa.
function renderTwoFactor(state) {
  twofa.section.hidden = false;
  twofa.enable.hidden = true;
  twofa.codes.hidden = true;
  twofa.start.hidden = state.enabled;
  twofa.on.hidden = !state.enabled;
  if (state.enabled) {
    const low = state.recovery_remaining <= 3 ? " Sắp hết — hãy tạo lại mã khôi phục." : "";
    twofa.status.textContent = `Đang bật. Còn ${state.recovery_remaining} mã khôi phục chưa dùng.${low}`;
  } else {
    twofa.status.textContent = "Chưa bật. Khi bật, đăng nhập cần thêm một mã 6 số từ điện thoại của bạn.";
  }
}

async function loadTwoFactor() {
  try {
    const got = await twofaCall("GET", "");
    if (!got) return;
    if (got.res.status === 403) return; // not the owner: the section stays hidden
    if (!got.res.ok) throw new Error(`2fa: ${got.res.status}`);
    renderTwoFactor(got.data);
  } catch (err) {
    console.error("Bloomy: failed to load the two-factor state", err);
  }
}

// The recovery codes are shown once; the forms are put away until the person says they saved them.
function showRecoveryCodes(codes) {
  const list = document.getElementById("twofa-codes-list");
  list.replaceChildren(...codes.map((code) => Object.assign(document.createElement("li"), { textContent: code })));
  twofa.start.hidden = true;
  twofa.enable.hidden = true;
  twofa.on.hidden = true;
  twofa.codes.hidden = false;
  twofa.status.textContent = "Đã bật xác thực hai bước.";
}

// Step 1 (password) -> the QR code
twofa.start.addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall("POST", "/setup", { password: document.getElementById("twofa-start-password").value });
    if (!got) return;
    if (!got.res.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    document.getElementById("twofa-qr").src = got.data.qr;
    document.getElementById("twofa-secret").textContent = got.data.secret;
    document.getElementById("twofa-start-password").value = "";
    twofa.start.hidden = true;
    twofa.enable.hidden = false;
    document.getElementById("twofa-enable-code").focus();
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// Step 2 (first code) -> turned on, recovery codes shown
twofa.enable.addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall("POST", "/enable", { code: document.getElementById("twofa-enable-code").value });
    if (!got) return;
    if (got.res.status === 409 || (got.data && got.data.error === "no_pending_setup")) {
      await loadTwoFactor();
      twofaMessage("Phiên bật xác thực đã hết hạn. Hãy bắt đầu lại.", false);
      return;
    }
    if (!got.res.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    document.getElementById("twofa-enable-code").value = "";
    document.getElementById("twofa-qr").removeAttribute("src");
    document.getElementById("twofa-secret").textContent = "";
    showRecoveryCodes(got.data.recovery_codes);
    twofaMessage("Đã bật xác thực hai bước. Các thiết bị khác đã bị đăng xuất.", true);
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// Replace the recovery codes (needs a current code)
document.getElementById("twofa-regen-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall("POST", "/recovery-codes", { code: document.getElementById("twofa-regen-code").value });
    if (!got) return;
    if (!got.res.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    e.target.reset();
    showRecoveryCodes(got.data.recovery_codes);
    twofaMessage("Đã tạo mã khôi phục mới. Các mã cũ không dùng được nữa.", true);
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// Turn it off (needs a current code)
document.getElementById("twofa-disable-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall("POST", "/disable", { code: document.getElementById("twofa-disable-code").value });
    if (!got) return;
    if (!got.res.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    e.target.reset();
    await loadTwoFactor();
    twofaMessage("Đã tắt xác thực hai bước.", true);
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// "I saved them" -> back to the normal view. Copy puts all ten on the clipboard, one per line.
document.getElementById("twofa-codes-done").addEventListener("click", async () => {
  document.getElementById("twofa-codes-list").replaceChildren();
  twofa.msg.hidden = true;
  await loadTwoFactor();
});

document.getElementById("twofa-codes-copy").addEventListener("click", async () => {
  const text = [...document.querySelectorAll("#twofa-codes-list li")].map((li) => li.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    twofaMessage("Đã sao chép các mã khôi phục.", true);
  } catch (err) {
    twofaMessage("Không sao chép được. Hãy chép tay các mã trên màn hình.", false);
  }
});

loadTwoFactor();
