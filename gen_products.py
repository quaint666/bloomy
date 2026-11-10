# Sandbox-only generator for seed-products.sql. Not shipped.
import math, re, subprocess

def r10k(x):  # nearest 10.000đ, halves up
    return int(math.floor(x / 10000 + 0.5) * 10000)

def rstem(x):  # nearest whole stem, halves up, at least 1
    return max(1, int(math.floor(x + 0.5)))

FLOWER_PRICE = {}
for line in open('seed-flowers.sql', encoding='utf-8'):
    m = re.match(r"\('(FL-[A-Z-]+)',\s*'[^']+',\s*'[^']+',\s*(\d+)", line.strip())
    if m:
        FLOWER_PRICE[m.group(1)] = int(m.group(2))

FAMILY = [  # sku prefix -> flower tag
    ('FL-HONG', 'Hồng'), ('FL-TULIP', 'Tulip'), ('FL-HUONGDUONG', 'Hướng dương'),
    ('FL-LY', 'Hoa ly'), ('FL-LAN', 'Lan hồ điệp'), ('FL-CAMCHUONG', 'Cẩm chướng'),
    ('FL-CUC', 'Cúc'), ('FL-MAUDON', 'Mẫu đơn'), ('FL-HOASAP', 'Hoa sáp'), ('FL-MAI', 'Mai'),
]
def family(sku):
    for p, name in FAMILY:
        if sku == p or sku.startswith(p + '-'):
            return name
    raise ValueError(sku)

STYLE_FEE = {'bo': 30000, 'gio': 80000, 'hop': 100000, 'vong': 80000}

