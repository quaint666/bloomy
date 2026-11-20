# Sandbox-only generator for seed-products-2.sql (the second catalogue seed: 54 products for Peekbox's six occasions,
# plus the six occasion tags and their links to the first 50 products). Not shipped, like gen_products.py.
#
#   python3 gen_products2.py            writes seed-products-2.sql, prints a pricing report
#
# Unlike seed-products.sql this file is ADDITIVE and idempotent, because it must also run on a live shop
# (/seed-more.sh): no fixed ids, everything is looked up by SKU or by (kind, name), and every INSERT ends in
# ON CONFLICT DO NOTHING, so running it twice changes nothing. Products are never touched once they exist.
import math, re

def r10k(x):  # nearest 10.000đ, halves up
    return int(math.floor(x / 10000 + 0.5) * 10000)

def rstem(x):  # nearest whole stem, halves up, at least 1
    return max(1, int(math.floor(x + 0.5)))

FLOWER_PRICE = {}
for line in open('seed-flowers.sql', encoding='utf-8'):
    m = re.match(r"\('(FL-[A-Z-]+)',\s*'[^']+',\s*'[^']+',\s*(\d+)", line.strip())
    if m:
        FLOWER_PRICE[m.group(1)] = int(m.group(2))

FAMILY = [  # sku prefix -> flower tag (same as gen_products.py)
    ('FL-HONG', 'Hồng'), ('FL-TULIP', 'Tulip'), ('FL-HUONGDUONG', 'Hướng dương'),
    ('FL-LY', 'Hoa ly'), ('FL-LAN', 'Lan hồ điệp'), ('FL-CAMCHUONG', 'Cẩm chướng'),
    ('FL-CUC', 'Cúc'), ('FL-MAUDON', 'Mẫu đơn'), ('FL-HOASAP', 'Hoa sáp'), ('FL-MAI', 'Mai'),
]
def family(sku):
    for p, name in FAMILY:
        if sku == p or sku.startswith(p + '-'):
            return name
    raise ValueError(sku)

STYLE_FEE = {'bo': 30000, 'gio': 80000, 'hop': 100000, 'vong': 80000, 'set': 0}
SIZED_CATEGORIES = (1, 2, 3, 4, 5, 7, 8, 9, 10, 11)  # only "bó" in these get Nhỏ / Vừa / Lớn, as in the first seed

# The six occasions, in calendar order: the order here is the order of their ids, which is the order the filter shows
# (routes/tags.ts, compareTags). The names are Peekbox's (content/data/hampers.json) and must match.
OCC = {'tet': 'Tết', 'val': 'Valentine', 'women': '8/3 và 20/10', 'moon': 'Trung thu', 'teach': '20/11', 'xmas': 'Giáng sinh'}

# Existing products (ids 1-50 keep their SKU BLM-00nn) that fit an occasion. Only ones a customer can still buy.
OLD = {
    'tet': [32], 'val': [9, 41, 42], 'women': [5, 8, 11, 33, 36, 40, 46, 48], 'moon': [37, 39],
    'teach': [6, 12], 'xmas': [43, 50],
}

