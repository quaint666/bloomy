-- Bloomy — gallery photos (extra photos per product, beyond products.image).
-- Loaded after seed-products.sql, so product ids exist (ids 1-50 are stable).
-- Each row is one extra photo: product by id, the relative path of a file that
-- already sits in public/images/, and sort_order (0, 1, 2... = left to right
-- after the main photo). The product page shows the thumbnail strip only for a
-- product that has at least one row here.
--
-- Add a row ONLY when the file exists in public/images/ — a row for a missing
-- file shows as a broken image. Photos are square (1:1), 900 px.
-- Rows added by hand in the database are lost on a production wipe; rows in
-- this file are not, so keep it as the single source for gallery data.
--
-- Product 9 (Bó Hồng Đỏ Classic, size Vừa): close-up, held, wrapping, card, scale.
INSERT INTO product_images (product_id, image, sort_order) VALUES
(9, 'images/bohongdoclasic-2.webp', 0),
(9, 'images/bohongdoclasic-3.webp', 1),
(9, 'images/bohongdoclasic-4.webp', 2),
(9, 'images/bohongdoclasic-5.webp', 3),
(9, 'images/bohongdoclasic-6.webp', 4);