# id, cat, style, status, price(Vừa), image, name, existing description,
# short description, m-recipe, extras (greenery/packaging/gifts), colour tags,
# note on how vague composition words were resolved (for team review)
P = [
 (1,1,'bo','available',890000,'bomaudonlangman.webp','Bó Mẫu đơn Lãng mạn',
  'Bó hoa mẫu đơn hồng plump kết hợp cẩm chướng trắng, gói giấy kraft mềm mại — lựa chọn hoàn hảo cho ngày sinh nhật người thương.',
  'Mẫu đơn hồng đầy đặn cùng cẩm chướng trắng, ngọt ngào cho ngày sinh nhật.',
  {'FL-MAUDON-HONG':8,'FL-CAMCHUONG-TRANG':12,'FL-HONG-PEACH':5},['lá bạc hà','cúc lá nhọn','giấy gói kraft'],['Hồng','Trắng'],
  '"hồng lá bạc hà" đọc là hồng peach + lá bạc hà'),
 (2,2,'bo','sold_out_today',750000,'honglavenderdiudang.webp','Hồng Lavender Dịu dàng',
  'Tông lavender nhẹ nhàng với hồng Pháp và hoa sáp — bó hoa cưới thanh lịch, dịu dàng cho cô dâu.',
  'Hồng lavender và hoa sáp trắng, bó hoa cưới nhẹ nhàng cho cô dâu.',
  {'FL-HONG-LAVENDER':18,'FL-HOASAP-TRANG':6},['lá bạc hà','các ngọc'],['Tím','Trắng'],None),
 (3,3,'bo','available',680000,'bomattroirangro.webp','Bó Mặt trời Rạng rỡ',
  'Tông ấm rực rỡ với hồng cam và hướng dương mini — bó hoa khai trương mang ý nghĩa may mắn, phát đạt.',
  'Hồng cam và hướng dương mini tông ấm, chúc khai trương may mắn.',
  {'FL-HONG-CAM':14,'FL-HUONGDUONG-MINI':10,'FL-CUC-VANG':8},['lá măng'],['Cam','Vàng'],None),
 (4,4,'bo','discontinued',920000,'hoalythanhnha.webp','Hoa Ly Thanh Nhã',
  'Hoa ly trắng tinh khiết kết hợp cúc và lan hồ điệp — bó hoa chia buồn thanh nhã, an ủi chân thành.',
  'Hoa ly trắng, cúc và lan hồ điệp, lời chia buồn trang nhã.',
  {'FL-LY-TRANG':8,'FL-CUC-TRANG':10,'FL-LAN-TRANG':2},['lá dương xỉ'],['Trắng'],None),
 (5,1,'bo','available',850000,'bohongpeachdream.webp','Bó Hồng Peach Dream',
  'Hồng peach ngọt ngào kết hợp mẫu đơn — bó hoa sinh nhật lãng mạn, nữ tính.',
  'Hồng peach và mẫu đơn nhạt, bó hoa sinh nhật nữ tính.',
  {'FL-HONG-PEACH':15,'FL-MAUDON-HONG':4,'FL-CAMCHUONG-HONG':10},['lá bạc hà'],['Hồng'],'"cẩm chướng" → hồng'),
 (6,1,'bo','available',480000,'bohuongduongtuoi.webp','Bó Hướng Dương Tươi',
  'Hướng dương rực rỡ mang năng lượng mặt trời — bó hoa sinh nhật vui tươi, đầy hy vọng.',
  'Hướng dương rực rỡ cùng cúc vàng, vui tươi cho ngày sinh nhật.',
  {'FL-HUONGDUONG':10,'FL-CUC-VANG':8},['lá mướp'],['Vàng'],None),
 (7,1,'bo','available',990000,'bohongpeonymix.webp','Bó Hồng Peony Mix',
  'Bó hồng peony mix với mẫu đơn trắng và cúc lavender — lãng mạn, đầy đặn, dành cho người trân quý.',
  'Hồng peony, mẫu đơn trắng và cúc lavender, đầy đặn và lãng mạn.',
  {'FL-HONG-PEONY':15,'FL-MAUDON-TRANG':5,'FL-CUC-LAVENDER':8},['lá bạc hà'],['Hồng','Trắng','Tím'],None),
 (8,1,'bo','available',720000,'botuliphongngotngao.webp','Bó Tulip Hồng Ngọt Ngào',
  'Tulip hồng Hà Lan tươi mát — bó hoa sinh nhật thanh lịch, trẻ trung.',
  'Tulip hồng và trắng tươi mát, thanh lịch và trẻ trung.',
  {'FL-TULIP-HONG':8,'FL-TULIP-TRANG':4,'FL-CAMCHUONG-HONG':6},['lá bạc hà'],['Hồng','Trắng'],'"cẩm chướng" → hồng'),
 (9,1,'bo','available',650000,'bohongdoclasic.webp','Bó Hồng Đỏ Classic',
  'Bó hồng đỏ cổ điển — đơn giản mà mãnh liệt, dành cho những lời chúc yêu thương chân thành.',
  'Hồng đỏ Pháp gói giấy kraft, cổ điển mà nồng nhiệt.',
  {'FL-HONG-DO-PHAP':20},['lá bạc hà','giấy gói kraft'],['Đỏ'],None),
 (10,1,'set','available',1850000,'setquasinhnhatdeluxe.webp','Set Quà Sinh Nhật Deluxe',
  'Set quà sinh nhật đầy đủ và sang trọng trong hộp quà sang trọng.',
  'Hồng đỏ, lan hồ điệp và socola trong hộp quà sang trọng.',
  {'FL-HONG-DO':20,'FL-LAN-TRANG':5},['socola','thiệp viết tay','hộp quà'],['Đỏ','Trắng'],'"hoa lan" → lan hồ điệp trắng'),
 (11,1,'bo','available',520000,'bocamtuongpastel.webp','Bó Cẩm Chướng Pastel',
  'Cẩm chướng pastel mềm mại — bó hoa nhỏ xinh, ngọt ngào cho ngày sinh nhật bạn thân.',
  'Cẩm chướng hồng và trắng pastel, nhỏ xinh cho bạn thân.',
  {'FL-CAMCHUONG-HONG':25,'FL-CAMCHUONG-TRANG':20},['lá măng'],['Hồng','Trắng'],None),
 (12,1,'bo','available',1150000,'bolanhongdiudang.webp','Bó Lan Hồng Dịu Dàng',
  'Lan hồ điệp hồng nhạt sang trọng — quà sinh nhật cao cấp, để được lâu, ý nghĩa.',
  'Lan hồ điệp hồng nhạt và trắng, quà sinh nhật cao cấp, để được lâu.',
  {'FL-LAN-HONG':6,'FL-LAN-TRANG':3},['lá dương xỉ'],['Hồng','Trắng'],None),
 (13,2,'bo','sold_out_today',1350000,'bohoacodaulavender.webp','Bó Hoa Cô Dâu Lavender',
  'Bó hoa cô dâu tông lavender — dịu dàng, thanh lịch, hoàn hảo cho ngày trọng đại.',
  'Tulip và hồng lavender, bó hoa cô dâu dịu dàng.',
  {'FL-TULIP-LAVENDER':12,'FL-HONG-LAVENDER':18,'FL-HOASAP-TRANG':6},['lá bạc hà'],['Tím','Trắng'],None),
 (14,2,'bo','discontinued',980000,'bohongcuoivintage.webp','Bó Hồng Cưới Vintage',
  'Bó hoa cưới phong cách vintage — hồng Pháp và hoa sáp, lãng mạn và thanh lịch.',
  'Hồng vintage và hoa sáp, bó hoa cưới lãng mạn kiểu cổ điển.',
  {'FL-HONG-VINTAGE':24,'FL-HOASAP-TRANG':6,'FL-CAMCHUONG-HONG':8},['lá bạc hà'],['Hồng'],'"cẩm chướng" → hồng'),
 (15,2,'bo','available',1280000,'bohoacuoipastel.webp','Bó Hoa Cưới Pastel',
  'Bó hoa cưới pastel — mềm mại, nữ tính, cho cô dâu yêu sự dịu dàng.',
  'Hồng peach, mẫu đơn và hoa sáp tông pastel cho cô dâu.',
  {'FL-HONG-PEACH':20,'FL-MAUDON-HONG':7,'FL-CAMCHUONG-HONG':10,'FL-HOASAP-TRANG':5},['lá bạc hà'],['Hồng','Trắng'],'"mẫu đơn", "cẩm chướng" → hồng'),
 (16,2,'bo','available',1100000,'bohongcuoitrang.webp','Bó Hồng Cưới Trắng',
  'Bó hoa cưới trắng tinh khiết — thanh lịch, cổ điển, cho cô dâu mong muốn vẻ đẹp thuần khiết.',
  'Hồng trắng, hoa ly và lan hồ điệp trắng cho cô dâu.',
  {'FL-HONG-TRANG':15,'FL-LY-TRANG':6,'FL-LAN-TRANG':3},['lá dương xỉ'],['Trắng'],None),
 (17,2,'vong','available',450000,'vonghoacuoicotay.webp','Vòng Hoa Cưới Cổ Tay',
  'Vòng hoa cưới cổ tay — xinh xắn, nhẹ nhàng, phụ kiện hoàn hảo cho cô dâu.',
  'Vòng hoa cổ tay từ hồng mini và hoa sáp cho cô dâu, phù dâu.',
  {'FL-HONG-MINI':6,'FL-HOASAP-TRANG':4},['các ngọc','lá bạc hà'],['Hồng','Trắng'],None),
 (18,2,'bo','available',1750000,'bohoacuoisangtrong.webp','Bó Hoa Cưới Sang Trọng',
  'Bó hoa cưới sang trọng với lan hồ điệp — đẳng cấp, bền lâu, cho ngày trọng đại.',
  'Lan hồ điệp trắng, hồng trắng và hoa ly, sang trọng cho ngày cưới.',
  {'FL-LAN-TRANG':8,'FL-HONG-TRANG':15,'FL-LY-TRANG':6},['lá dương xỉ'],['Trắng'],'"hoa ly" → ly trắng'),
 (19,3,'gio','discontinued',1450000,'giohoakhaitruongvang.webp','Giỏ Hoa Khai Trương Vàng',
  'Giỏ hoa khai trương tông vàng rực rỡ — mang ý nghĩa may mắn, phát đạt, thịnh vượng.',
  'Hướng dương, hồng cam và cúc vàng trong giỏ, chúc phát đạt.',
  {'FL-HUONGDUONG':20,'FL-HONG-CAM':20,'FL-CUC-VANG':15},['lá măng','giỏ'],['Vàng','Cam'],None),
 (20,3,'gio','sold_out_today',1550000,'giohoakhaitruongdo.webp','Giỏ Hoa Khai Trương Đỏ',
  'Giỏ hoa khai trương tông đỏ — may mắn, rực rỡ, cho sự khởi đầu thịnh vượng.',
  'Hồng đỏ, cúc đỏ và lan hồ điệp đỏ, giỏ hoa khai trương may mắn.',
  {'FL-HONG-DO':30,'FL-CUC-DO':15,'FL-LAN-DO':4},['lá dương xỉ','giỏ'],['Đỏ'],'"lan đỏ" → lan hồ điệp đỏ'),
 (21,3,'bo','available',780000,'bohoakhaitruonghong.webp','Bó Hoa Khai Trương Hồng',
  'Bó hoa khai trương tông hồng — nhẹ nhàng nhưng vẫn rực rỡ, cho cửa hàng mới.',
  'Hồng peach và cẩm chướng tông hồng, nhẹ nhàng cho cửa hàng mới.',
  {'FL-HONG-PEACH':20,'FL-CAMCHUONG-HONG':12,'FL-CUC-TRANG':8},['lá măng'],['Hồng'],'"cẩm chướng" → hồng, "cúc" → trắng'),
 (22,3,'gio','available',1650000,'giolanhodieptrang.webp','Giỏ Lan Hồ Điệp Trắng',
  'Giỏ lan hồ điệp trắng và hồng nhạt trang trọng — quà khai trương, kỷ niệm cao cấp, để được lâu.',
  'Lan hồ điệp trắng và hồng nhạt trong giỏ mây, trang trọng và bền lâu.',
  {'FL-LAN-TRANG':8,'FL-LAN-HONG':4},['tổ dương xỉ','giỏ mây'],['Trắng','Hồng'],None),
 (23,3,'bo','sold_out_today',690000,'bohoakhaitruongtuoi.webp','Bó Hoa Khai Trương Tươi',
  'Bó hoa khai trương tươi vui — năng động, rực rỡ, cho sự khởi đầu mới.',
  'Hướng dương mini, cúc vàng và hồng cam, tươi vui cho khởi đầu mới.',
  {'FL-HUONGDUONG-MINI':12,'FL-CUC-VANG':10,'FL-HONG-CAM':12},['lá măng'],['Vàng','Cam'],None),
 (24,3,'gio','available',2200000,'giolankhaitruongcaocap.webp','Giỏ Lan Khai Trương Cao Cấp',
  'Giỏ lan hồ điệp cao cấp — quà khai trương đẳng cấp, để được lâu, sang trọng.',
  'Lan hồ điệp trắng và vàng trong giỏ mây, quà khai trương cao cấp.',
  {'FL-LAN-TRANG':10,'FL-LAN-VANG':7},['lá dương xỉ','giỏ mây'],['Trắng','Vàng'],None),
 (25,3,'gio','available',1850000,'giohoakhaitruongmix.webp','Giỏ Hoa Khai Trương Mix',
  'Giỏ hoa khai trương mix nhiều loại — đầy đặn, rực rỡ, ấn tượng mạnh.',
  'Hồng, lan, cúc và hướng dương trong một giỏ đầy đặn, ấn tượng.',
  {'FL-HONG-DO':25,'FL-LAN-TRANG':5,'FL-CUC-VANG':15,'FL-HUONGDUONG':10},['lá măng','giỏ'],['Đỏ','Vàng','Trắng'],'"Hồng" → đỏ, "lan" → lan hồ điệp trắng, "cúc" → vàng'),
 (26,4,'bo','available',820000,'bohoachiabuontrang.webp','Bó Hoa Chia Buồn Trắng',
  'Bó hoa chia buồn trắng tinh khiết — thanh nhã, an ủi, thể hiện sự thành kính.',
  'Hoa ly, cúc và lan hồ điệp trắng, bày tỏ sự thành kính.',
  {'FL-LY-TRANG':6,'FL-CUC-TRANG':15,'FL-LAN-TRANG':2},['lá dương xỉ'],['Trắng'],None),
 (27,4,'bo','available',680000,'bohoachiabuonthanhnha.webp','Bó Hoa Chia Buồn Thanh Nhã',
  'Bó hoa chia buồn thanh nhã — đơn giản, tĩnh lặng, an ủi người ở lại.',
  'Cúc trắng và hoa ly trắng, lời an ủi đơn giản mà chân thành.',
  {'FL-CUC-TRANG':20,'FL-LY-TRANG':7},['lá dương xỉ'],['Trắng'],None),
 (28,4,'bo','available',580000,'bohoachiabuontunhien.webp','Bó Hoa Chia Buồn Tự Nhiên',
  'Bó hoa chia buồn tự nhiên — mộc mạc, chân thành, đơn giản mà ý nghĩa.',
  'Cúc trắng và hoa ly mộc mạc, chia buồn chân thành.',
  {'FL-CUC-TRANG':20,'FL-LY-TRANG':5},['lá dương xỉ','các ngọc'],['Trắng'],'"hoa ly" → ly trắng'),
 (29,4,'vong','sold_out_today',1750000,'vonghoatangle.webp','Vòng Hoa Tang Lễ',
  'Vòng hoa tang lễ trắng — trang trọng, thành kính, thể hiện lòng tôn kính.',
  'Vòng hoa trắng từ lan, cúc và hoa ly, trang trọng cho tang lễ.',
  {'FL-LAN-TRANG':4,'FL-CUC-TRANG':50,'FL-LY-TRANG':10},['lá dương xỉ'],['Trắng'],None),
 (30,4,'bo','sold_out_today',750000,'bohoachiabuonlavender.webp','Bó Hoa Chia Buồn Lavender',
  'Bó hoa chia buồn tông lavender — dịu nhẹ, thanh nhã, an ủi chân thành.',
  'Tulip lavender và cúc trắng, dịu nhẹ và thanh nhã.',
  {'FL-TULIP-LAVENDER':10,'FL-CUC-TRANG':10,'FL-HOASAP-TRANG':5},['lá bạc hà'],['Tím','Trắng'],None),
 (31,4,'gio','available',1950000,'giohoachiabuonlon.webp','Giỏ Hoa Chia Buồn Lớn',
  'Giỏ hoa chia buồn lớn — trang trọng, đầy đủ, thể hiện sự thành kính sâu sắc.',
  'Giỏ lớn lan, cúc và hoa ly trắng, trang trọng và thành kính.',
  {'FL-LAN-TRANG':6,'FL-CUC-TRANG':30,'FL-LY-TRANG':13},['lá dương xỉ','giỏ'],['Trắng'],'"hoa ly" → ly trắng'),
 (32,7,'bo','available',1250000,'bohoatetrucro.webp','Bó Hoa Tết Rực Rỡ',
  'Bó hoa Tết — rực rỡ, may mắn, mang không khí xuân tươi vui.',
  'Hồng đỏ, cúc vàng, lan và mai, rực rỡ đón Tết.',
  {'FL-HONG-DO':20,'FL-CUC-VANG':15,'FL-LAN-VANG':2,'FL-MAI':7},['lá dương xỉ'],['Đỏ','Vàng'],'"lan" → lan hồ điệp vàng'),
 (33,8,'bo','available',820000,'botulipmuaxuanhong.webp','Bó Tulip Mùa Xuân Hồng',
  'Tulip hồng mùa xuân — tươi mát, rực rỡ, mang sức sống của mùa mới.',
  'Tulip hồng Hà Lan tươi mát, mang sức sống mùa xuân.',
  {'FL-TULIP-HONG':14,'FL-CAMCHUONG-HONG':8},['lá bạc hà'],['Hồng'],'"cẩm chướng" → hồng'),
 (34,8,'bo','sold_out_today',780000,'botulipmuaxuan.webp','Bó Tulip Mùa Xuân',
  'Tulip hồng và lavender tươi mát — bó hoa theo mùa xuân, nhẹ nhàng và đầy sức sống.',
  'Tulip hồng và lavender, nhẹ nhàng đầy sức sống mùa xuân.',
  {'FL-TULIP-HONG':8,'FL-TULIP-LAVENDER':6,'FL-CAMCHUONG-HONG':5},['lá bạc hà'],['Hồng','Tím'],'"cẩm chướng" → hồng'),
 (35,9,'bo','sold_out_today',690000,'bohoamuaherucro.webp','Bó Hoa Mùa Hè Rực Rỡ',
  'Bó hoa mùa hè — rực rỡ, năng động, mang theo nắng ấm và niềm vui.',
  'Hướng dương, cúc vàng và hồng cam, rực rỡ như nắng hè.',
  {'FL-HUONGDUONG':10,'FL-CUC-VANG':10,'FL-HONG-CAM':9},['lá măng'],['Vàng','Cam'],None),
 (36,8,'bo','available',950000,'bohoamualangman.webp','Bó Hoa Xuân Lãng Mạn',
  'Bó hoa lãng mạn — tulip và hồng peony, cho những khoảnh khắc ngọt ngào.',
  'Tulip và hồng peony mùa xuân, cho khoảnh khắc ngọt ngào.',
  {'FL-TULIP-HONG':8,'FL-HONG-PEONY':14,'FL-CAMCHUONG-HONG':8},['lá bạc hà'],['Hồng'],'"Tulip", "cẩm chướng" → hồng; đổi tên từ "Bó Hoa Mùa Lãng Mạn"'),
 (37,10,'bo','available',780000,'bohoamuathuam.webp','Bó Hoa Mùa Thu Ấm',
  'Bó hoa mùa thu — ấm áp, ngọt ngào, với tông cam peach dịu nhẹ.',
  'Hồng peach, cẩm chướng cam và cúc tông ấm mùa thu.',
  {'FL-HONG-PEACH':20,'FL-CAMCHUONG-CAM':12,'FL-CUC-CAM':10},['lá bạc hà'],['Cam'],'"cúc" → cam'),
 (38,11,'bo','discontinued',890000,'bohoamuadongthanhlich.webp','Bó Hoa Mùa Đông Thanh Lịch',
  'Bó hoa mùa đông thanh lịch — trắng tinh khiết, tĩnh lặng, đầy sức sống.',
  'Hoa ly, lan hồ điệp và cúc trắng, thanh lịch mùa đông.',
  {'FL-LY-TRANG':6,'FL-LAN-TRANG':3,'FL-CUC-TRANG':12},['lá dương xỉ'],['Trắng'],None),
 (39,10,'bo','available',450000,'bocucmuathu.webp','Bó Cúc Mùa Thu',
  'Bó cúc mùa thu — rực rỡ, vui tươi, mang theo hồn thu trong từng cánh hoa.',
  'Cúc vàng và cúc cam, vui tươi mang hồn thu.',
  {'FL-CUC-VANG':15,'FL-CUC-CAM':12,'FL-CAMCHUONG-CAM':8},['lá măng'],['Vàng','Cam'],'"cẩm chướng" → cam'),
 (40,6,'set','available',1350000,'setquatangme.webp','Set Quà Tặng Mẹ',
  'Set quà tặng mẹ — đầy yêu thương, hồng đỏ và socola, cho ngày của Mẹ.',
  'Hồng đỏ, cẩm chướng và socola, món quà yêu thương tặng mẹ.',
  {'FL-HONG-DO':25,'FL-CAMCHUONG-HONG':25},['socola','thiệp','hộp quà'],['Đỏ','Hồng'],'"cẩm chướng" → hồng'),
 (41,6,'hop','available',1250000,'hopquahongcaocap.webp','Hộp Quà Hồng Cao Cấp',
  'Hộp quà cao cấp với hồng đỏ và hoa lan, đính satin — set quà tặng sang trọng cho dịp đặc biệt.',
  'Hồng đỏ và lan hồ điệp trong hộp đính satin, sang trọng.',
  {'FL-HONG-DO':25,'FL-CAMCHUONG-HONG':10,'FL-LAN-TRANG':3},['lá bạc hà','hộp quà'],['Đỏ'],'"hoa lan" → lan hồ điệp trắng'),
 (42,6,'set','sold_out_today',980000,'setquahongsocola.webp','Set Quà Hồng & Socola',
  'Set quà hồng và socola — lãng mạn, ngọt ngào, hoàn hảo cho ngày kỷ niệm.',
  'Hồng đỏ và socola Bỉ, ngọt ngào cho ngày kỷ niệm.',
  {'FL-HONG-DO':24},['socola Bỉ','thiệp viết tay','hộp quà'],['Đỏ'],None),
 (43,6,'set','available',1580000,'setquahoatuoimix.webp','Set Quà Hoa Tươi Mix',
  'Set quà hoa tươi mix — đầy đặn, sang trọng, cho mọi dịp đặc biệt.',
  'Lan hồ điệp, hồng và cẩm chướng cùng socola trong hộp luxury.',
  {'FL-LAN-TRANG':4,'FL-HONG-DO':15,'FL-CAMCHUONG-HONG':10},['socola','thiệp','hộp luxury'],['Trắng','Đỏ','Hồng'],'"hồng" → đỏ'),
 (44,6,'set','available',580000,'setquasinhnhatnho.webp','Set Quà Sinh Nhật Nhỏ',
  'Set quà sinh nhật nhỏ gọn — xinh xắn, ngọt ngào, cho bạn thân.',
  'Hồng mini, cúc và kẹo trong hộp nhỏ xinh cho bạn thân.',
  {'FL-HONG-MINI':10,'FL-CUC-VANG':9},['kẹo','thiệp','hộp nhỏ'],['Hồng','Vàng'],'"cúc" → vàng'),
 (45,6,'set','discontinued',1280000,'setquahoanenthom.webp','Set Quà Hoa & Nến Thơm',
  'Set quà hoa và nến thơm — lãng mạn, thư giãn, cho người trân quý.',
  'Hồng, lan hồ điệp và nến thơm, lãng mạn và thư giãn.',
  {'FL-HONG-DO':17,'FL-LAN-TRANG':3},['nến thơm','thiệp','hộp quà'],['Đỏ','Trắng'],'"hồng" → đỏ, "hoa lan" → lan hồ điệp trắng'),
 (46,6,'hop','available',1150000,'hopquahoapastel.webp','Hộp Quà Hoa Pastel',
  'Hộp quà hoa pastel — mềm mại, nữ tính, cho người yêu sự dịu dàng.',
  'Hồng peach, cẩm chướng và hoa sáp trong hộp nơ tông pastel.',
  {'FL-HONG-PEACH':30,'FL-CAMCHUONG-HONG':15,'FL-HOASAP-TRANG':8},['lá bạc hà','hộp nơ'],['Hồng'],'"cẩm chướng" → hồng'),
 (47,6,'hop','available',1650000,'hopquahoalancaocap.webp','Hộp Quà Hoa Lan Cao Cấp',
  'Hộp quà hoa lan cao cấp — sang trọng, đẳng cấp, cho dịp đặc biệt.',
  'Lan hồ điệp trắng và hồng đỏ trong hộp quà sang trọng.',
  {'FL-LAN-TRANG':8,'FL-HONG-DO':20},['thiệp','hộp quà sang trọng'],['Trắng','Đỏ'],'"lan hồ điệp" → trắng, "hồng" → đỏ'),
 (48,6,'set','available',1080000,'setquatangchigai.webp','Set Quà Tặng Chị Gái',
  'Set quà tặng chị gái — ngọt ngào, ấm áp, cho người chị yêu thương.',
  'Hồng peach, cúc và kẹo, món quà ấm áp tặng chị gái.',
  {'FL-HONG-PEACH':22,'FL-CUC-TRANG':10},['kẹo','thiệp','hộp quà'],['Hồng'],'"cúc" → trắng'),
 (49,6,'hop','available',1450000,'hopquahoatrang.webp','Hộp Quà Hoa Trắng',
  'Hộp quà hoa trắng — thanh lịch, trang trọng, cho dịp đặc biệt.',
  'Hoa ly, lan hồ điệp và cúc trắng trong hộp sang trọng.',
  {'FL-LY-TRANG':8,'FL-LAN-TRANG':6,'FL-CUC-TRANG':12},['hộp sang trọng'],['Trắng'],None),
 (50,6,'set','sold_out_today',2250000,'setquakiniemdeluxe.webp','Set Quà Kỷ Niệm Deluxe',
  'Set quà kỷ niệm deluxe — đầy đủ, sang trọng, cho ngày trọng đại.',
  'Hồng đỏ, lan, socola và gấu bông trong hộp luxury.',
  {'FL-HONG-DO':30,'FL-LAN-TRANG':5},['socola','gấu bông','thiệp','hộp luxury'],['Đỏ','Trắng'],'"lan" → lan hồ điệp trắng'),
]

