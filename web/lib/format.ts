// Bloomy — how values are shown to the shopkeeper.

// Money in whole đồng: 1234567 -> "1.234.567đ".
export function formatVND(price: number): string {
  return price.toLocaleString("vi-VN") + "đ";
}
