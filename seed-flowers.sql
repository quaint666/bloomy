-- Bloomy — Flower master list (stock is tracked per flower, not per product).
-- Must run BEFORE seed-products.sql — recipes look flowers up by SKU.
-- Prices are per stem (VND). Ranges come from florist/supplier sites, some
-- dated 2021–2024, so "plausible", not live quotes; mai is an estimate.
-- family groups the custom-bouquet builder list. Starting stock: 100 stems each.

INSERT INTO flowers (sku, name, family, price, stock) VALUES
('FL-HONG-DO', 'Hồng đỏ', 'Hồng', 20000, 100),
('FL-HONG-TRANG', 'Hồng trắng', 'Hồng', 20000, 100),
('FL-HONG-PEACH', 'Hồng peach', 'Hồng', 20000, 100),
('FL-HONG-CAM', 'Hồng cam', 'Hồng', 20000, 100),
('FL-HONG-MINI', 'Hồng mini', 'Hồng', 20000, 100),
('FL-HONG-DO-PHAP', 'Hồng đỏ Pháp', 'Hồng', 25000, 100),
('FL-HONG-LAVENDER', 'Hồng lavender', 'Hồng', 25000, 100),
('FL-HONG-PEONY', 'Hồng peony', 'Hồng', 25000, 100),
('FL-HONG-VINTAGE', 'Hồng vintage', 'Hồng', 25000, 100),
('FL-TULIP-HONG', 'Tulip hồng', 'Tulip', 40000, 100),
('FL-TULIP-TRANG', 'Tulip trắng', 'Tulip', 40000, 100),
('FL-TULIP-LAVENDER', 'Tulip lavender', 'Tulip', 40000, 100),
('FL-HUONGDUONG', 'Hướng dương', 'Hướng dương', 25000, 100),
('FL-HUONGDUONG-MINI', 'Hướng dương mini', 'Hướng dương', 15000, 100),
('FL-LY-TRANG', 'Hoa ly trắng', 'Hoa ly', 45000, 100),
('FL-LAN-TRANG', 'Lan hồ điệp trắng', 'Lan hồ điệp', 100000, 100),
('FL-LAN-HONG', 'Lan hồ điệp hồng nhạt', 'Lan hồ điệp', 100000, 100),
('FL-LAN-VANG', 'Lan hồ điệp vàng', 'Lan hồ điệp', 100000, 100),
('FL-LAN-DO', 'Lan hồ điệp đỏ', 'Lan hồ điệp', 100000, 100),
('FL-CAMCHUONG-HONG', 'Cẩm chướng hồng', 'Cẩm chướng', 8000, 100),
('FL-CAMCHUONG-TRANG', 'Cẩm chướng trắng', 'Cẩm chướng', 8000, 100),
('FL-CAMCHUONG-CAM', 'Cẩm chướng cam', 'Cẩm chướng', 8000, 100),
('FL-CUC-TRANG', 'Cúc trắng', 'Cúc', 10000, 100),
('FL-CUC-VANG', 'Cúc vàng', 'Cúc', 10000, 100),
('FL-CUC-CAM', 'Cúc cam', 'Cúc', 10000, 100),
('FL-CUC-DO', 'Cúc đỏ', 'Cúc', 10000, 100),
('FL-CUC-LAVENDER', 'Cúc lavender', 'Cúc', 10000, 100),
('FL-MAUDON-HONG', 'Mẫu đơn hồng', 'Mẫu đơn', 60000, 100),
('FL-MAUDON-TRANG', 'Mẫu đơn trắng', 'Mẫu đơn', 60000, 100),
('FL-HOASAP-TRANG', 'Hoa sáp trắng', 'Hoa sáp', 15000, 100),
('FL-MAI', 'Cành mai', 'Mai', 30000, 100);
