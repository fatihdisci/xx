# X Verim

X'te tek bir kişinin işini hızlandıran kişisel bir tarayıcı eklentisi. Chrome ve
Safari'de çalışır, Web Store'a çıkmaz, sadece senin makinende durur.

Ne yapar, kısaca:

- **Klavyeyle gezinme** — `j` / `k` ile tweetler arasında, fareye dokunmadan
- **Tek tuşla işlem** — `l` beğen, `s` yer işareti, `f` takip et
- **AI yardımı** — gönderi fikirleri, yanıt taslakları (DeepSeek üzerinden)
- **Niş filtresi** — akışta ilgilenmediğin tweetleri soluklaştırır, ilgilendiklerini işaretler
- **Gönderi planlama** — yazdığın mesajları X'in kendi planlayıcısına kaydeder, bilgisayar kapalıyken bile paylaşılır
- **Hız korkuluğu** — saatlik beğeni/takip hızın fazla artarsa uyarır

---

## Değişmeyecek dört kural

**1. Tek otomasyon, senin kurduğun otomasyon.** Beğenme, takip, yanıt ve anlık
gönderi her zaman senin tuşuna basmanı ister; eklenti kendi kafasına göre
"Gönder" düğmesine basmaz. Tek istisna var ve bilerek konuldu: popup'taki
*Gönderi planlama* kartına yazdığın gönderiler, senin seçtiğin saatte, senin
yazdığın metinle paylaşılır. Bunun dışında hiçbir şey o düğmeye dokunamaz ve
planlama varsayılan olarak **kapalıdır**.

**2. Seçici disiplini.** X'in sayfasındaki her öğe `data-testid`, `role` veya
`aria-label` ile bulunur. CSS sınıf adları (`css-1dbjc4n` gibi) kullanılmaz,
çünkü onlar her hafta değişir.

**3. Telemetri yok.** Makinenden dışarı sadece şunlar çıkar: `api.deepseek.com`'a
gönderdiğin tweet metni ve kişilik tanımın, bir de planlamayı açtıysan `x.com`'un
kendi API'sine senin yazdığın gönderiler. Başka hiçbir yere hiçbir şey gitmez.

**4. Kişisel kullanım.** Bu tek kişilik bir eklenti. Yayınlama.

---

## Kurulum

### Chrome

1. `config.example.js` dosyasını `config.js` olarak kopyala ve doldur:
   - `DEEPSEEK_API_KEY` — DeepSeek API anahtarın
   - `PERSONA.identity` / `niche` / `tone` — kim olduğun, ne hakkında yazdığın, nasıl konuştuğun
   - `PERSONA.samples` — **kalitede en büyük fark burada.** Gerçekten yazdığın
     birkaç tweet. Model bunların ritmini kopyalar, içeriğini asla.
   - İsteğe bağlı: `FILTER` ayarları, `AI_TIMEOUT_MS` (varsayılan 45 sn)
2. `chrome://extensions` aç, sağ üstten **Developer mode**'u aç.
3. **Load unpacked** de ve `x-verim/` klasörünü seç.
4. `https://x.com` aç. Panel kısayolu `v`.

`config.js` gitignore'da, yani anahtarın hiçbir zaman repoya girmez. Bu dosya
olmadan eklenti hiç yüklenmez, örnek dosyanın commit'lenmiş olmasının sebebi bu.

### Safari (macOS)

Safari'de "load unpacked" yok, eklentinin bir macOS uygulamasının içinde yaşaması
gerekiyor. `../x-verim-safari/` klasöründeki Xcode projesi bu klasörü sarmalıyor.
Dosyaları **kopyalamıyor, referans veriyor** — yani buradaki `content.js`'i
düzenleyip yeniden derlemen yeterli, senkronda tutulacak ikinci bir kopya yok.

```sh
../x-verim-safari/rebuild.sh
```

Sonra Safari'de:

1. **Ayarlar → Gelişmiş →** *Web geliştiricileri için özellikleri göster*'i işaretle.
2. **Develop → Allow Unsigned Extensions.** Uygulama Developer ID ile değil
   geliştirme sertifikasıyla imzalandığı için gerekli. **Safari her kapanışta bunu
   sıfırlıyor**, yeniden açtığında tekrar işaretle.
