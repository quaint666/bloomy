// Bloomy — values the admin pages share.
import type { AdminRole } from "../../shared/api-types";

// The role names as the staff see them.
export const ROLE_LABELS: Record<AdminRole, string> = { owner: "Chủ shop", manager: "Quản lý", employee: "Nhân viên" };

// localStorage key for the last admin page opened in this browser: admin-nav keeps it, admin-login reads it.
export const ADMIN_LAST_PAGE_KEY = "bloomy_admin_last";
