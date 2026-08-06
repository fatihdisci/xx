# X Verim

X'te tek bir kişinin işini hızlandıran kişisel bir tarayıcı eklentisi. Chrome ve
Safari'de çalışır, Web Store'a çıkmaz, sadece senin makinende durur.

Ne yapar, kısaca:

- **Klavyeyle gezinme** — `j` / `k` ile tweetler arasında, fareye dokunmadan
- **Yanıt taslakları** — `a` ile, senin sesinde, tweetin kendi dilinde (OpenRouter üzerinden)
- **Maliyet sayacı** — her taslağın gerçekte kaça mal olduğu, popup'ta
- **Gönderi planlama** — yazdığın mesajları X'in kendi planlayıcısına kaydeder, bilgisayar kapalıyken bile paylaşılır

Bir zamanlar niş filtresi, sıfırdan gönderi üretme, beğeni/takip kısayolları ve
hız korkuluğu da vardı. Hiçbiri kullanılmadı, hepsi silindi. Beğenmek ve takip
etmek X'in kendi tuşlarıyla zaten çalışıyor.

---

## Değişmeyecek dört kural

**1. Tek otomasyon, senin kurduğun otomasyon.** Yanıt her zaman senin tuşuna
basmanı ister; eklenti kendi kafasına göre "Gönder" düğmesine basmaz. Tek istisna var ve bilerek konuldu: popup'taki
*Gönderi planlama* kartına yazdığın gönderiler, senin seçtiğin saatte, senin
yazdığın metinle paylaşılır. Bunun dışında hiçbir şey o düğmeye dokunamaz ve
planlama varsayılan olarak **kapalıdır**.

**2. Seçici disiplini.** X'in sayfasındaki her öğe `data-testid`, `role` veya
`aria-label` ile bulunur. CSS sınıf adları (`css-1dbjc4n` gibi) kullanılmaz,
çünkü onlar her hafta değişir.

**3. Telemetri yok.** Makinenden dışarı sadece şunlar çıkar: `openrouter.ai`'a
gönderdiğin tweet metni ve kişilik tanımın, bir de planlamayı açtıysan `x.com`'un
kendi API'sine senin yazdığın gönderiler. Başka hiçbir yere hiçbir şey gitmez.

**4. Kişisel kullanım.** Bu tek kişilik bir eklenti. Yayınlama.

---

## Kurulum

### Chrome

