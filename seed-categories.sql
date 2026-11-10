-- Bloomy — Category seed data.
-- Must run BEFORE seed-products.sql — products.category_id references these
-- ids directly (see the comment block at the top of seed-products.sql).
-- Only "Hoa theo mùa" (5) has children; products sit in the child, and the
-- listing's category filter includes children when a parent is picked.

INSERT INTO categories (id, name, parent_id) VALUES
(1, 'Hoa sinh nhật', NULL),
(2, 'Hoa cưới', NULL),
(3, 'Hoa khai trương', NULL),
(4, 'Hoa chia buồn', NULL),
(5, 'Hoa theo mùa', NULL),
(6, 'Set quà tặng', NULL),
(7, 'Tết', 5),
(8, 'Mùa xuân', 5),
(9, 'Mùa hè', 5),
(10, 'Mùa thu', 5),
(11, 'Mùa đông', 5);

SELECT setval('categories_id_seq', 11);