# category: 1 sinh nhật, 2 cưới, 3 khai trương, 6 set quà tặng, 7 Tết, 8 mùa xuân, 10 mùa thu, 11 mùa đông
# (cat, style, name, image file stem, short description, description, recipe M, extras, colour tags, occasions)
N = [
 # ---- Tết (10) -> category 7
 (7,'bo','Bó Mai Vàng Đón Xuân','bomaivangdonxuan','Cành mai vàng, cúc vàng và hướng dương mini, rộn ràng đón xuân.','Cành mai vàng bung nở cùng cúc vàng và hướng dương mini — bó hoa Tết mang lộc đầu năm, rực rỡ cả gian nhà.',{'FL-MAI':6,'FL-CUC-VANG':10,'FL-HUONGDUONG-MINI':6},['lá măng','dây ruy băng đỏ'],['Vàng'],['tet']),
 (7,'bo','Bó Hồng Đỏ Phát Lộc','bohongdophatloc','Hồng đỏ, cúc vàng và cành mai, chúc năm mới phát tài.','Hồng đỏ thắm kết hợp cúc vàng và cành mai — bó hoa Tết cầu mong một năm phát tài, phát lộc.',{'FL-HONG-DO':12,'FL-CUC-VANG':10,'FL-MAI':3},['lá bạc hà','giấy gói đỏ'],['Đỏ','Vàng'],['tet']),
 (7,'bo','Bó Cúc Vàng Cát Tường','bocucvangcattuong','Cúc vàng và cẩm chướng cam, tươi lâu suốt những ngày Tết.','Cúc vàng và cẩm chướng cam bền hoa — bó hoa Tết giản dị, giữ được màu tươi suốt những ngày đầu xuân.',{'FL-CUC-VANG':20,'FL-CAMCHUONG-CAM':8},['lá dương xỉ'],['Vàng','Cam'],['tet']),
 (7,'bo','Bó Lan Đỏ Vạn Sự','bolandovansu','Lan hồ điệp đỏ, cúc đỏ và cành mai, sang trọng ngày Tết.','Lan hồ điệp đỏ sang trọng đi cùng cúc đỏ và cành mai — bó hoa biếu Tết trang trọng, chúc vạn sự như ý.',{'FL-LAN-DO':3,'FL-CUC-DO':10,'FL-MAI':3},['lá bạc hà','giấy gói kraft'],['Đỏ'],['tet']),
 (7,'bo','Bó Hướng Dương Tài Lộc','bohuongduongtailoc','Hướng dương, cúc vàng và cẩm chướng cam, ấm áp sắc xuân.','Hướng dương rực rỡ cùng cúc vàng và cẩm chướng cam — bó hoa Tết ấm áp, gửi lời chúc tài lộc đến mọi nhà.',{'FL-HUONGDUONG':8,'FL-CUC-VANG':8,'FL-CAMCHUONG-CAM':6},['lá măng'],['Vàng','Cam'],['tet']),
 (7,'bo','Bó Cúc Đỏ Sum Vầy','bocucdosumvay','Cúc đỏ và hồng đỏ, đỏ thắm cho bữa cơm sum vầy.','Cúc đỏ và hồng đỏ nổi bật trên bàn tiệc đoàn viên — bó hoa Tết đậm không khí sum vầy.',{'FL-CUC-DO':15,'FL-HONG-DO':8},['lá bạc hà'],['Đỏ'],['tet']),
 (7,'bo','Bó Mai Trắng Thanh Xuân','bomaitrangthanhxuan','Cành mai, hồng trắng và cúc trắng, thanh nhã đầu năm.','Cành mai điểm cùng hồng trắng và cúc trắng — bó hoa Tết thanh nhã cho những ai thích một mùa xuân nhẹ nhàng.',{'FL-MAI':8,'FL-HONG-TRANG':8,'FL-CUC-TRANG':8},['lá bạc hà','giấy gói trắng'],['Trắng','Vàng'],['tet']),
 (7,'bo','Bó Hoa Tết Đoàn Viên','bohoatetdoanvien','Hồng đỏ, hồng cam, cúc vàng và mai, đủ sắc cho nhà đông người.','Hồng đỏ, hồng cam, cúc vàng và cành mai gói chung một bó — đủ sắc màu cho ngôi nhà đông đủ con cháu ngày Tết.',{'FL-HONG-DO':10,'FL-HONG-CAM':8,'FL-CUC-VANG':10,'FL-MAI':3},['lá măng','giấy gói kraft'],['Đỏ','Cam','Vàng'],['tet']),
 (7,'bo','Bó Mẫu Đơn Phú Quý','bomaudonphuquy','Mẫu đơn hồng, hồng đỏ Pháp và cúc đỏ, phú quý đầu năm.','Mẫu đơn hồng đầy đặn cùng hồng đỏ Pháp và cúc đỏ — bó hoa Tết biếu tặng, mang ý nghĩa phú quý, sung túc.',{'FL-MAUDON-HONG':6,'FL-HONG-DO-PHAP':10,'FL-CUC-DO':8},['lá bạc hà','dây ruy băng vàng'],['Hồng','Đỏ'],['tet']),
 (7,'bo','Bó Cúc Cam Hoàng Kim','bocuccamhoangkim','Cúc cam, hướng dương mini và cành mai, vàng ấm như nắng xuân.','Cúc cam và hướng dương mini ấm như nắng xuân, thêm vài cành mai — bó hoa Tết tươi vui, hợp đặt phòng khách.',{'FL-CUC-CAM':18,'FL-HUONGDUONG-MINI':8,'FL-MAI':3},['lá măng'],['Cam','Vàng'],['tet']),
 # ---- Valentine (11)
 (1,'bo','Bó Hồng Đỏ Say Đắm','bohongdosaydam','Hồng đỏ Pháp nhung đỏ, đơn giản mà nồng nàn.','Những bông hồng đỏ Pháp nhung đỏ gói gọn trong một bó — cách nói yêu thương đơn giản và nồng nàn nhất.',{'FL-HONG-DO-PHAP':24},['lá bạc hà','giấy gói đen'],['Đỏ'],['val']),
 (1,'bo','Bó Hồng Đỏ Trắng Giao Duyên','bohongdotranggiaoduyen','Hồng đỏ và hồng trắng đan xen, cho một mối duyên đẹp.','Hồng đỏ và hồng trắng đan xen trong cùng một bó — đối lập mà hòa hợp, như hai người dành cho nhau.',{'FL-HONG-DO':12,'FL-HONG-TRANG':12},['lá bạc hà'],['Đỏ','Trắng'],['val']),
 (1,'bo','Bó Tulip Hồng Ngày Yêu','botuliphongngayyeu','Tulip hồng và hồng peach, dịu dàng cho ngày lễ tình nhân.','Tulip hồng tươi mát cùng hồng peach ngọt ngào — bó hoa Valentine dịu dàng, cũng hợp tặng ngày 8/3.',{'FL-TULIP-HONG':12,'FL-HONG-PEACH':6},['lá bạc hà'],['Hồng'],['val','women']),
 (1,'bo','Bó Hồng Peony Đêm Valentine','bohongpeonydemvalentine','Hồng peony, mẫu đơn hồng và hồng đỏ, lãng mạn và đầy đặn.','Hồng peony bung tròn cùng mẫu đơn hồng và hồng đỏ — một bó hoa Valentine đầy đặn, lãng mạn như bữa tối thắp nến.',{'FL-HONG-PEONY':14,'FL-MAUDON-HONG':3,'FL-HONG-DO':6},['lá bạc hà','giấy gói kraft'],['Hồng','Đỏ'],['val']),
 (2,'bo','Bó Hồng Cầu Hôn','bohongcauhon','Hồng đỏ Pháp và hoa sáp trắng, cho khoảnh khắc ngỏ lời.','Hồng đỏ Pháp điểm hoa sáp trắng — bó hoa cho khoảnh khắc quỳ gối ngỏ lời, trang trọng mà chân thành.',{'FL-HONG-DO-PHAP':20,'FL-HOASAP-TRANG':8},['lá bạc hà','dây ruy băng lụa'],['Đỏ','Trắng'],['val']),
 (2,'bo','Bó Hồng Mẫu Đơn Trọn Đời','bohongmaudontrondoi','Hồng đỏ Pháp, mẫu đơn hồng và hoa sáp, lời hẹn trọn đời.','Hồng đỏ Pháp, mẫu đơn hồng và hoa sáp trắng — bó hoa của lời hẹn ước, hợp cho kỷ niệm ngày cưới hay lễ đính hôn.',{'FL-HONG-DO-PHAP':14,'FL-MAUDON-HONG':4,'FL-HOASAP-TRANG':6},['lá bạc hà','giấy gói kem'],['Đỏ','Hồng','Trắng'],['val']),
 (2,'bo','Bó Hồng Vintage Hẹn Ước','bohongvintagehenuoc','Hồng vintage và cẩm chướng hồng, màu cổ điển cho lời hẹn.','Hồng vintage tông trầm cùng cẩm chướng hồng — bó hoa màu cổ điển, nhẹ nhàng cho lời hẹn ước.',{'FL-HONG-VINTAGE':18,'FL-CAMCHUONG-HONG':8},['lá bạc hà'],['Hồng'],['val','women']),
 (6,'hop','Hộp Hồng Đỏ Tình Yêu','hophongdotinhyeu','Hồng đỏ xếp kín trong hộp tròn, tặng là nhớ.','Hồng đỏ xếp khít trong hộp tròn sang trọng — món quà Valentine gọn gàng, mở nắp ra là cả một mùa yêu.',{'FL-HONG-DO':20},['hộp tròn cứng','thiệp viết tay'],['Đỏ'],['val']),
 (6,'set','Set Hồng & Socola Valentine','setquahongsocolavalentine','Hồng đỏ, hồng peach cùng hộp socola và thiệp.','Một bó hồng đỏ và hồng peach đi cùng hộp socola và thiệp viết tay — set quà Valentine đủ đầy, tặng là xong.',{'FL-HONG-DO':12,'FL-HONG-PEACH':4},['hộp socola','thiệp viết tay','hộp quà'],['Đỏ','Hồng'],['val']),
 (6,'set','Set Hồng Đỏ & Gấu Bông','setquahongdogaubong','Hồng đỏ cùng gấu bông nhỏ và thiệp.','Bó hồng đỏ kèm một chú gấu bông nhỏ và tấm thiệp — set quà Valentine dễ thương, nhận là cười.',{'FL-HONG-DO':10},['gấu bông nhỏ','thiệp viết tay','hộp quà'],['Đỏ'],['val']),
 (6,'hop','Hộp Hồng Lavender Ngọt Ngào','hophonglavenderngotngao','Hồng lavender và hoa sáp trong hộp, tông tím ngọt ngào.','Hồng lavender điểm hoa sáp trắng trong hộp quà — tông tím ngọt ngào, khác biệt cho ngày lễ tình nhân.',{'FL-HONG-LAVENDER':14,'FL-HOASAP-TRANG':4},['hộp vuông cứng','thiệp viết tay'],['Tím','Trắng'],['val']),
 # ---- 8/3 và 20/10 (12)
 (1,'bo','Bó Tulip Mừng 8/3','botulipmung83','Tulip hồng và trắng, tươi mát mừng ngày Quốc tế Phụ nữ.','Tulip hồng và trắng tươi mát — bó hoa mừng ngày Quốc tế Phụ nữ, nhẹ nhàng và trang nhã.',{'FL-TULIP-HONG':10,'FL-TULIP-TRANG':6},['lá bạc hà'],['Hồng','Trắng'],['women']),
 (1,'bo','Bó Hồng Peach Ngày Của Nàng','bohongpeachngaycuanang','Hồng peach và cẩm chướng hồng, ngọt ngào tặng nàng.','Hồng peach ngọt ngào cùng cẩm chướng hồng — bó hoa tặng người phụ nữ của bạn ngày 8/3 hoặc 20/10.',{'FL-HONG-PEACH':14,'FL-CAMCHUONG-HONG':8},['lá bạc hà','giấy gói kraft'],['Hồng'],['women']),
 (1,'bo','Bó Mẫu Đơn Tri Ân Phụ Nữ','bomaudontriamphunu','Mẫu đơn hồng, hồng peony và cúc lavender, đầy đặn và ý nghĩa.','Mẫu đơn hồng, hồng peony và cúc lavender đầy đặn — bó hoa tri ân phụ nữ, trân trọng và sang trọng.',{'FL-MAUDON-HONG':6,'FL-HONG-PEONY':8,'FL-CUC-LAVENDER':6},['lá bạc hà'],['Hồng','Tím'],['women']),
 (1,'bo','Bó Hồng Pastel 20/10','bohongpastel2010','Hồng peach, hồng lavender và hồng mini, tông pastel nhẹ.','Hồng peach, hồng lavender và hồng mini phối tông pastel — bó hoa 20/10 mềm mại, hợp mọi lứa tuổi.',{'FL-HONG-PEACH':8,'FL-HONG-LAVENDER':6,'FL-HONG-MINI':8},['lá bạc hà'],['Hồng','Tím'],['women','val']),
 (1,'bo','Bó Cẩm Chướng Yêu Thương Mẹ','bocamchuongyeuthuongme','Cẩm chướng hồng và trắng, loài hoa của người mẹ.','Cẩm chướng hồng và trắng — loài hoa của tình mẫu tử, bền hoa, giá mềm, hợp tặng mẹ và bà.',{'FL-CAMCHUONG-HONG':20,'FL-CAMCHUONG-TRANG':12},['lá măng'],['Hồng','Trắng'],['women']),
 (2,'bo','Bó Hồng Trắng Dịu Dàng','bohongtrangdiudang','Hồng trắng và hoa sáp, thanh lịch và tinh khôi.','Hồng trắng tinh khôi điểm hoa sáp — bó hoa thanh lịch cho người phụ nữ nhẹ nhàng.',{'FL-HONG-TRANG':14,'FL-HOASAP-TRANG':5},['lá bạc hà','giấy gói trắng'],['Trắng'],['women']),
 (6,'set','Set Quà Hoa & Trà Thảo Mộc','setquahoatrathaomoc','Hồng peach, cẩm chướng hồng và hộp trà thảo mộc.','Hồng peach và cẩm chướng hồng đi cùng hộp trà thảo mộc — set quà 8/3 nhẹ nhàng, tặng đồng nghiệp hay người thân.',{'FL-HONG-PEACH':10,'FL-CAMCHUONG-HONG':10},['hộp trà thảo mộc','thiệp viết tay','hộp quà'],['Hồng'],['women']),
 (6,'hop','Hộp Hoa Tulip Pastel','hophoatulippastel','Tulip hồng, tulip lavender và hồng peach trong hộp.','Tulip hồng, tulip lavender và hồng peach xếp trong hộp quà — tông pastel dịu mắt cho ngày của phái đẹp.',{'FL-TULIP-HONG':8,'FL-TULIP-LAVENDER':6,'FL-HONG-PEACH':4},['hộp vuông cứng','thiệp viết tay'],['Hồng','Tím'],['women']),
 (6,'set','Set Quà Cẩm Chướng Tri Ân','setquacamchuongtrian','Cẩm chướng hồng, hộp socola và thiệp tri ân.','Cẩm chướng hồng kèm hộp socola nhỏ và thiệp tri ân — set quà vừa túi tiền, hợp tặng cô, dì, đồng nghiệp.',{'FL-CAMCHUONG-HONG':12},['hộp socola','thiệp viết tay','hộp quà'],['Hồng'],['women']),
 (6,'hop','Hộp Hoa Lan Hồng Tặng Mẹ','hophoalanhongtangme','Lan hồ điệp hồng nhạt và hồng peach trong hộp.','Lan hồ điệp hồng nhạt và hồng peach trong hộp quà — món quà sang trọng cho mẹ, để được lâu.',{'FL-LAN-HONG':3,'FL-HONG-PEACH':6},['hộp vuông cứng','thiệp viết tay'],['Hồng'],['women']),
 (8,'bo','Bó Tulip Lavender Xuân Về','botuliplavenderxuanve','Tulip lavender và hồng lavender, sắc tím của mùa xuân.','Tulip lavender và hồng lavender — sắc tím nhẹ của mùa xuân, bó hoa lạ mắt cho ngày 8/3.',{'FL-TULIP-LAVENDER':10,'FL-HONG-LAVENDER':6},['lá bạc hà'],['Tím'],['women']),
 (8,'bo','Bó Hoa Xuân Dịu Dàng','bohoaxuandiudang','Hồng peach, tulip hồng và cẩm chướng hồng, dịu như nắng xuân.','Hồng peach, tulip hồng và cẩm chướng hồng — bó hoa xuân dịu dàng, tươi như một buổi sáng đầu tháng ba.',{'FL-HONG-PEACH':8,'FL-TULIP-HONG':6,'FL-CAMCHUONG-HONG':6},['lá bạc hà'],['Hồng'],['women']),
 # ---- 20/11 (10)
 (1,'bo','Bó Hướng Dương Tri Ân Thầy Cô','bohuongduongtrianthayco','Hướng dương và cúc vàng, lòng biết ơn rạng rỡ.','Hướng dương hướng về phía ánh sáng — như học trò luôn hướng về thầy cô. Kèm cúc vàng rạng rỡ.',{'FL-HUONGDUONG':8,'FL-CUC-VANG':8},['lá măng','thiệp cảm ơn'],['Vàng'],['teach']),
 (1,'bo','Bó Hoa Ly Kính Tặng Thầy Cô','bohoalykinhtangthayco','Hoa ly trắng, cúc trắng và hoa sáp, trang nhã tôn kính.','Hoa ly trắng thanh cao cùng cúc trắng và hoa sáp — bó hoa trang nhã gửi đến người thầy, người cô đáng kính.',{'FL-LY-TRANG':6,'FL-CUC-TRANG':8,'FL-HOASAP-TRANG':4},['lá dương xỉ','thiệp cảm ơn'],['Trắng'],['teach']),
 (1,'bo','Bó Cúc Vàng Ngày Nhà Giáo','bocucvangngaynhagiao','Cúc vàng và hướng dương mini, tươi tắn ngày 20/11.','Cúc vàng và hướng dương mini tươi tắn — bó hoa đơn giản, dễ mang đến lớp hay đến nhà thầy cô.',{'FL-CUC-VANG':20,'FL-HUONGDUONG-MINI':8},['lá măng'],['Vàng'],['teach']),
 (1,'bo','Bó Hồng Cam Biết Ơn','bohongcambietom','Hồng cam và cúc cam, ấm áp lòng biết ơn.','Hồng cam và cúc cam ấm áp — bó hoa biết ơn gửi thầy cô, tông màu tươi và gần gũi.',{'FL-HONG-CAM':12,'FL-CUC-CAM':8},['lá bạc hà','thiệp cảm ơn'],['Cam'],['teach']),
 (1,'bo','Bó Lan Vàng Kính Tặng Thầy','bolanvangkinhtangthay','Lan hồ điệp vàng, cúc trắng và hoa sáp, trang trọng.','Lan hồ điệp vàng nổi bật giữa cúc trắng và hoa sáp — bó hoa trang trọng dành cho người thầy lớn tuổi.',{'FL-LAN-VANG':2,'FL-CUC-TRANG':10,'FL-HOASAP-TRANG':4},['lá bạc hà','giấy gói kem'],['Vàng','Trắng'],['teach']),
 (6,'set','Set Quà Tri Ân Thầy Cô','setquatrianthayco','Hướng dương, cúc vàng, sổ tay và thiệp tri ân.','Hướng dương và cúc vàng kèm một cuốn sổ tay và thiệp tri ân — set quà 20/11 thiết thực, thầy cô nào cũng dùng được.',{'FL-HUONGDUONG':6,'FL-CUC-VANG':8},['sổ tay','thiệp cảm ơn','hộp quà'],['Vàng'],['teach']),
 (6,'hop','Hộp Hoa Hướng Dương Tặng Cô','hophoahuongduongtangco','Hướng dương và cẩm chướng cam trong hộp tròn.','Hướng dương và cẩm chướng cam xếp trong hộp tròn — món quà 20/11 tươi sáng, gọn nhẹ mang đến lớp.',{'FL-HUONGDUONG':8,'FL-CAMCHUONG-CAM':6},['hộp tròn cứng','thiệp cảm ơn'],['Vàng','Cam'],['teach']),
 (6,'set','Set Quà Hoa & Trà 20/11','setquahoatra2011','Cúc trắng, hồng trắng cùng hộp trà và thiệp.','Cúc trắng và hồng trắng đi cùng hộp trà và thiệp — set quà 20/11 thanh nhã, hợp thầy cô thích sự giản dị.',{'FL-CUC-TRANG':12,'FL-HONG-TRANG':6},['hộp trà','thiệp cảm ơn','hộp quà'],['Trắng'],['teach']),
 (6,'hop','Hộp Lan Hồ Điệp Tặng Thầy Cô','hoplanhodieptangthayco','Lan hồ điệp vàng và cúc vàng trong hộp.','Lan hồ điệp vàng và cúc vàng trong hộp quà — món quà trang trọng, hoa nở lâu để thầy cô ngắm cả tháng.',{'FL-LAN-VANG':3,'FL-CUC-VANG':6},['hộp vuông cứng','thiệp cảm ơn'],['Vàng'],['teach']),
 (6,'set','Set Quà Hoa Tri Ân Nhẹ Nhàng','setquahoatriannhenhang','Cẩm chướng cam, hướng dương mini, socola và thiệp.','Cẩm chướng cam và hướng dương mini kèm hộp socola nhỏ — set quà 20/11 gọn nhẹ, vừa túi tiền cho cả lớp góp quà.',{'FL-CAMCHUONG-CAM':12,'FL-HUONGDUONG-MINI':6},['hộp socola','thiệp cảm ơn','hộp quà'],['Cam','Vàng'],['teach']),
 # ---- Trung thu (5) -> category 10
 (10,'bo','Bó Cúc Cam Trăng Rằm','bocuccamtrangram','Cúc cam và cúc vàng, ấm như ánh trăng rằm.','Cúc cam và cúc vàng ấm như ánh trăng rằm — bó hoa Trung thu để bàn cạnh mâm cỗ đoàn viên.',{'FL-CUC-CAM':15,'FL-CUC-VANG':8},['lá măng'],['Cam','Vàng'],['moon']),
 (10,'bo','Bó Hồng Cam Đêm Rằm','bohongcamdemram','Hồng cam và cẩm chướng cam, ngọt như bánh nướng.','Hồng cam và cẩm chướng cam — sắc ấm của mùa thu, hợp tặng nhau bên hộp bánh trung thu.',{'FL-HONG-CAM':10,'FL-CAMCHUONG-CAM':10},['lá bạc hà','giấy gói kraft'],['Cam'],['moon']),
 (10,'bo','Bó Hướng Dương Đoàn Viên Thu','bohuongduongdoanvienthu','Hướng dương, cúc cam và cúc vàng, rộn ràng ngày hội.','Hướng dương, cúc cam và cúc vàng — bó hoa rộn ràng cho đêm hội trăng rằm của cả nhà.',{'FL-HUONGDUONG':6,'FL-CUC-CAM':8,'FL-CUC-VANG':6},['lá măng'],['Vàng','Cam'],['moon']),
 (10,'bo','Bó Cúc Trắng Ánh Trăng','bocuctranganhtrang','Cúc trắng và hoa sáp, dịu như ánh trăng.','Cúc trắng và hoa sáp dịu như ánh trăng — bó hoa Trung thu thanh nhã, hợp tặng người lớn tuổi.',{'FL-CUC-TRANG':18,'FL-HOASAP-TRANG':6},['lá bạc hà','giấy gói trắng'],['Trắng'],['moon']),
 (10,'bo','Bó Hoa Thu Ấm Áp Gia Đình','bohoathuamapgiadinh','Hồng cam, cúc cam, hướng dương mini và cẩm chướng cam.','Hồng cam, cúc cam, hướng dương mini và cẩm chướng cam — đủ sắc ấm của mùa thu cho bàn tiệc cả gia đình.',{'FL-HONG-CAM':6,'FL-CUC-CAM':8,'FL-HUONGDUONG-MINI':8,'FL-CAMCHUONG-CAM':6},['lá măng','giấy gói kraft'],['Cam','Vàng'],['moon']),
 # ---- Giáng sinh (6) -> category 11
 (11,'bo','Bó Hồng Đỏ Giáng Sinh','bohongdogiangsinh','Hồng đỏ và hồng trắng, đỏ trắng đúng màu Noel.','Hồng đỏ và hồng trắng — đúng hai màu của mùa Noel, đặt cạnh cây thông là đủ không khí lễ.',{'FL-HONG-DO':14,'FL-HONG-TRANG':6},['lá bạc hà','dây ruy băng đỏ'],['Đỏ','Trắng'],['xmas']),
 (11,'bo','Bó Hồng Trắng Noel Tuyết','bohongtrangnoeltuyet','Hồng trắng và hoa sáp, trắng như tuyết đầu mùa.','Hồng trắng và hoa sáp trắng muốt như tuyết đầu mùa — bó hoa Noel tinh khôi, nhẹ nhàng.',{'FL-HONG-TRANG':14,'FL-HOASAP-TRANG':8},['lá bạc hà','giấy gói trắng'],['Trắng'],['xmas']),
 (11,'bo','Bó Hoa Noel Đỏ Trắng','bohoanoeldotrang','Hồng đỏ, cẩm chướng trắng và hồng trắng.','Hồng đỏ, cẩm chướng trắng và hồng trắng gói chung — bó hoa Noel tươi, nổi bật trên bàn tiệc.',{'FL-HONG-DO':10,'FL-CAMCHUONG-TRANG':10,'FL-HONG-TRANG':6},['lá bạc hà','dây ruy băng đỏ'],['Đỏ','Trắng'],['xmas']),
 (11,'bo','Bó Mẫu Đơn Đông Ấm','bomaudondongam','Mẫu đơn hồng, hồng đỏ Pháp và cúc trắng, ấm cho mùa lạnh.','Mẫu đơn hồng, hồng đỏ Pháp và cúc trắng — bó hoa ấm áp, sang trọng cho mùa đông và những buổi tiệc cuối năm.',{'FL-MAUDON-HONG':4,'FL-HONG-DO-PHAP':10,'FL-CUC-TRANG':6},['lá bạc hà','giấy gói kem'],['Hồng','Đỏ','Trắng'],['xmas']),
 (11,'bo','Bó Cúc Trắng Mùa Đông','bocuctrangmuadong','Cúc trắng và hoa ly trắng, thanh khiết mùa đông.','Cúc trắng và hoa ly trắng thanh khiết — bó hoa mùa đông trang nhã, bền hoa trong tiết trời lạnh.',{'FL-CUC-TRANG':20,'FL-LY-TRANG':3},['lá dương xỉ','giấy gói trắng'],['Trắng'],['xmas']),
 (11,'bo','Bó Hoa Noel Thanh Lịch','bohoanoelthanhlich','Hồng peony, hồng đỏ và hoa sáp trắng, sang trọng.','Hồng peony, hồng đỏ và hoa sáp trắng — bó hoa Noel thanh lịch để biếu hay tặng người thương.',{'FL-HONG-PEONY':8,'FL-HONG-DO':8,'FL-HOASAP-TRANG':6},['lá bạc hà','giấy gói kem'],['Hồng','Đỏ','Trắng'],['xmas']),
]

