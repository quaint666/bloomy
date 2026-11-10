// Bloomy — Admin cutoff overrides (holiday/peak-day early deadlines).

// Same Vietnam-time approach as routes/orders.js/checkout.js, on purpose —
// this admin's own device clock/timezone can't be trusted any more than a
// customer's, and this is only ever a UI convenience anyway; the server's
// earlier-than-default check at save time is the real enforcement.
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
function nowVN() {
  return new Date(Date.now() + VN_OFFSET_MS);
}
function todayVNDateString() {
  return nowVN().toISOString().slice(0, 10);
}
function tomorrowVNDateString() {
  const d = nowVN();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Once today's own default (14:00 VN) has passed, an override for TODAY
// is a contradiction: the server only accepts a deadline earlier than the
// date's default, and every same-day time before 14:00 is already in the
// past too — so there is no valid deadline left to offer. Grey today out
// in the date picker rather than let the admin discover that by trial and
// error. "Hạn nhận đơn" is deliberately NOT restricted the same way —
// today is a perfectly normal DEADLINE for a future delivery date (the
// "closes the night before" pattern), so its own date shouldn't be
// excluded just because it happens to be today.
function applyDateMin() {
  const dateInput = document.getElementById("cutoff-date");
  const isPastDefaultCutoff = nowVN().getUTCHours() >= 14;
  const min = isPastDefaultCutoff ? tomorrowVNDateString() : todayVNDateString();
  dateInput.min = min;
  if (dateInput.value && dateInput.value < min) {
    dateInput.value = "";
  }
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("vi-VN");
}

// `deadline` comes back as a real instant (e.g. "2026-02-13T13:00:00.000Z"
// — UTC). Rendered back in Vietnam time for the admin to read, not
// whatever local time zone the browser happens to be in.
function formatDeadline(iso) {
  const vn = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  const date = vn.toISOString().slice(0, 10).split("-").reverse().join("/");
  const time = vn.toISOString().slice(11, 16);
  return `${time} ${date}`;
}

let allOverrides = [];

function renderTable() {
  const body = document.getElementById("admin-cutoffs-body");
  body.innerHTML = "";

  if (allOverrides.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "Chưa có ngày đặc biệt nào.";
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  allOverrides.forEach((override) => {
    const row = document.createElement("tr");

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDate(override.override_date);

    const deadlineCell = document.createElement("td");
    deadlineCell.textContent = formatDeadline(override.deadline);

    const noteCell = document.createElement("td");
    noteCell.className = "admin-table__note";
    noteCell.textContent = override.note || "";
    if (override.note) noteCell.title = override.note;

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-outline admin-table__delete-btn";
    deleteBtn.textContent = "Xoá";
    deleteBtn.dataset.id = override.id;
    actionCell.appendChild(deleteBtn);

    row.append(dateCell, deadlineCell, noteCell, actionCell);
    body.appendChild(row);
  });
}

async function loadOverrides() {
  const errorEl = document.getElementById("admin-cutoffs-error");
  try {
    const res = await fetch("/api/admin/cutoffs");

    if (res.status === 401) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!res.ok) throw new Error("Failed to load overrides");

    allOverrides = await res.json();
    renderTable();
  } catch (err) {
    errorEl.textContent = "Không thể tải danh sách giờ chốt đơn đặc biệt.";
    errorEl.hidden = false;
  }
}

document.getElementById("admin-cutoffs-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("admin-cutoffs-error");
  errorEl.hidden = true;

  const overrideDate = document.getElementById("cutoff-date").value;
  const deadlineLocal = document.getElementById("cutoff-deadline").value; // "YYYY-MM-DDTHH:mm", no timezone
  const note = document.getElementById("cutoff-note").value.trim();

  try {
    const res = await fetch("/api/admin/cutoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        override_date: overrideDate,
        deadline_local: deadlineLocal,
        note: note || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.error === "deadline_not_earlier_than_default") {
        throw new Error("deadline_not_earlier_than_default");
      }
      throw new Error("save_failed");
    }

    document.getElementById("admin-cutoffs-form").reset();
    loadOverrides();
  } catch (err) {
    errorEl.textContent =
      err.message === "deadline_not_earlier_than_default"
        ? "Hạn nhận đơn phải sớm hơn giờ mặc định (14:00 ngày giao hàng) — không thể dùng để dời giờ chốt đơn muộn hơn."
        : "Không thể lưu giờ chốt đơn. Kiểm tra lại ngày và giờ.";
    errorEl.hidden = false;
  }
});

document.getElementById("admin-cutoffs-body").addEventListener("click", async (e) => {
  const button = e.target.closest(".admin-table__delete-btn");
  if (!button) return;
  if (!confirm("Xoá giờ chốt đơn đặc biệt này? Ngày đó sẽ quay về mặc định 14:00.")) return;

  try {
    const res = await fetch(`/api/admin/cutoffs/${button.dataset.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete override");
  } catch (err) {
    alert("Không thể xoá. Vui lòng thử lại.");
  } finally {
    loadOverrides();
  }
});

applyDateMin();
loadOverrides();