1. `config.example.js` dosyasını `config.js` olarak kopyala ve doldur:
   - `OPENROUTER_API_KEY` — OpenRouter API anahtarın
   - Model seçimini eklenti popup'ındaki **Yanıt modeli** menüsünden yapabilirsin;
     seçim tarayıcıda kaydedilir ve sonraki taslaklar OpenRouter üzerinden onunla üretilir.
   - `PERSONA.identity` / `niche` / `tone` — kim olduğun, ne hakkında yazdığın, nasıl konuştuğun
   - `PERSONA.samples` — **kalitede en büyük fark burada.** Gerçekten yazdığın
     birkaç tweet. Model bunların ritmini kopyalar, içeriğini asla.
   - İsteğe bağlı: `PRICING.usdTry` (popup'ta ₺ karşılığı), `AI_TIMEOUT_MS`
     (varsayılan 45 sn)
2. `chrome://extensions` aç, sağ üstten **Developer mode**'u aç.
3. **Load unpacked** de ve `x-verim/` klasörünü seç.
4. `https://x.com` aç. `j` / `k` ile gez, `a` ile taslak üret.

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

Üç tuş, hepsi bu. `config.js` içindeki `SHORTCUTS` bölümünden değiştirilebilir,
bir tuşu `""` yaparsan o işlem tamamen kapanır.

| Tuş | Ne yapar |
| --- | --- |
| `j` | Sonraki tweete geç |
| `k` | Önceki tweete geç |
| `a` | Taslak kartını aç |
| `1`…`5` | Kart açıkken: o taslağı yanıt kutusuna koy |
| `Esc` | Kartı kapat |

Beğeni, yer işareti, takip ve panel kısayolları kaldırıldı. İlk üçü X'in kendi
tuşlarıyla zaten çalışıyordu ve aynı harfleri iki kere sahiplenmenin kimseye
faydası yoktu; panelin gösterdiği iki şey (filtre, hız sayacı) de artık yok.

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
Böylece satır tarafından kırpılamıyor ve X'in hover renkleriyle kavga edemiyor. Çubuk satırın gerçekten görebildiğin
kısmına ortalanıyor, yani ekrandan uzun bir tweet bile işaretini gösteriyor. X'in
üstteki yapışkan başlığının yüksekliği tahmin edilmiyor, ölçülüyor — anasayfadaki
sekme çubuğu onu diğer sayfalardan daha uzun yapıyor.

Yanıt veya gönderi penceresi açıkken işaretin tamamı gizleniyor, X'in o pencerenin
içine kopyaladığı tweet hiçbir zaman seçilemiyor.

Konsoldan `window.__xverim.applyFocus()` ile bu geçişi elle adımlayabilir,
`window.__xverim.articles()` ile hangi satırları değerlendirdiğini görebilirsin.

---

## Yanıt taslakları

### `a` — taslak kartı

Bir tweete odaklanıp `a`'ya bastığında sağ tarafta küçük bir kart açılıyor ve
içinde hazır yanıt taslakları oluyor.

- Üstte kaynak tweetin kullanıcı adı ve ilk satırı duruyor. Bir oturumda birkaç
  kart açınca hangisine cevap yazdığın belirsizleşiyordu.
- **Kartın tamamı düğme.** Metnin dışında bir yere tıklamak taslağı yanıt
  kutusuna gönderiyor. Eskiden her tweet için üç kez küçük bir `Yanıtla`
  düğmesi aranıyordu, döngünün en yavaş kısmı oydu.
- Metnin kendisi **yerinde düzenlenebilir**, canlı karakter sayacı var (240'ı
  geçince sarı, 280'i geçince kırmızı). Rakam tuşları ve kopyalama hepsi o anda
  kutuda ne yazıyorsa onu kullanıyor.
- Taslağın içindeyken `Cmd`/`Ctrl` + `Enter` onu yanıt kutusuna gönderiyor. `Esc`
  önce kutudan çıkıyor, böylece yanlışlıkla basılan bir Esc düzenlemeni çöpe atmıyor.
- ↻ yeniden üretiyor. Ekrandaki taslakları modele "bunları tekrarlama" diye geri
  gönderiyor, yani yeniden üretim *farklı açılar* demek, aynı cümlenin yeniden
  yazımı değil.
- Kaynak tweetin altındaki kutu **yeniden üretimin yönünü** veriyor: `daha sert
  ol`, `futbolla bağlantı kur`, `soru sorma` gibi bir satır yazıp `Enter`'a basmak
  taslakları o yönde yeniden üretiyor. ↻ de kutuda ne yazıyorsa onu kullanıyor,
  kutu boşken eskisi gibi sadece başka açılar deniyor.
  - `a` bu kutuyu **hiç okumuyor** — ilk parti her zaman aynı ilk parti. Görmediğin
    taslağa yön veremezsin, ve devreden kalmış bir not sonraki tweetin ilk
    taslaklarını sessizce eğseydi daha kötü bir sürpriz olurdu. Aynı tweette
    tekrar `a`'ya basmak kutuyu temizliyor.
  - Yazdığın satır modele *taslakların yönü* olarak gidiyor, yeni bir görev
    olarak değil: tepki listesini eziyor (üç taslağın tek düşünce olmamasını o
    liste sağlıyordu, açık bir yön bunu daha iyi yapıyor) ama tek bir ses
    kuralını ezmiyor. `daha resmi yaz` demek uzun tireleri geri satın almıyor.
    Not asla taslağın içinde görünmüyor, yanıtlanmıyor, alıntılanmıyor.
  - Kutunun içinde `a` / `j` / `k` / rakamlar kısayol değil, harf. `Esc` önce
    kutudan çıkıyor, kartı kapatmıyor. Model çalışırken basılı tutulan `Enter`
    ikinci bir istek açmıyor.
- Kartın altında o çağrının **gerçek maliyeti** yazıyor. Günde elli kez
  tekrarlanan bir alışkanlığın fiyatı görünmez olmamalı.
- **Tweet detay sayfasındayken**, tweetin altında görünen yanıtlar (en fazla 10
  tane, X'in "Daha fazlasını keşfet" bloğundan önce durarak) modele bağlam olarak
  gidiyor. Taslaklar thread'de zaten söylenmiş şeyleri tekrarlamıyor ve ortamın
  tonuna uyuyor. Bu olduğunda kartın altı `N yanıt okundu` diyor.
- Hata veya boş sonuç durumunda ölü bir kart yerine `Tekrar dene` düğmesi çıkıyor.

### Taslakların sesi nereden geliyor

`background.js` içindeki `buildSystemPrompt()` bir taslağın sesinin belirlendiği
tek yer. Kurallar sıfat yerine somut yasaklar olarak yazılmış, çünkü "doğal ol"
hiçbir şeyi değiştirmezken "uzun tire kullanma" değiştiriyor. Dört blok var:

**`HUMAN_VOICE`** — bir metni ilk bakışta makine yapımı gösteren kalıpları eliyor:
"X değil, Y", üç maddelik listeler, retorik soruyla açılış, telefon klavyesinin
üretmediği noktalama (uzun tire, noktalı virgül, kıvrık tırnak). Ayrıca cümle
simetrisini yasaklıyor — eşit uzunlukta iki yan cümle, düzgün kapanan tempo,
aslında en yüksek sesli AI işareti bu.

**`NO_FAKE_WARMTH`** — modelin varsayılan hâli tanımadığı insana sıcaklık
performansı yapmak. "Anlıyorum", "çok haklısın", "hepimiz", itirazdan önce
yumuşatma yastığı, "harika/muhteşem" — hepsi yasak. Sevilmek hedef değil;
ilgisizlik de geçerli bir çıktı.

**`TURKISH_VOICE`** — İngilizce kurallar Türkçe çıktıyı kurtarmıyor, çünkü Türkçe
AI kokusu bambaşka yerden geliyor: `dolayısıyla / kısacası / öte yandan` gibi yazı
dili bağlaçları, `-maktadır` kaydı, `aslında / gerçekten / oldukça` doldurucuları,
"bu sadece X değil aynı zamanda Y" kalıbı. Karşılığında serbest bırakılanlar:
kesme işaretini atlamak (`Xte`, `GitHubda`), `bi / geliyo` gibi konuşma
kısaltmaları, `sen` hitabı ve `prompt / agent / commit / build` gibi terimleri
çevirmeden bırakmak.

**`REWRITE_PAIRS`** — aynı düşüncenin yanlış ve doğru yazımı yan yana. Kural
hedefi tarif ediyor, örnek hareketi gösteriyor; kırk yasağı akılda tutan bir
modele göre iki yazımı görmüş model kendini çok daha güvenilir düzeltiyor.

Bunların üstüne `config.js`'teki `PERSONA.samples` üslup çıpası olarak
yapıştırılıyor — çıktının sana ne kadar benzeyeceği üzerindeki en güçlü kol bu.
`PERSONA.tone` içinde "samimi" yazmamaya dikkat et: model bunu okuyunca tam da
yukarıda yasaklanan şeyi yapıyor.

Sampler tarafında `frequency_penalty: 0.3` var. Prompt kuralları tek başına bir
partinin aynı şablona oturmasını engellemiyor; üç taslağın üç farklı ruh hâlinde
olmasını sağlayan şey bu.

Her isteme bugünün gerçek tarihi de yazılıyor. Bir modelin "şimdi" algısı eğitim
kesim tarihi olduğu için taslaklar sessizce daha eski bir yılı varsayıp kendilerini
2024'e tarihliyordu. Tarih satırı her istekte yerel tarih parçalarından kuruluyor
(`toISOString()` UTC olduğu için akşam saatlerinde bize dünü söylerdi), böylece
gece boyu açık kalan bir sekme dünün tarihini taşımıyor.

---

## Popup (araç çubuğu simgesi)

İki şey var: maliyet ve planlama.

**Maliyet** — üstte toplam, altında bugün, taslak başına ortalama ve son çağrı.
Yedi günlük mini grafik bugünün olağan dışı olup olmadığını aritmetik yapmadan
söylüyor. En altta token dağılımı (giriş / önbellek / çıkış) ve kullanılan birim
fiyatlar duruyor.

Bunların hiçbiri tahmin değil: `background.js` her yanıtın `usage` alanını okuyup
`chrome.storage.local`'a yazıyor. OpenRouter/model fiyatlarına göre üç ayrı fiyat alanı
gelen giriş, ıskalayan girişten ~50 kat ucuz — tek bir karma sayı, sistem istemini
tekrar tekrar gönderen bir oturumda (yani buradaki her oturumda) bir mertebe
yanlış olurdu, o yüzden üçü ayrı tutuluyor.

Bir taslak zaman tünelinde üretildiğinde popup açıksa toplam anında güncelleniyor.
`sıfırla` sadece buradaki sayacı sıfırlıyor, OpenRouter'daki gerçek faturanı değil.

**Planlama** — aşağıda.

---

## Kesin tarihli JSON planlama

Planlayıcı varsayılan olarak kapalıdır ve artık yalnızca önceden hazırlanmış
kesin tarihli JSON kabul eder. Kural, mesaj havuzu, `skip`, günlük kura veya
otomatik metin üretimi yoktur. Sistem JSON'da yazmayan hiçbir gönderiyi
oluşturmaz; metni ve saati değiştirmez.

### JSON biçimi

```json
{
  "version": 2,
  "type": "xverim-calendar",
  "timezone": "Europe/Istanbul",
  "posts": [
    {
      "id": "cal-ms4c1yig-1",
      "at": "2026-07-28T10:27:07+03:00",
      "text": "hey, good morning",
      "label": "EN · Avrupa sabahı"
    }
  ]
}
```

- `posts` zorunlu ve boş olmayan bir dizidir.
- `at` ISO 8601 tarih-saat veya milisaniye zaman damgasıdır. Saat dilimi
  açıkça yazılmalıdır; içe aktarım bunu mutlak zamana dönüştürür.
- `text` zorunludur ve en fazla 280 karakter olabilir.
- `id` verilmezse tarih ve metinden kararlı bir kimlik üretilir. Aynı JSON'u
  tekrar yüklemek aynı gönderiyi ikinci kez planlamaz.
- `label` isteğe bağlıdır ve yalnızca yerel durum için kullanılır.

### Kullanım

1. **Plan JSON'u** kutusuna kesin tarihli dosyayı yapıştır.
2. **JSON'u yükle** düğmesine bas.
3. Üstteki **Açık** anahtarını aç.
4. **JSON planını X'e aktar** düğmesine bir kez bas.
5. Sayaç `60/60 X'e kayıtlı` olduğunda X sekmesi ve bilgisayar kapatılabilir.

**Mevcut JSON'u yaz** depodaki geçerli kesin planı kutuya çıkarır. Yeni JSON
yüklemek yerel listenin yerini alır; X'e daha önce kaydedilmiş gönderileri
silmez. Bunun için X'in Planlanmış ekranı kullanılmalıdır.

Hazırlanmış kişisel dosya `planlama-60-gun.json` adındadır ve gitignore
nedeniyle repoya girmez. Metinlerin herkese açık kaynak kodda bulunmaması
bilinçli bir gizlilik tercihidir.

### Bilgisayar kapalıyken

Her gönderi x.com'un kendi `CreateScheduledTweet` işlemiyle X'in planlanmış
gönderiler kuyruğuna kaydedilir. Yetki mevcut x.com oturumundan gelir; eklenti
çerezi okumaz, saklamaz veya başka bir yere göndermez. X kabul ettikten sonra
paylaşımı X yapar ve bilgisayarın açık kalması gerekmez.

Aktarım sırasında X sekmesi açık kalmalıdır. Gönderiler aynı anda patlatılmaz;
her başarılı kayıt arasında rastgele 20–35 saniye bulunur. X `403 Forbidden`
veya `429` döndürürse kesin başarısız kayıt kaybolmaz, geri çekilme süresinden
sonra yeniden denenir. 60 gönderinin ilk aktarımı normalde yaklaşık 20–35
dakika sürer.

### İç mekanik

- JSON sırası ne olursa olsun en yakın tarih önce kaydedilir.
- Birden fazla x.com sekmesi aynı gönderiyi ağ isteğinden önce sahiplenir; iki
  sekme aynı kaydı oluşturmaz.
- Beş dakikadan yakın veya geçmiş zamanlar X'e gönderilmez.
- X'in GraphQL işlem kimliği değişirse güncel paketlerden bir kez yeniden
  bulunur.
- X'in zorunlu `X-Client-Transaction-Id` başlığı o anki herkese açık X
  doğrulama verisinden tarayıcı içinde üretilir.
- Yerel plan `xverim_schedule_v1`, sonuç durumu
  `xverim_schedule_state_v1` altında tutulur.
- Bir yanıt belirsizse otomatik tekrar yapılmaz; kesin HTTP reddi varsa güvenli
  geri çekilmeyle yeniden denenir. Böylece çift plan, kaçırılmış plandan daha
  olası hâle getirilmez.

---

## Geri bildirim

Eskiden konsola düşen her şey artık sağ altta küçük bir bildirim olarak çıkıyor:
yanıt kutusuna giden bir taslak, bir API hatası, seçili tweet yokken basılan bir
tuş. Bir taslak gönderi kutusuna ulaşamazsa panoya kopyalanıyor ve bildirim bunu
söylüyor — üretilmiş bir taslak asla sessizce kaybolmuyor.

Kişilik tanımı **hiçbir arayüzde gösterilmiyor.** `config.js`'ten sistem istemine
gidiyor ve başka hiçbir yere; arka plan onu döndüren bir mesaj bile tanımlamıyor.

---

## Gizlilik

- `OPENROUTER_API_KEY` sadece `background.js` içinde okunuyor. İçerik betiklerine
  veya popup'a asla gönderilmiyor.
- Dışarı giden ağ istekleri:
  - `openrouter.ai/api/v1/chat/completions` — sadece sen `a`'ya bastığında
  - `x.com/i/api/graphql/…` — sadece planlama açıkken, senin yazdığın gönderiyi
    kaydetmek için
  - `abs.twimg.com` — sadece X'in işlem kimliği eskidiğinde, güncelini bulmak için
  - Analitik yok, üçüncü taraf SDK yok, telemetri yok.

Planlama isteklerindeki `X-Client-Transaction-Id`, MIT lisanslı
[`x-client-transaction-id`](https://github.com/Lqm1/x-client-transaction-id)
uygulamasından tarayıcıya uyarlanan kodla yerel olarak üretilir.
- Maliyet sayacı ve kesin tarihli JSON planı makinendeki
  `chrome.storage.local`'da duruyor. Sayaç sadece token adetleri ve tarih tutuyor,
  hiçbir tweet metni saklanmıyor.
- **Safari'de anahtar derlenmiş `X Verim.app`'in içine giriyor**, yani oradaki
  kural sadece "`config.js`'i commit'leme" değil, "bu .app'i kimseye verme".

---

## X arayüzünü değiştirirse

Bütün seçiciler **`lib/x-dom.js`** dosyasının en üstündeki `SELECTORS` nesnesinde.
x.com'da DevTools aç, bozulan öğenin yeni `data-testid`'sini bul, ilgili satırı
güncelle, eklentiyi yeniden yükle.

Aynı dosyadaki yardımcı fonksiyonlar (`getTweetArticle`, `getTweetText`,
`getAuthorHandle`, `getReplyButton`, `getCountsFromGroup`, …) eklentinin X ile
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
├── planlama-60-gun.json       Kesin tarihli kişisel plan — COMMIT EDİLMİYOR
├── background.js              OpenRouter çağrıları + sistem istemi + maliyet sayacı
├── lib/x-dom.js               SELECTORS + DOM yardımcıları
├── lib/x-transaction.js       Planlama için X-Client-Transaction-Id üretimi
├── content/
│   ├── content.js             Odak modeli, kısayollar, taslak kartı, planlayıcı
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
