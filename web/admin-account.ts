// Bloomy — "Đổi mật khẩu": every role changes their OWN password here. The
// current password is required. Other devices signed in as this user are
// signed out by the server; this one stays signed in.
//
// The owner also gets "Xác thực hai bước" (two-factor login) below it: turn it on with the password and a
// first code, replace the recovery codes, or turn it off. The server decides who may use it
// (routes/admin-auth.js); this page only asks, and keeps the section hidden when the answer is 403.

import type { ApiErrorBody, RecoveryCodesBody, SuccessBody, TwoFactorSetupBody, TwoFactorState } from "../shared/api-types";
import { adminApi, type ApiResult } from "./lib/api";
import { byId } from "./lib/dom";

function showMessage(text: string, ok: boolean): void {
  const msg = byId("admin-account-msg");
  msg.textContent = text;
  msg.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  msg.hidden = false;
}

function errorText(res: Response, data: ApiErrorBody | null): string {
  if (res.status === 429) return "Bạn thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.";
  switch (data && data.error) {
    case "wrong_current_password":
      return "Mật khẩu hiện tại không đúng.";
    case "invalid_password":
      return `Mật khẩu mới cần ít nhất ${data?.min} ký tự (tối đa ${data?.max} byte).`;
    default:
      return "Có lỗi xảy ra. Vui lòng thử lại.";
  }
}