FIRST_SKU_NUMBER = 52  # BLM-0052 ...; the first seed ends at BLM-0051

def q(s):
    return "NULL" if s is None else "'" + s.replace("'", "''") + "'"

def vnd(n):
    return f"{n:,}".replace(',', '.') + 'đ'

def join_vi(items):
    return items[0] if len(items) == 1 else ', '.join(items[:-1]) + ' và ' + items[-1]

def cost_of(recipe):
    return sum(FLOWER_PRICE[f] * n for f, n in recipe.items())

def price_of(style, recipe):
    cost = cost_of(recipe)
    if style == 'set':   # flowers are about half of a set: the rest is the chocolate, tea, card and box
        return max(450000, r10k(cost * 2 + 20000))   # and never under 450.000đ: the first seed's cheapest set is 580.000đ
    return r10k(cost / 0.78 + STYLE_FEE[style])

def sizes_for(cat, style, recipe, price):
    if not (style == 'bo' and cat in SIZED_CATEGORIES):
        return [('m', price, recipe)]
    return [('s', r10k(price * 0.7), {k: rstem(v * 0.6) for k, v in recipe.items()}),
            ('m', price, recipe),
            ('l', r10k(price * 1.4), {k: rstem(v * 1.5) for k, v in recipe.items()})]