3. **Ayarlar → Eklentiler →** X Verim'i etkinleştir.
4. Araç çubuğundaki simgeye tıkla → **x.com'da Her Zaman İzin Ver**. Safari site
   erişimini çalışma anında soruyor; bunu vermezsen içerik betiği hiç enjekte
   olmaz ve kısayollar çalışmaz.

**Düzenleme sonrası:** Chrome'da yenile düğmesi var, Safari'de yok. Derlenmiş
`.appex` dosyanın içinde derleme anındaki kopyalar var, bu yüzden `x-verim/`
altındaki değişiklikler ancak yeniden derleyince geçerli olur. `rebuild.sh`'ı
çalıştır, Safari'yi kapatıp aç, *Allow Unsigned Extensions*'ı tekrar işaretle,
x.com sekmesini yenile.

Arka plan kodunu ayıklamak için **Develop → Web Extension Background Content**;
içerik betikleri x.com sekmesinin normal Web Inspector'ında görünür.

**Tek kod tabanı iki tarayıcıya nasıl hizmet ediyor:** `manifest.json` arka planı
iki kez tanımlıyor. Chrome `service_worker`'ı kullanıp `scripts`'i yok sayıyor,
Safari tam tersini yapıp bir event page çalıştırıyor. `importScripts` sadece
service worker'da var olduğu için `background.js` onu kontrol ediyor — Safari'de
`config.js` zaten `scripts` dizisiyle yüklenmiş oluyor.

---

## Klavye kısayolları

Hepsi `config.js` içindeki `SHORTCUTS` bölümünden değiştirilebilir. Bir tuşu `""`
yaparsan o işlem tamamen kapanır.

| Tuş | Ne yapar |
| --- | --- |
| `j` | Sonraki tweete geç |
| `k` | Önceki tweete geç |
| `l` | Beğen / beğeniyi geri al |
| `s` | Yer işaretine ekle |
| `f` | Yazarı takip et |
| `r` | Yanıt kutusunu aç ve AI taslağını içine koy |
| `a` | Taslak kartını aç: hazır yanıt taslakları, her birinin Türkçe çevirisiyle |
| `v` | Yüzen paneli aç/kapat |
| `1`…`5` | Kart açıkken: o taslağı yanıt kutusuna koy |
| `Esc` | Önce kartı, sonra paneli kapat |

Bir `input`, `textarea` veya yazılabilir alanda yazarken kısayollar devre dışı —
karttaki düzenlenebilir taslak kutuları da buna dahil.

---

## Aktif tweet nasıl seçiliyor

Her tek tuşluk işlem tam olarak bir tweete uygulanıyor, dolayısıyla hangisi
olduğunun net olması ve seni asla şaşırtmaması gerekiyor.

**Kaydırırken**, ekranın %35 yüksekliğindeki hayali bir "okuma çizgisini" kesen
tweet seçiliyor. Çizginin etrafında bir tolerans bandı var, böylece iki komşu
tweet sınırda gidip gelemiyor.

**`j` / `k` veya tıklama** bilinçli bir seçim sayılıyor: o tweetin gerçek bir
parçası ekranda kaldığı sürece seçim orada duruyor, sen kaydırdığın anda (tekerlek,
trackpad, `Space` / `PageDown` / ok tuşları) kontrol okuma çizgisine geri geçiyor.
`j` / `k` tweeti tam da ölçüldüğü çizginin üstüne oturtuyor, böylece bir sıçrama
kaydırma yerine oturduğunda vurguyu kaybedemiyor.

**İşaretleme bilerek sessiz:** satır %6'lık bir maviye boyanıyor, sol kenarına
3px'lik bir çubuk çiziliyor ve küçük bir etiket hangi tuşun taslak ürettiğini
söylüyor. **Çerçeve yok** — X zaman tünelindeki satırları kart gibi çizmiyor,
birini çerçevelemek eklentinin sayfayı ele geçirmiş gibi görünmesine yol açıyordu.