# The 5 hand-written SEO rows (3 Oct notes §5). Price text filled in below
# from the smallest size, since these are all sized products now.
SEO = {
 9: ('bó hoa hồng đỏ', 'Bó Hoa Hồng Đỏ Classic Giao Đúng Ngày | Bloomy',
     'Bó hoa hồng đỏ Classic với hồng đỏ Pháp và lá bạc hà, gói giấy kraft. Chọn ngày và khung giờ giao tại TP.HCM, giá từ {p}.'),
 5: ('hoa hồng peach', 'Bó Hoa Hồng Peach Dream Tặng Sinh Nhật | Bloomy',
     'Bó hoa hồng peach Dream kết hợp mẫu đơn nhạt và cẩm chướng, dịu dàng cho ngày sinh nhật. Chọn ngày giờ giao tại TP.HCM, giá từ {p}.'),
 16: ('hoa cưới cầm tay', 'Hoa Cưới Cầm Tay Hồng Trắng Cho Cô Dâu | Bloomy',
     'Hoa cưới cầm tay hồng trắng, hoa ly và lan hồ điệp trắng cho cô dâu. Đặt trước và chọn ngày giờ giao tại TP.HCM, giá từ {p}.'),
 3: ('hoa khai trương', 'Bó Hoa Khai Trương Mặt Trời Rạng Rỡ | Bloomy',
     'Bó hoa khai trương tông cam với hồng cam và hướng dương mini, mang ý nghĩa may mắn, phát đạt. Chọn ngày giờ giao tại TP.HCM, giá từ {p}.'),
 27: ('hoa chia buồn', 'Bó Hoa Chia Buồn Thanh Nhã Giao Đúng Giờ | Bloomy',
     'Bó hoa chia buồn thanh nhã từ cúc trắng và hoa ly trắng, gửi lời an ủi chân thành. Chọn ngày giờ giao tại TP.HCM, giá từ {p}.'),
}

