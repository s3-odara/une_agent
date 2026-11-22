# `geocode` の全国版DBを作る

ダウンロードしたファイルを、展開せずに次の場所に置く。

| ダウンロード元 | 置き場所 |
|---|---|
| [国交省 P05（2022年度・全国版）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P05-2022.html) | `data/geocode-sources/P05-22_GML.zip` |
| [国交省 位置参照情報](https://nlftp.mlit.go.jp/cgi-bin/isj/dls/_choose_method.cgi)：大字・町丁目の47都道府県分 | `data/geocode-sources/isj/*.zip` |
| 同じ年度の街区レベル（必要な都道府県分） | `data/geocode-sources/isj-blocks/*.zip` |
| [Geofabrik Japan](https://download.geofabrik.de/asia/japan.html)：全国版（数 GB） | `data/geocode-sources/japan-latest.osm.pbf` |

```sh
just geocode-db
```

`data/geocode.sqlite` ができたら、元データは消してよい。設定の `dataDir` が `data/` と違う場合は、`just geocode-db data/geocode-sources <dataDir>/geocode.sqlite` で出力先を指定する。更新後の再起動は不要。

町丁目名だけでも検索できる。施設名で検索するときは `area` に地域名を指定して、所在地で絞れる。街区が引けない住所は町丁目の代表点を返す。施設データの出典は [© OpenStreetMap contributors (ODbL)](https://www.openstreetmap.org/copyright)。再配布時は各データの利用条件を確認する。