Çubuk ve etiket X'in kendi HTML'inin içine değil, **yüzen bir katmana** çiziliyor.
Böylece niş filtresi tarafından soluklaştırılamıyor, satır tarafından kırpılamıyor
ve X'in hover renkleriyle kavga edemiyor. Çubuk satırın gerçekten görebildiğin
kısmına ortalanıyor, yani ekrandan uzun bir tweet bile işaretini gösteriyor. X'in
üstteki yapışkan başlığının yüksekliği tahmin edilmiyor, ölçülüyor — anasayfadaki
sekme çubuğu onu diğer sayfalardan daha uzun yapıyor.

Yanıt veya gönderi penceresi açıkken işaretin tamamı gizleniyor, X'in o pencerenin
içine kopyaladığı tweet hiçbir zaman seçilemiyor.

Anahtar kelime vurgusu **yeşil ve 2px**, aktif tweet çubuğu **mavi ve 3px**. Eskiden
ikisi de aynı yerde 3px maviydi; hem vurgulu hem aktif olan bir satırda tam üst
üste biniyorlardı ve ikisi de okunmuyordu.

**Soluklaştırılmış** bir tweet hâlâ tıklanabilir ve üzerine gelince %90'a dönüyor.
Eskiden `pointer-events: none` taşıyordu, yani soluk bir tweet açılamıyor,
linklerine tıklanamıyor, seçilemiyordu — bir şeyi soluklaştırmak onu ortadan
kaldırmakla aynı şey değil. `hide` modu sert muamele olarak duruyor.

Konsoldan `window.__xverim.applyFocus()` ile bu geçişi elle adımlayabilir,
`window.__xverim.articles()` ile hangi satırları değerlendirdiğini görebilirsin.

---

## Yanıt taslakları

### `a` — taslak kartı

Bir tweete odaklanıp `a`'ya bastığında sağ tarafta küçük bir kart açılıyor ve
içinde hazır yanıt taslakları oluyor.

- Üstte kaynak tweetin kullanıcı adı ve ilk satırı duruyor. Bir oturumda birkaç
  kart açınca hangisine cevap yazdığın belirsizleşiyordu.