FEATURED = {3, 5, 9, 16}

EXTERNAL = dict(
  id=51, cat=6, status='available', price=150000, image='binhthuytinhtrutron.jpg',
  name='Bình Thủy Tinh Trụ Tròn',
  short='Bình thủy tinh trong suốt để cắm hoa sau khi nhận, đặt mua tại Ironstyle.',
  desc='Bình thủy tinh trụ tròn trong suốt, hợp với hoa cành dài như hồng, mẫu đơn, hoa ly. '
       'Sản phẩm do Ironstyle (TP.HCM) bán, có nhiều kích thước; giá hiển thị là size nhỏ nhất. '
       'Bấm nút mua để đặt trên trang của Ironstyle.',
  url='https://ironstyle.vn/lo-cam-hoa-thuy-tinh-tru-tron-ban-le-theo-size/2355.html')

def q(s):
    return "NULL" if s is None else "'" + s.replace("'", "''") + "'"

def vnd(n):
    return f"{n:,}".replace(',', '.') + 'đ'

def join_vi(items):
    return items[0] if len(items) == 1 else ', '.join(items[:-1]) + ' và ' + items[-1]

def sizes_for(p):
    pid, cat, style, _, price = p[0], p[1], p[2], p[3], p[4]
    sized = style == 'bo' and cat in (1, 2, 3, 4, 5, 7, 8, 9, 10, 11)
    recipe = p[9]
    if not sized:
        return [('m', price, recipe)]
    return [('s', r10k(price * 0.7), {k: rstem(v * 0.6) for k, v in recipe.items()}),
            ('m', price, recipe),
            ('l', r10k(price * 1.4), {k: rstem(v * 1.5) for k, v in recipe.items()})]

