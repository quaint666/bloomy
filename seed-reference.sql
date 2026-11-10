-- Bloomy — reference data the running shop needs: delivery wards, the one
-- settings row, the coupons and the two occasion campaigns. Must run AFTER
-- schema.sql AND seed-products.sql (the campaigns pick their products by SKU).

-- HCMC wards after the 1 July 2025 merger, from GHTK's list of the 168 new
-- units (https://ghtk.vn/blog/danh-sach-168-xa-phuong-moi-cua-thanh-pho-ho-chi-minh-sau-sap-nhap/,
-- page dated 5 Dec 2025). Only the 102 former-HCMC rows are used, minus
-- Xã Thạnh An (island), so 101 wards; no Bình Dương / Vũng Tàu delivery.
-- Rings around the shop (Phường Sài Gòn), by GHTK row number:
--   ring 1 (20): 1–13, 25–27, 53–55, 78 (An Khánh)
--   ring 2 (38): 14–24, 28–31, 42–52, 56–66, 76 (Bình Trưng)
--   ring 3 (43): 32–41, 67–75, 77, 113–135
INSERT INTO wards (name, ring) VALUES
('Phường Sài Gòn', 1),
('Phường Tân Định', 1),
('Phường Bến Thành', 1),
('Phường Cầu Ông Lãnh', 1),
('Phường Bàn Cờ', 1),
('Phường Xuân Hòa', 1),
('Phường Nhiêu Lộc', 1),
('Phường Xóm Chiếu', 1),
('Phường Khánh Hội', 1),
('Phường Vĩnh Hội', 1),
('Phường Chợ Quán', 1),
('Phường An Đông', 1),
('Phường Chợ Lớn', 1),
('Phường Bình Tây', 2),
('Phường Bình Tiên', 2),
('Phường Bình Phú', 2),
('Phường Phú Lâm', 2),
('Phường Tân Thuận', 2),
('Phường Phú Thuận', 2),
('Phường Tân Mỹ', 2),
('Phường Tân Hưng', 2),
('Phường Chánh Hưng', 2),
('Phường Phú Định', 2),
('Phường Bình Đông', 2),
('Phường Diên Hồng', 1),
('Phường Vườn Lài', 1),
('Phường Hòa Hưng', 1),
('Phường Minh Phụng', 2),
('Phường Bình Thới', 2),
('Phường Hòa Bình', 2),
('Phường Phú Thọ', 2),
('Phường Đông Hưng Thuận', 3),
('Phường Trung Mỹ Tây', 3),
('Phường Tân Thới Hiệp', 3),
('Phường Thới An', 3),
('Phường An Phú Đông', 3),
('Phường An Lạc', 3),
('Phường Bình Tân', 3),
('Phường Tân Tạo', 3),
('Phường Bình Trị Đông', 3),
('Phường Bình Hưng Hòa', 3),
('Phường Gia Định', 2),
('Phường Bình Thạnh', 2),
('Phường Bình Lợi Trung', 2),
('Phường Thạnh Mỹ Tây', 2),
('Phường Bình Quới', 2),
('Phường Hạnh Thông', 2),
('Phường An Nhơn', 2),
('Phường Gò Vấp', 2),
('Phường An Hội Đông', 2),
('Phường Thông Tây Hội', 2),
('Phường An Hội Tây', 2),
('Phường Đức Nhuận', 1),
('Phường Cầu Kiệu', 1),
('Phường Phú Nhuận', 1),
('Phường Tân Sơn Hòa', 2),
('Phường Tân Sơn Nhất', 2),
('Phường Tân Hòa', 2),
('Phường Bảy Hiền', 2),
('Phường Tân Bình', 2),
('Phường Tân Sơn', 2),
('Phường Tây Thạnh', 2),
('Phường Tân Sơn Nhì', 2),
('Phường Phú Thọ Hòa', 2),
('Phường Tân Phú', 2),
('Phường Phú Thạnh', 2),
('Phường Hiệp Bình', 3),
('Phường Thủ Đức', 3),
('Phường Tam Bình', 3),
('Phường Linh Xuân', 3),
('Phường Tăng Nhơn Phú', 3),
('Phường Long Bình', 3),
('Phường Long Phước', 3),
('Phường Long Trường', 3),
('Phường Cát Lái', 3),
('Phường Bình Trưng', 2),
('Phường Phước Long', 3),
('Phường An Khánh', 1),
('Xã Vĩnh Lộc', 3),
('Xã Tân Vĩnh Lộc', 3),
('Xã Bình Lợi', 3),
('Xã Tân Nhựt', 3),
('Xã Bình Chánh', 3),
('Xã Hưng Long', 3),
('Xã Bình Hưng', 3),
('Xã Bình Khánh', 3),
('Xã An Thới Đông', 3),
('Xã Cần Giờ', 3),
('Xã Củ Chi', 3),
('Xã Tân An Hội', 3),
('Xã Thái Mỹ', 3),
('Xã An Nhơn Tây', 3),
('Xã Nhuận Đức', 3),
('Xã Phú Hòa Đông', 3),
('Xã Bình Mỹ', 3),
('Xã Đông Thạnh', 3),
('Xã Hóc Môn', 3),
('Xã Xuân Thới Sơn', 3),
('Xã Bà Điểm', 3),
('Xã Nhà Bè', 3),
('Xã Hiệp Phước', 3);