- Her taslak **yerinde düzenlenebilir**, canlı karakter sayacı var (240'ı geçince
  sarı, 280'i geçince kırmızı). `Yanıtla`, `Kopyala` ve rakam tuşları hepsi o anda
  kutuda ne yazıyorsa onu kullanıyor.
- Taslağın içindeyken `Cmd`/`Ctrl` + `Enter` onu yanıt kutusuna gönderiyor. `Esc`
  önce kutudan çıkıyor, böylece yanlışlıkla basılan bir Esc düzenlemeni çöpe atmıyor.
- ↻ yeniden üretiyor. Ekrandaki taslakları modele "bunları tekrarlama" diye geri
  gönderiyor, yani yeniden üretim *farklı açılar* demek, aynı cümlenin yeniden
  yazımı değil.
- **Tweet detay sayfasındayken**, tweetin altında görünen yanıtlar (en fazla 10
  tane, X'in "Daha fazlasını keşfet" bloğundan önce durarak) modele bağlam olarak
  gidiyor. Taslaklar thread'de zaten söylenmiş şeyleri tekrarlamıyor ve ortamın
  tonuna uyuyor. Bu olduğunda kartın etiketi `· N yanıt okundu` diyor. Anasayfada
  bu olmuyor, çünkü orada okunacak yanıt yok.
- Hata veya boş sonuç durumunda ölü bir kart yerine `Tekrar dene` düğmesi çıkıyor.

### `r` — doğrudan yanıt kutusuna

Yanıt penceresini açıyor ve tek bir taslağı içine koyuyor. Göndermeye yine sen
karar veriyorsun.

### Taslakların sesi nereden geliyor

`background.js` içindeki `buildSystemPrompt()` bir taslağın sesinin belirlendiği
tek yer ve iki modu var: `compose` (senin nişlerin konunun kendisi) ve `respond`
(kaynak tweet konu, nişler sadece üsluba renk katıyor).

Ses kuralları sıfat yerine somut yasaklar olarak yazılmış, çünkü "doğal ol" hiçbir
şeyi değiştirmezken "uzun tire kullanma" değiştiriyor. Ortak liste bir metni ilk
bakışta makine yapımı gösteren kalıpları eliyor — "X değil, Y", üç maddelik
listeler, retorik soruyla açılış — ve bir partideki üç taslağın üç aynı cümle
olarak gelmemesi için uzunluk çeşitliliği istiyor.

`respond` modunda ayrıca özetlemek yerine tepki vermesi söyleniyor: tweeti geri
tekrarlama, iltifatla açma, tweetin tonuna ve uzunluğuna uy, dört kelimelik bir
yanıt gerçek bir yanıttır. `config.js`'teki `PERSONA.samples` üslup çıpası olarak
yapıştırılıyor — çıktının sana ne kadar benzeyeceği üzerindeki en güçlü kol bu.

Her isteme bugünün gerçek tarihi de yazılıyor. Bir modelin "şimdi" algısı eğitim
kesim tarihi olduğu için taslaklar sessizce daha eski bir yılı varsayıp kendilerini
2024'e tarihliyordu. Tarih satırı her istekte yerel tarih parçalarından kuruluyor
(`toISOString()` UTC olduğu için akşam saatlerinde bize dünü söylerdi), böylece
gece boyu açık kalan bir sekme dünün tarihini taşımıyor.

---

## Niş filtresi

`config.js` içindeki `FILTER` bölümüne göre akıştaki tweetleri işaretliyor:

- `keywordsInclude` — bu kelimeleri içeren tweetler yeşil çubukla **vurgulanıyor**
- `keywordsExclude` — bu kelimeleri içerenler **soluklaştırılıyor** (`hideMode: "dim"`)
  veya tamamen **gizleniyor** (`hideMode: "hide"`)
- `mutedAuthors` — bu kullanıcı adları gizleniyor
- `highlightMinLikes` — beğenisi bu sayının üstündekiler vurgulanıyor

Filtre panelden ve popup'tan canlı açılıp kapatılıyor, iki taraf birbiriyle
senkron. Türkçe'ye özel bir ayrıntı: küçük harfe çevirirken `tr-TR` kullanılıyor,
çünkü düz `toLowerCase()` "İ" harfini bozuyor ve "İçtihat" ile "içtihat"
eşleşmiyordu.

---

## Yüzen panel (`v`)

- Filtre açma/kapama (canlı, popup ile senkron)
- Son 60 dakikanın beğeni ve takip hız göstergeleri, `GUARDRAILS` sınırlarına
  karşı (%75'te sarı, sınırda kırmızı)
- Katlanabilir kısayol listesi — canlı `SHORTCUTS`'tan üretiliyor, yani özel bir
  tuş asla listedekiyle çelişemiyor

Başlığından tutup sürükleyebilirsin. Konum `chrome.storage.local`'da saklanıyor
ve pencere sonradan küçültülürse görünür alana geri çekiliyor.

---

## Popup (araç çubuğu simgesi)

**Niş filtresi** — içerik betiğiyle çift yönlü senkron.

**Gönderi fikirleri** — konu (isteğe bağlı), kaç tane, ve bir *açı* (karışık /
görüş / ders / soru / an / gözlem). Her sonuç **düzenlenebilir** bir kart, 280
karakter sayacıyla, yanında `Kopyala` ve `Kutuya koy`. Konu, adet ve açı popup
kapanınca kayboluyor değil, saklanıyor. Konu kutusunda `Enter` ya da herhangi bir
yerde `Cmd`/`Ctrl` + `Enter` üretiyor, yeniden üretim listedekilerden farklı
fikirler istiyor.

`Kutuya koy` açık x.com sekmesindeki **Gönderi yayınla** düğmesine tıklıyor,
kutunun yüklenmesini bekliyor ve metni içine koyuyor. Gönder düğmesine yine sen
basıyorsun.

**Hız göstergeleri** — son 60 dakika, sınırlar arka plandan geliyor (popup
`config.js`'i hiç yüklemiyor).

Yanıt taslakları popup'ta yok; tweetin zaten durduğu yerde, zaman tünelinde
yaşıyorlar.

---

## Gönderi planlama

Varsayılan olarak kapalı, açıkça açman gerekiyor.

### Bir kural nelerden oluşuyor

| Alan | Ne işe yarıyor |
| --- | --- |
| Ad | Sadece senin için etiket ("Sabah", "Cuma") |
| Gün | Her gün / hafta içi / hafta sonu / tek bir gün |
| Saat aralığı | Gönderinin düşeceği pencere, örneğin 07:20–09:50 |
| Sıra | Tekrarsız / Rastgele / Sırayla |
| Atlama | Günlerin yüzde kaçının sessizce atlanacağı |
| Mesajlar | **Her satıra bir mesaj** |

### Bilgisayar kapalıyken nasıl paylaşılıyor

Paylaşımı eklenti yapmıyor, **X yapıyor.** Her slot, x.com'un kendi gönderi
kutusundaki *Gönderiyi planla* düğmesinin arkasındaki `CreateScheduledTweet`
çağrısıyla X'in kendi planlanan gönderiler kuyruğuna kaydediliyor. Yetkiyi senin
oturum çerezin veriyor; eklenti hiçbir kimlik bilgini okumuyor ya da saklamıyor.

Bir slot kaydolduktan sonra X'te **Planlanan gönderiler** sayfasında görünüyor
(`g` sonra `t`) ve bu makine kapalı olsa bile paylaşılıyor.

**Tek şart:** slotların kaydolması için ara sıra bir x.com sekmesinin açık olması
gerekiyor. Slotlar **7 gün ileriye kadar** ayrılıyor, yani bugün birkaç dakika
açık kalan bir sekme haftanın tamamını kuruyor. Sekme sadece *kaydeden* şey,
hiçbir zaman *paylaşan* şey değil.

### Sahte görünmemek için üç mekanizma

Bir planlamayı ele veren şey saat değil. Üç şey ele veriyor ve üçü de varsayılan
olarak açık:

**Liste bitmeden tekrar yok.** `Tekrarsız` (varsayılan) bir torbadan çekiliyor:
bütün mesajlar kullanılmadan hiçbiri tekrar etmiyor, torba yenilendiğinde de en
son kullanılan satır başa gelemiyor. Saf rastgelede bir selamlama bir haftada iki
kez çıkarken başka biri hiç çıkmıyor, bu bariz bir dönüşümden daha kötü duruyor.

**Atlanan günler.** `%15 / %25 / %40 atla` uygun günlerin o kadarını sessizce
atlıyor. Aralıksız 60 günlük bir seri en yüksek sesli ipucu; gönderiler hiç
aksamıyorsa geri kalan hiçbir detayın önemi kalmıyor.

**Yuvarlak dakika yok.** Düz bir rastgele seçim `:00` ve `:30`'a bir ay içinde
gözle görülür sıklıkta düşüyor ve insanların fark edeceği tek şey o oluyor. Çeyrek
saate denk gelen bir atış birkaç dakika kaydırılıyor, saniyeler de rastgele.
Her gönderinin tam `:00` saniyede düşmesinin masum bir açıklaması yok.

60 günlük simülasyonla ölçüldü: 10 satırın kullanımı 4-5 arasında eşit dağıldı,
arka arkaya tekrar sıfır, çeyrek saate denk gelme 0/48.

### İçerik kuralı: olmuş bir şey iddia etme

Bu kural "her zaman geçerli olsun"dan daha sert. **Planlanmış bir satır hiçbir
şeyin olduğunu iddia etmemeli.** Bu satırlar bugün yazılıp bilinmeyen bir güne
paylaşılıyor, dolayısıyla "bugün şunu yayınladım" veya "bu hafta dört işe
başladım" düştüğü gün sadece bayat değil, **yanlış** oluyor. Gerçekle hiç
örtüşmeyen bir ilerleme raporu akışı hem yalan hem de fark edilmesi en kolay
otomasyon türü.

Selamlar, temenniler ve haller güvenli, çünkü hangi gün düşerse düşsün doğrular.
Şekilleri de çeşitlendir (iki kelimeden kısa bir cümleye kadar), yoksa on tanesi
tek bir şablon gibi okunuyor.

### İçe / dışa aktar

380 piksellik bir popup'ta elli satır yazmak kimsenin yapması gereken bir şey
değil, o yüzden kurallar JSON olarak girip çıkabiliyor. **Yükle** mevcut listenin
tamamını değiştiriyor ve önce soruyor. **Mevcutları yaz** o anki kuralları
kutuya döküyor, yedek almak için.

Kendi kurallarını eklentinin yanında bir `planlama-*.json` dosyasında tut. Bu
desen gitignore'da: planlanmamış görünmesi gereken metinlerin herkese açık bir
repoda işi yok, orada dursaydı bütün çabanın anlamı kalmazdı.

### Örnek kural seti

`planlama-kurallarim.json` dosyasında hazır beş kural var. Saatler Türkiye
saatine göre ve hedef kitleye göre seçildi (aşağıdakiler kış saati; Avrupa ve ABD
yazın bir saat kayıyor):

| Kural | Gün | TRT | Hedefte karşılığı |
| --- | --- | --- | --- |
| Sabah | Her gün | 07:20–09:50 | Türkiye sabahı |
| EN · Avrupa sabahı | Hafta içi | 10:00–11:40 | Londra 07:00, Berlin 08:00 |
| Cuma | Cuma | 12:30–17:00 | Türkiye, cuma namazı sonrası |
| EN · ABD günü | Hafta sonu | 17:10–19:40 | New York 09:10, Los Angeles 06:10 |
| Akşam | Her gün | 20:15–22:30 | Türkiye akşamı |

İki İngilizce kural ayrı bölgelere nişan alıyor, çünkü tek bir saat aralığı hem
ABD'de hem Avrupa'da sabah olamıyor. Avrupa kuralı "good morning" diyor ve
Avrupa sabahına düşüyor. ABD kuralı ise ABD'de sabah, Avrupa'da öğleden sonra
olduğu için **saatten bağımsız** metinler kullanıyor ("happy weekend"), yoksa
New York'ta öğlen "good night" demek zorunda kalırdı.

Pencereler çakışmıyor, yani aynı anda iki gönderi düşmüyor.

### İşin iç mekaniği

- Slot ayırma **kural başına günde bir kez** deneniyor. Cevabı kaybolan bir slot
  yeniden denenmiyor: çift planlanmış bir gönderi, kaçırılmış bir gönderiden kötü.
- X, GraphQL işlem kimliğini her dağıtımında değiştiriyor. 400/404 gelince eklenti
  sayfanın zaten yüklediği paketleri bir kez tarayıp güncel kimliği buluyor ve
  `xverim_sched_qid_v1` altında saklıyor. Yani X'in bir güncellemesi tek bir başarısız
  denemeye mal oluyor, kırık bir özelliğe değil.
- Kuralları popup sahipleniyor (`xverim_schedule_v1`), kayıt durumunu içerik
  betiği (`xverim_schedule_state_v1`, anahtar `kuralId@YYYY-AA-GG`). Ayrı
  anahtarlar, böylece popup'ta yapılan bir kayıt uçuştaki bir kaydı ezemiyor.
  Birden fazla sekme bir slotu ağ isteğinden **önce** sahipleniyor.
- Bugünün penceresi kapandıysa o gün atlanıp sonraki uygun güne geçiliyor. 5
  dakikadan yakın olan da atlanıyor, çünkü X neredeyse şu an olan bir `execute_at`
  değerini reddediyor.
- Aynı anda en fazla 40 bekleyen kayıt, geçiş başına en fazla 4 tane, aralarında
  ~1 saniye. Otuz tane isteği tek seferde patlatmak hem X'e kaba hem de makine işi.
- Her kural popup'ta gerçek durumunu gösteriyor: `10 mesaj · X'e kayıtlı ·
  sıradaki yarın 08:12 (+4)`, ya da X'in döndürdüğü hata.

---

## Hız korkuluğu

X'in beğeni ve takip üzerinde agresif otomatik sınırları var ve bot gibi görünen
hesaplara gölge ban geliyor. 60 dakikalık kayan bir sayaç hızını izliyor ve
`config.js`'teki yumuşak sınırları (`warnLikesPerHour`, `warnFollowsPerHour`)
aştığında engellemeyen bir uyarı çubuğu gösteriyor. Hiçbir şeyi engellemiyor,
sadece yavaşlamanı hatırlatıyor.

---

## Geri bildirim

Eskiden konsola düşen her şey artık sağ altta küçük bir bildirim olarak çıkıyor:
gönderi kutusuna giden bir taslak, bir API hatası, seçili tweet yokken basılan bir
tuş. Bir taslak gönderi kutusuna ulaşamazsa panoya kopyalanıyor ve bildirim bunu
söylüyor — üretilmiş bir taslak asla sessizce kaybolmuyor.

Kişilik tanımı **hiçbir arayüzde gösterilmiyor.** `config.js`'ten sistem istemine
gidiyor ve başka hiçbir yere; arka plan onu döndüren bir mesaj bile tanımlamıyor.

---

## Gizlilik

- `DEEPSEEK_API_KEY` sadece `background.js` içinde okunuyor. İçerik betiklerine
  veya popup'a asla gönderilmiyor.
- Dışarı giden ağ istekleri:
  - `api.deepseek.com/chat/completions` — sadece sen bir Üret / Taslak / `a`
    düğmesine bastığında
  - `x.com/i/api/graphql/…` — sadece planlama açıkken, senin yazdığın gönderiyi
    kaydetmek için
  - `abs.twimg.com` — sadece X'in işlem kimliği eskidiğinde, güncelini bulmak için
  - Analitik yok, üçüncü taraf SDK yok, telemetri yok.
- Panel konumu, sayaçlar, filtre durumu ve planlama kuralları makinendeki
  `chrome.storage.local`'da duruyor.
- **Safari'de anahtar derlenmiş `X Verim.app`'in içine giriyor**, yani oradaki
  kural sadece "`config.js`'i commit'leme" değil, "bu .app'i kimseye verme".

---

## X arayüzünü değiştirirse

Bütün seçiciler **`lib/x-dom.js`** dosyasının en üstündeki `SELECTORS` nesnesinde.
x.com'da DevTools aç, bozulan öğenin yeni `data-testid`'sini bul, ilgili satırı
güncelle, eklentiyi yeniden yükle.

Aynı dosyadaki yardımcı fonksiyonlar (`getTweetArticle`, `getTweetText`,
`getAuthorHandle`, `getLikeButton`, `getCountsFromGroup`, …) eklentinin X ile
konuşma biçiminin tek kaynağı.

---

## JS dosyaları neden BOM ile başlıyor

Safari, karakter kümesi belirtilmemiş arka plan betiklerini Latin-1 olarak
çözüyor ve `başına` kelimesi `baÅŸÄ±na` oluyordu — arayüzde gözle görülür şekilde,
sistem isteminde ve `lib/x-dom.js`'teki Türkçe etkileşim tablosunda ise görünmez
şekilde (bozulmuş bir `beğeni` bütün beğeni sayılarını sessizce 0 okutuyordu).
Bu yüzden her `.js` dosyası UTF-8 BOM ile başlıyor; bu iki tarayıcıda da UTF-8'i
zorluyor ve JS tarafından boşluk sayılıyor. Düzenlerken koru: "UTF-8 with BOM"
olarak kaydet. `content.css` sorunu farklı çözüyor, tek ASCII olmayan karakterini
`\2022` kaçışıyla yazıyor.

---

## Dosyalar

```
x-verim/
├── manifest.json              MV3 manifest
├── config.example.js          Şablon — config.js olarak kopyala
├── config.js                  Kişisel ayarlar — COMMIT EDİLMİYOR
├── planlama-kurallarim.json   Planlama kuralların — COMMIT EDİLMİYOR
├── background.js              DeepSeek çağrıları + hız sayaçları
├── lib/x-dom.js               SELECTORS + DOM yardımcıları
├── content/
│   ├── content.js             Odak modeli, kısayollar, filtre, panel, kart, planlayıcı
│   ├── content.css            Koyu tema stilleri
│   └── draft-bridge.js        Draft.js köprüsü (sayfa dünyasında çalışır)
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/                     16 / 48 / 128 px PNG
├── README.md
└── .gitignore

x-verim-safari/                Safari sarmalayıcı — ../x-verim'e referans verir
└── X Verim/X Verim.xcodeproj
```

`draft-bridge.js` neden ayrı bir dosya: Safari, eklentinin yalıtılmış dünyasından
gönderilen yapay pano olaylarını X'in React ağacına güvenilir şekilde iletmiyor.
Bu köprü sayfanın kendi dünyasında çalışıp Draft.js'in gerçek `onPaste`
işleyicisini çağırıyor, böylece metin editörün modeline doğrudan giriyor ve
tarayıcı ortada hayalet bir metin düğümü bırakmıyor.
