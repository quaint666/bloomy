// Bloomy — Vietnamese labels for values the server sends as codes.
import type { ProductSize } from "../../shared/api-types";

export const SIZE_LABELS: Record<ProductSize, string> = { s: "Nhỏ", m: "Vừa", l: "Lớn" };

// True when a string read from the page (a data attribute, say) is one of the three sizes.
export function isProductSize(value: string | undefined): value is ProductSize {
  return value === "s" || value === "m" || value === "l";
}