out = []
w = out.append
w("-- Bloomy — Product seed data (50 flower products + 1 external product).")
w("-- GENERATED, do not hand-edit row by row: prices for Nhỏ/Lớn are 70%/140% of")
w("-- Vừa rounded to the nearest 10.000đ; stems are 60%/150% of Vừa, rounded,")
w("-- at least 1. Only \"bó\" products in the flower categories get 3 sizes;")
w("-- everything else has a single 'm' row (shown as a plain single product).")
w("-- Must run AFTER seed-categories.sql and seed-flowers.sql.")
w("-- featured = homepage cards (3, 5, 9, 16); toggled in admin afterwards.")
w("-- ids 1–50 are kept from the old seed: image paths and the product URLs")
w("-- already indexed by Search Console depend on them.")
w("-- category_id: 1=Hoa sinh nhật, 2=Hoa cưới, 3=Hoa khai trương, 4=Hoa chia buồn,")
w("--              6=Set quà tặng, 7=Tết, 8=Mùa xuân, 9=Mùa hè, 10=Mùa thu, 11=Mùa đông")
w("-- Flower quantities are DRAFTS for the team to review. Where the old")
w("-- composition text was vague, the guess is noted in the comment above the row.")
w("")
w("INSERT INTO products (id, category_id, sku, name, short_description, description, image, status, featured, product_type, style, external_url, seo_keyword, seo_title, seo_description) VALUES")
rows = []
sizes_sql, recipe_sql, tag_sql = [], [], []
report = []
for p in P:
    pid, cat, style, status, price, image, name, desc, short, recipe, extras, colors, note = p
    sizes = sizes_for(p)
    full_desc = desc + ' Kèm ' + join_vi(extras) + '.'
    seo = SEO.get(pid)
    if seo:
        smallest = min(s[1] for s in sizes)
        seo = (seo[0], seo[1], seo[2].format(p=vnd(smallest)))
    sku = f"BLM-{pid:04d}"
    comment = f"-- #{pid}" + (f" ({note})" if note else "")
    rows.append(comment + "\n(" + ", ".join([str(pid), str(cat), q(sku), q(name), q(short), q(full_desc),
        q('images/' + image), q(status), 'true' if pid in FEATURED else 'false', q('standard'), q(style), 'NULL',
        q(seo[0] if seo else None), q(seo[1] if seo else None), q(seo[2] if seo else None)]) + ")")
    for size, sprice, srecipe in sizes:
        ssku = f"{sku}-{size.upper()}"
        sizes_sql.append(f"({pid}, {q(size)}, {q(ssku)}, {sprice})")
        for fsku, n in srecipe.items():
            recipe_sql.append(f"({q(ssku)}, {q(fsku)}, {n})")
    fams = sorted({family(f) for f in recipe})
    for t in fams:
        tag_sql.append(f"({pid}, 'flower', {q(t)})")
    for c in colors:
        tag_sql.append(f"({pid}, 'color', {q(c)})")
    cost = sum(FLOWER_PRICE[f] * n for f, n in recipe.items())
    base = price - STYLE_FEE.get(style, 0)
    report.append((pid, style, price, cost, cost / (price if style == 'set' else base), sum(recipe.values())))
    if seo:
        report.append(('seo', pid, len(seo[1]), len(seo[2]), seo[0] in seo[1].lower(), seo[0] in seo[2].lower()))