def build():
    """Rows with everything derived: sku, price, sizes, tags. Shared with the image-prompt script."""
    rows = []
    for i, (cat, style, name, stem, short, desc, recipe, extras, colors, occ) in enumerate(N):
        sku = f"BLM-{FIRST_SKU_NUMBER + i:04d}"
        price = price_of(style, recipe)
        rows.append(dict(sku=sku, cat=cat, style=style, name=name, image=f"images/{stem}.webp", short=short,
                         desc=desc + ' Kèm ' + join_vi(extras) + '.', recipe=recipe, extras=extras, colors=colors, occ=occ,
                         price=price, sizes=sizes_for(cat, style, recipe, price)))
    return rows

def main():
    rows = build()
    assert len(rows) == 54, len(rows)
    assert len({r['name'] for r in rows}) == len(rows), "duplicate product name"
    assert len({r['image'] for r in rows}) == len(rows), "duplicate image file"
    for r in rows:
        assert all(f in FLOWER_PRICE for f in r['recipe']), r['name']
        assert set(r['occ']) <= set(OCC), r['name']

    out = []
    w = out.append
    w("-- Bloomy — second product seed: 54 products for Peekbox's six occasions, the six occasion tags, and the")
    w("-- occasion links of the first 50 products.")
    w("-- GENERATED by gen_products2.py, do not hand-edit row by row. Pricing as in the first seed (Nhỏ/Lớn are 70%/140% of")
    w("-- Vừa, stems 60%/150%); a bouquet costs its stems / 0.78 plus the style fee, a set about twice its stems.")
    w("--")
    w("-- ADDITIVE and IDEMPOTENT: no fixed ids; everything is looked up by SKU or by (kind, name); every INSERT ends in")
    w("-- ON CONFLICT DO NOTHING. So it loads after the first seed on a fresh database (seed.sh) AND runs on a live shop")
    w("-- (seed-more.sh): a second run changes nothing, and a product that already exists is never overwritten.")
    w("-- Must run AFTER seed-categories.sql, seed-flowers.sql and seed-products.sql (it needs the first 50 products).")
    w("-- category_id: 1 sinh nhật, 2 cưới, 3 khai trương, 6 set quà tặng, 7 Tết, 8 mùa xuân, 10 mùa thu, 11 mùa đông.")
    w("-- Flower quantities are DRAFTS for the team to review, like the first seed's.")
    w("")
    w("-- The occasions, in calendar order: their ids are the order the filter shows them in.")
    w("INSERT INTO tags (kind, name) VALUES")
    w(",\n".join(f"('occasion', {q(n)})" for n in OCC.values()))
    w("ON CONFLICT (kind, name) DO NOTHING;")
    w("")
    w("INSERT INTO products (category_id, sku, name, short_description, description, image, status, featured, product_type, style, external_url) VALUES")
    w(",\n".join("(" + ", ".join([str(r['cat']), q(r['sku']), q(r['name']), q(r['short']), q(r['desc']), q(r['image']),
                                  q('available'), 'false', q('standard'), q(r['style']), 'NULL']) + ")" for r in rows))
    w("ON CONFLICT (sku) DO NOTHING;")
    w("")
    sizes_sql, recipe_sql, tag_sql = [], [], []
    for r in rows:
        for size, sprice, srecipe in r['sizes']:
            ssku = f"{r['sku']}-{size.upper()}"
            sizes_sql.append(f"({q(r['sku'])}, {q(size)}, {q(ssku)}, {sprice})")
            for fsku, n in srecipe.items():
                recipe_sql.append(f"({q(ssku)}, {q(fsku)}, {n})")
        for t in sorted({family(f) for f in r['recipe']}):
            tag_sql.append(f"({q(r['sku'])}, 'flower', {q(t)})")
        for c in r['colors']:
            tag_sql.append(f"({q(r['sku'])}, 'color', {q(c)})")
        for o in r['occ']:
            tag_sql.append(f"({q(r['sku'])}, 'occasion', {q(OCC[o])})")
    for o, ids in OLD.items():
        for pid in ids:
            tag_sql.append(f"({q(f'BLM-{pid:04d}')}, 'occasion', {q(OCC[o])})")
    w("INSERT INTO product_sizes (product_id, size, sku, price)")
    w("SELECT p.id, v.size::product_size, v.sku, v.price")
    w("FROM (VALUES")
    w(",\n".join(sizes_sql))
    w(") AS v(product_sku, size, sku, price)")
    w("JOIN products p ON p.sku = v.product_sku")
    w("ON CONFLICT (sku) DO NOTHING;")
    w("")
    w("INSERT INTO recipes (size_id, flower_id, quantity)")
    w("SELECT ps.id, f.id, v.quantity")
    w("FROM (VALUES")
    w(",\n".join(recipe_sql))
    w(") AS v(size_sku, flower_sku, quantity)")
    w("JOIN product_sizes ps ON ps.sku = v.size_sku")
    w("JOIN flowers f ON f.sku = v.flower_sku")
    w("ON CONFLICT (size_id, flower_id) DO NOTHING;")
    w("")
    w("INSERT INTO product_tags (product_id, tag_id)")
    w("SELECT p.id, t.id")
    w("FROM (VALUES")
    w(",\n".join(tag_sql))
    w(") AS v(product_sku, kind, name)")
    w("JOIN products p ON p.sku = v.product_sku")
    w("JOIN tags t ON t.kind = v.kind::tag_kind AND t.name = v.name")
    w("ON CONFLICT (product_id, tag_id) DO NOTHING;")
    w("")
    open('seed-products-2.sql', 'w', encoding='utf-8').write("\n".join(out))

    print(f"{len(rows)} products, {len(sizes_sql)} size rows, {len(recipe_sql)} recipe rows, {len(tag_sql)} tag links")
    by_occ = {}
    for r in rows:
        for o in r['occ']:
            by_occ[o] = by_occ.get(o, 0) + 1
    print("new per occasion:", {OCC[k]: by_occ.get(k, 0) for k in OCC})
    print("old products linked:", {OCC[k]: len(v) for k, v in OLD.items()})
    by_cat = {}
    for r in rows:
        by_cat[r['cat']] = by_cat.get(r['cat'], 0) + 1
    print("new per category:", dict(sorted(by_cat.items())))
    for r in rows:
        cost = cost_of(r['recipe'])
        print(f"{r['sku']} {r['style']:3} {r['price']:>9,} cost {cost:>9,} stems {sum(r['recipe'].values()):>3}  {r['name']}")

if __name__ == '__main__':
    main()