const accountForm = byId("admin-account-form", HTMLFormElement);
accountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const current = byId("current-password", HTMLInputElement).value;
  const next = byId("new-password", HTMLInputElement).value;
  if (next !== byId("confirm-password", HTMLInputElement).value) {
    showMessage("Hai mật khẩu mới không giống nhau.", false);
    return;
  }
  try {
    const result = await adminApi<SuccessBody>("POST", "/api/admin/me/password", { current_password: current, new_password: next });
    if (result.res.status === 401) return; // adminApi has already sent the person to the login page
    if (!result.ok) {
      showMessage(errorText(result.res, result.data), false);
      return;
    }
    accountForm.reset();
    showMessage("Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.", true);
  } catch (err) {
    showMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// ---------------------------------------------------------------------------
// Two-factor login (owner only)
// ---------------------------------------------------------------------------
const twofa = {
  section: byId("twofa"),
  status: byId("twofa-status"),
  start: byId("twofa-start-form", HTMLFormElement),
  enable: byId("twofa-enable-form", HTMLFormElement),
  codes: byId("twofa-codes"),
  on: byId("twofa-on"),
  msg: byId("twofa-msg"),
};

function twofaMessage(text: string, ok: boolean): void {
  twofa.msg.textContent = text;
  twofa.msg.className = `admin-form__msg ${ok ? "is-ok" : "is-error"}`;
  twofa.msg.hidden = false;
}

// One call to the server. Returns the result, or null after sending a signed-out person to the login page.
async function twofaCall<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T> | null> {
  const result = await adminApi<T>(method, `/api/admin/me/2fa${path}`, body);
  return result.res.status === 401 ? null : result;
}

function twofaErrorText(res: Response, data: ApiErrorBody | null): string {
  switch (data && data.error) {
    case "wrong_current_password":
      return "Mật khẩu hiện tại không đúng.";
    case "invalid_code":
      return "Mã không đúng hoặc đã được dùng rồi. Kiểm tra lại mã trong ứng dụng rồi thử lại.";
    case "two_factor_locked": {
      const minutes = Math.max(1, Math.ceil((data?.retry_after || 300) / 60));
      return `Bạn đã nhập sai mã 3 lần. Vui lòng thử lại sau ${minutes} phút.`;
    }
    default:
      return res.status === 429 ? "Bạn thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại." : "Có lỗi xảy ra. Vui lòng thử lại.";
  }
}

// Which of the pieces is on screen. `state` is { enabled, recovery_remaining } from GET /me/2fa.
function renderTwoFactor(state: TwoFactorState): void {
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

async function loadTwoFactor(): Promise<void> {
  try {
    const got = await twofaCall<TwoFactorState>("GET", "");
    if (!got) return;
    if (got.res.status === 403) return; // not the owner: the section stays hidden
    if (!got.ok) throw new Error(`2fa: ${got.res.status}`);
    renderTwoFactor(got.data);
  } catch (err) {
    console.error("Bloomy: failed to load the two-factor state", err);
  }
}

// The recovery codes are shown once; the forms are put away until the person says they saved them.
function showRecoveryCodes(codes: string[]): void {
  const list = byId("twofa-codes-list");
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
    const got = await twofaCall<TwoFactorSetupBody>("POST", "/setup", { password: byId("twofa-start-password", HTMLInputElement).value });
    if (!got) return;
    if (!got.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    byId("twofa-qr", HTMLImageElement).src = got.data.qr;
    byId("twofa-secret").textContent = got.data.secret;
    byId("twofa-start-password", HTMLInputElement).value = "";
    twofa.start.hidden = true;
    twofa.enable.hidden = false;
    byId("twofa-enable-code", HTMLInputElement).focus();
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// Step 2 (first code) -> turned on, recovery codes shown
twofa.enable.addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall<RecoveryCodesBody>("POST", "/enable", { code: byId("twofa-enable-code", HTMLInputElement).value });
    if (!got) return;
    if (got.res.status === 409 || (!got.ok && got.data && got.data.error === "no_pending_setup")) {
      await loadTwoFactor();
      twofaMessage("Phiên bật xác thực đã hết hạn. Hãy bắt đầu lại.", false);
      return;
    }
    if (!got.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    byId("twofa-enable-code", HTMLInputElement).value = "";
    byId("twofa-qr").removeAttribute("src");
    byId("twofa-secret").textContent = "";
    showRecoveryCodes(got.data.recovery_codes);
    twofaMessage("Đã bật xác thực hai bước. Các thiết bị khác đã bị đăng xuất.", true);
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// Replace the recovery codes (needs a current code)
const regenForm = byId("twofa-regen-form", HTMLFormElement);
regenForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall<RecoveryCodesBody>("POST", "/recovery-codes", { code: byId("twofa-regen-code", HTMLInputElement).value });
    if (!got) return;
    if (!got.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    regenForm.reset();
    showRecoveryCodes(got.data.recovery_codes);
    twofaMessage("Đã tạo mã khôi phục mới. Các mã cũ không dùng được nữa.", true);
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// Turn it off (needs a current code)
const disableForm = byId("twofa-disable-form", HTMLFormElement);
disableForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  twofa.msg.hidden = true;
  try {
    const got = await twofaCall<SuccessBody>("POST", "/disable", { code: byId("twofa-disable-code", HTMLInputElement).value });
    if (!got) return;
    if (!got.ok) {
      twofaMessage(twofaErrorText(got.res, got.data), false);
      return;
    }
    disableForm.reset();
    await loadTwoFactor();
    twofaMessage("Đã tắt xác thực hai bước.", true);
  } catch (err) {
    twofaMessage("Không thể kết nối máy chủ, vui lòng thử lại.", false);
  }
});

// "I saved them" -> back to the normal view. Copy puts all ten on the clipboard, one per line.
byId("twofa-codes-done").addEventListener("click", async () => {
  byId("twofa-codes-list").replaceChildren();
  twofa.msg.hidden = true;
  await loadTwoFactor();
});

byId("twofa-codes-copy").addEventListener("click", async () => {
  const text = [...document.querySelectorAll("#twofa-codes-list li")].map((li) => li.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    twofaMessage("Đã sao chép các mã khôi phục.", true);
  } catch (err) {
    twofaMessage("Không sao chép được. Hãy chép tay các mã trên màn hình.", false);
  }
});

loadTwoFactor();