e = EXTERNAL
rows.append("-- #51 external product: never enters the cart, no recipe, no stock\n(" + ", ".join([
    str(e['id']), str(e['cat']), q('BLM-0051'), q(e['name']), q(e['short']), q(e['desc']),
    q('images/' + e['image']), q(e['status']), 'false', q('external'), 'NULL', q(e['url']), 'NULL', 'NULL', 'NULL']) + ")")
sizes_sql.append(f"(51, 'm', 'BLM-0051-M', {e['price']})")

w(",\n\n".join(rows) + ";")
w("")
w("SELECT setval('products_id_seq', 51, true);")
w("")
w("INSERT INTO product_sizes (product_id, size, sku, price) VALUES")
w(",\n".join(sizes_sql) + ";")
w("")
w("-- Looked up by SKU so the file never depends on generated ids.")
w("INSERT INTO recipes (size_id, flower_id, quantity)")
w("SELECT ps.id, f.id, v.quantity")
w("FROM (VALUES")
w(",\n".join(recipe_sql))
w(") AS v(size_sku, flower_sku, quantity)")
w("JOIN product_sizes ps ON ps.sku = v.size_sku")
w("JOIN flowers f ON f.sku = v.flower_sku;")
w("")
all_tags = sorted({(k, n) for k, n in [(t.split(', ')[1].strip("'"), t.split(', ')[2].rstrip(")").strip("'")) for t in tag_sql]})
w("INSERT INTO tags (kind, name) VALUES")
w(",\n".join(f"({q(k)}, {q(n)})" for k, n in all_tags) + ";")
w("")
w("INSERT INTO product_tags (product_id, tag_id)")
w("SELECT v.product_id, t.id")
w("FROM (VALUES")
w(",\n".join(tag_sql))
w(") AS v(product_id, kind, name)")
w("JOIN tags t ON t.kind = v.kind::tag_kind AND t.name = v.name;")
w("")

open('seed-products.sql', 'w', encoding='utf-8').write("\n".join(out))
for r in report:
    print(r)
print('recipe rows', len(recipe_sql), 'size rows', len(sizes_sql), 'tag links', len(tag_sql))