-- Exactly one row (the table only allows id = true). Fees are per ring, in đồng.
INSERT INTO settings (shop_address, contact_phone, contact_email, vat_rate, ring1_fee, ring2_fee, ring3_fee) VALUES
('27 Nguyễn Huệ, phường Sài Gòn, TP.HCM', '0900000000', 'hello@bloomy.example', 10, 25000, 35000, 45000);

-- BLOOMY50: 50.000đ off goods worth 800.000đ or more. No date window, no usage limit.
-- The two campaign coupons take a percentage off ANY order, for orders that are
-- DELIVERED inside the window (the window is checked against the delivery date).
INSERT INTO coupons (code, type, value, min_subtotal, starts_on, ends_on) VALUES
('BLOOMY50', 'fixed', 50000, 800000, NULL, NULL),
('PHUNU20', 'percent', 20, 0, '2026-10-15', '2026-10-25'),
('THAYCO20', 'percent', 20, 0, '2026-11-15', '2026-11-22');

-- Two occasion campaigns. The wording is page copy; the coupon's code, value
-- and dates are read live from `coupons` and never typed into the page.
INSERT INTO campaigns (id, name, headline, subheadline, coupon_code) VALUES
(1, 'Gửi một chút thương ngày 20/10', 'Tặng một bó hoa, gửi thêm một lời thương', 'Một món quà nhỏ cho người bạn luôn yêu quý.', 'PHUNU20'),
(2, 'Gửi lời thương đến thầy cô', 'Một bó hoa, thay lời cảm ơn chân thành', 'Một chút hoa, một lời cảm ơn thật lòng.', 'THAYCO20');
SELECT setval('campaigns_id_seq', 2);

-- Their products, looked up by SKU, in the order they are shown.
INSERT INTO campaign_products (campaign_id, product_id, sort_order)
SELECT v.campaign_id, p.id, v.sort_order
FROM (VALUES
  (1, 'BLM-0005', 1), (1, 'BLM-0001', 2), (1, 'BLM-0007', 3), (1, 'BLM-0008', 4), (1, 'BLM-0040', 5), (1, 'BLM-0048', 6),
  (2, 'BLM-0006', 1), (2, 'BLM-0003', 2), (2, 'BLM-0011', 3), (2, 'BLM-0039', 4), (2, 'BLM-0046', 5), (2, 'BLM-0012', 6)
) AS v(campaign_id, sku, sort_order)
JOIN products p ON p.sku = v.sku;

-- A mistyped SKU would quietly add fewer rows; stop the seed instead.
DO $$
BEGIN
  IF (SELECT count(*) FROM campaign_products) <> 12 THEN
    RAISE EXCEPTION 'campaign_products: expected 12 rows, got %', (SELECT count(*) FROM campaign_products);
  END IF;
END $$;

-- The 20/10 campaign is switched on, so the demo shows its landing page
-- (the owner changes this in Cài đặt).
UPDATE settings SET active_campaign_id = 1;
