// Bloomy — Admin login.
// Real fetch() POST, not a native form submit — the route expects
// application/json, which a native form submit doesn't send.
//
// Two-factor login is still ONE request carrying everything (see routes/admin-auth.js). The first try sends
// the username and password; an account with 2FA answers { needs_code: true } and logs nobody in. The page
// then shows the code field, locks the two fields above it, and the next try sends all three. A recovery
// code goes in the same field: the server tells the two kinds apart by their shape.

const loginForm = document.getElementById("admin-login-form");
const codeField = {
  label: document.getElementById("admin-login-code-label"),
  input: document.getElementById("code"),
  hint: document.getElementById("admin-login-code-hint"),
  back: document.getElementById("admin-login-back"),
};
let asksForCode = false;

// Step two: the code field is shown, the username and password can no longer be edited (they are sent again with the code).
function showCodeStep(on) {
  asksForCode = on;
  for (const el of [codeField.label, codeField.input, codeField.hint, codeField.back]) el.hidden = !on;
  document.getElementById("username").readOnly = on;
  document.getElementById("password").readOnly = on;
  codeField.input.value = "";
  if (on) codeField.input.focus();
  else document.getElementById("password").focus();
}

codeField.back.addEventListener("click", () => {
  document.getElementById("admin-login-error").hidden = true;
  showCodeStep(false);
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const errorEl = document.getElementById("admin-login-error");
  errorEl.hidden = true;
  const body = { username, password };
  if (asksForCode) body.code = codeField.input.value;

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // The rate limiter (429) answers in plain text, not JSON — reading it as
      // JSON threw and fell through to the "can't reach the server" message
      // below, which was wrong. So: say what happened, and never assume JSON.
      // (The two-factor lock is also a 429, but it does send JSON.)
      const data = await res.json().catch(() => null);
      if (data && data.error === "two_factor_locked") {
        const minutes = Math.max(1, Math.ceil((data.retry_after || 300) / 60));
        errorEl.textContent = `Bạn đã nhập sai mã 3 lần. Vui lòng thử lại sau ${minutes} phút.`;
      } else if (res.status === 429) {
        errorEl.textContent = "Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.";
      } else if (data && data.error === "invalid_code") {
        errorEl.textContent = "Mã không đúng hoặc đã được dùng rồi. Vui lòng thử lại.";
        codeField.input.select();
      } else {
        errorEl.textContent = (data && data.error) || "Đăng nhập thất bại";
      }
      errorEl.hidden = false;
      return;
    }

    const data = await res.json();
    if (data.needs_code) {
      showCodeStep(true);
      return;
    }
    // Where this role starts (the server decides — see LANDING in admin-auth.js), unless the last
    // admin page used in this browser is known.
    window.location.href = afterLoginTarget(data.landing);
  } catch (err) {
    errorEl.textContent = "Không thể kết nối máy chủ, vui lòng thử lại.";
    errorEl.hidden = false;
  }
});

// The page to open after a login: the last admin page used in this browser (admin-nav.js keeps it), else
// where the server says this role starts. The page it names has its own role check, so a last page that
// this person may not open just sends them to their own first page.
function afterLoginTarget(landing) {
  try {
    const last = localStorage.getItem("bloomy_admin_last");
    if (last && /^admin-[a-z-]+\.html$/.test(last) && last !== "admin-login.html") return last;
  } catch (err) {
    // storage blocked
  }
  return landing || "admin-products.html";
}
