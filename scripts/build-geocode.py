#!/usr/bin/env python3
import argparse
import csv
import io
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from zipfile import ZipFile


FACILITY_TAGS = ('amenity', 'shop', 'leisure', 'tourism', 'office', 'healthcare', 'building', 'historic')
EXTRA_TAGS = {
    'aerialway': {'station'},
    'aeroway': {'aerodrome', 'terminal'},
    'highway': {'services', 'rest_area'},
    'man_made': {'tower', 'lighthouse'},
    'mountain_pass': {'yes'},
    'natural': {'peak', 'saddle', 'volcano', 'cape', 'beach'},
    'place': {'square'},
    'railway': {'station', 'halt', 'tram_stop'},
    'waterway': {'dam', 'weir'},
}
NAME_TAGS = ('name:ja', 'name', 'name:en', 'alt_name:ja', 'alt_name', 'short_name:ja', 'short_name', 'official_name')
DIGITS = '一二三四五六七八九'


def key(name):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', name).lower())


def chome_key(name):
    def number(match):
        parts = match[0].split('十')
        digit = lambda s: DIGITS.index(s) + 1 if s else 0
        return str(digit(parts[0]) if len(parts) == 1 else (digit(parts[0]) or 1) * 10 + digit(parts[1]))

    return re.sub(fr'(?:[{DIGITS}]?十[{DIGITS}]?|[{DIGITS}])(?=丁目)', number, name)


def files(path, suffix):
    if path.suffix.lower() == suffix:
        with path.open('rb') as stream:
            yield stream
        return
    with ZipFile(path) as archive:
        yield from members(archive, suffix)


def members(archive, suffix):
    for name in archive.namelist():
        if name.startswith('__MACOSX/') or Path(name).name.startswith('._'):
            continue
        if name.lower().endswith(suffix):
            with archive.open(name) as stream:
                yield stream
        elif name.lower().endswith('.zip'):
            with ZipFile(io.BytesIO(archive.read(name))) as nested:
                yield from members(nested, suffix)


class Builder:
    def __init__(self, db):
        self.db = db
        db.executescript('''
            CREATE TABLE place (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
                lat REAL NOT NULL, lon REAL NOT NULL, kind TEXT NOT NULL,
                UNIQUE (name, address, lat, lon, kind)
            );
            CREATE TABLE alias (
                key TEXT NOT NULL, place_id INTEGER NOT NULL REFERENCES place(id),
                PRIMARY KEY (key, place_id)
            ) WITHOUT ROWID;
        ''')
        self.counts = dict.fromkeys(('office', 'town', 'facility'), 0)

    def add(self, name, address, point, kind, aliases):
        lon, lat = point[:2]
        if not name or not (20 <= lat <= 46 and 122 <= lon <= 154):
            return
        cursor = self.db.execute('INSERT OR IGNORE INTO place (name,address,lat,lon,kind) VALUES (?,?,?,?,?)',
                                 (name, address, lat, lon, kind))
        if cursor.rowcount:
            self.counts[kind] += 1
            place_id = cursor.lastrowid
        else:
            place_id, = self.db.execute('SELECT id FROM place WHERE name=? AND address=? AND lat=? AND lon=? AND kind=?',
                                        (name, address, lat, lon, kind)).fetchone()
        keys = {key(alias) for alias in aliases if alias}
        if kind == 'town':
            keys |= {chome_key(k) for k in keys}
        self.db.executemany('INSERT OR IGNORE INTO alias VALUES (?,?)', ((k, place_id) for k in sorted(keys) if k))


def towns(builder, paths):
    municipalities = {}
    for path in paths:
        for stream in files(path, '.csv'):
            data = stream.read()
            try:
                data = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                data = data.decode('cp932')
            reader = csv.DictReader(io.StringIO(data, newline=''))
            required = {'都道府県名', '市区町村名', '市区町村コード', '緯度', '経度'}
            town_field = next((f for f in ('大字町丁目名', '大字・町丁目名') if f in (reader.fieldnames or [])), None)
            if not town_field or not required.issubset(reader.fieldnames or []):
                raise ValueError(f'{path}: 大字・町丁目 CSV の見出しが見つかりません: {reader.fieldnames}')
            for row in reader:
                pref, city, town = (row[f].strip() for f in ('都道府県名', '市区町村名', town_field))
                municipalities[row['市区町村コード'].strip()] = (pref, city)
                if not town or not row['経度'] or not row['緯度']:
                    continue
                short_city = without_county(city)
                name = pref + city + town
                builder.add(name, name, (float(row['経度']), float(row['緯度'])), 'town',
                            (name, city + town, pref + short_city + town, short_city + town, town))
    return municipalities


def without_county(city):
    return re.sub(r'^.+?郡(?=.+[町村]$)', '', city)


def offices(builder, paths, municipalities):
    prefectures = {code[:2]: pref for code, (pref, _) in municipalities.items()}
    for path in paths:
        for stream in files(path, '.geojson'):
            for feature in json.load(stream)['features']:
                p = feature['properties']
                if str(p['P05_002']) != '1':
                    continue
                code = str(p['P05_001']).zfill(5)
                name = p['P05_003']
                address = p['P05_004'] or ''
                pref, city = municipalities.get(code, (prefectures.get(code[:2], ''), ''))
                label = re.sub(r'(?:役所|役場)$', '', key(name))
                city_aliases = {label}
                if label and label == key(without_county(city)):
                    city_aliases.add(city)
                elif address.startswith(city) and city and label.endswith('区') and key(city).endswith(label):
                    city_aliases.add(city)
                aliases = {name, *city_aliases}
                builder.add(name, pref + address if not address.startswith(pref) else address,
                            feature['geometry']['coordinates'], 'office', aliases | {pref + a for a in aliases if a})


def polygon_point(rings):
    outer = rings[0]
    ys = sorted({p[1] for ring in rings for p in ring})
    if len(ys) < 2:
        return None
    middle = (min(p[1] for p in outer) + max(p[1] for p in outer)) / 2
    for low, high in sorted(zip(ys, ys[1:]), key=lambda pair: abs(sum(pair) / 2 - middle)):
        y = (low + high) / 2
        xs = sorted(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])
                    for ring in rings for a, b in zip(ring, ring[1:]) if (a[1] > y) != (b[1] > y))
        if len(xs) >= 2:
            a, b = max(zip(xs[::2], xs[1::2]), key=lambda interval: interval[1] - interval[0])
            return ((a + b) / 2, y)
    return None


def line_point(coordinates):
    if not coordinates:
        return None
    x = sum(p[0] for p in coordinates) / len(coordinates)
    y = sum(p[1] for p in coordinates) / len(coordinates)
    return (x, y)


def area(rings):
    return abs(sum(a[0] * b[1] - a[1] * b[0] for a, b in zip(rings[0], rings[0][1:])))


def facility(builder, feature):
    p = feature['properties']
    geometry = feature['geometry']
    if not (any(p.get(tag) and p[tag] != 'no' for tag in FACILITY_TAGS)
            or any(p.get(tag) in values for tag, values in EXTRA_TAGS.items())
            or (p.get('highway') == 'traffic_signals' and geometry['type'] == 'Point')):
        return
    names = [p.get(tag, '') for tag in NAME_TAGS]
    name = next((n for n in names[:3] if n.strip()), '')
    if not name:
        return
    if geometry['type'] == 'Point':
        point = geometry['coordinates']
    elif geometry['type'] == 'Polygon':
        point = polygon_point(geometry['coordinates'])
    elif geometry['type'] == 'MultiPolygon':
        point = polygon_point(max(geometry['coordinates'], key=area))
    elif geometry['type'] == 'LineString':
        point = line_point(geometry['coordinates'])
    elif geometry['type'] == 'MultiLineString':
        point = line_point(max(geometry['coordinates'], key=len))
    else:
        return
    if point is None:
        return
    city = p.get('addr:city', '')
    province = p.get('addr:province', '')
    suburb = p.get('addr:suburb', '')
    address = p.get('addr:full') or province + city + suburb + p.get('addr:street', '') + p.get('addr:housenumber', '')
    aliases = {a.strip() for n in names for a in n.split(';') if a.strip()}
    # OSM の駅は名前に「駅」を付けない慣習（name=赤羽）なので、「赤羽駅」という呼び方でも引けるよう別名を足す。
    if p.get('railway') in ('station', 'halt', 'tram_stop') and not name.endswith('駅'):
        aliases.add(f'{name}駅')
    builder.add(name, address, point, 'facility', aliases)


def facility_sequence(builder, lines):
    for line in lines:
        facility(builder, json.loads(line.lstrip('\x1e')))


def facilities(builder, path, work):
    if path.suffix == '.geojsonseq':
        with path.open(encoding='utf-8') as stream:
            facility_sequence(builder, stream)
        return
    filtered = work / 'facilities.osm.pbf'
    filters = [*FACILITY_TAGS, *(f'{tag}={",".join(sorted(values))}' for tag, values in EXTRA_TAGS.items()), 'n/highway=traffic_signals']
    subprocess.run(['osmium', 'tags-filter', str(path), *filters, '-o', str(filtered)], check=True)
    # linestringは閉じ切っていない名前付き建物・公園などを落とさないために含める。
    command = ['osmium', 'export', str(filtered), '-f', 'geojsonseq', '--geometry-types=point,linestring,polygon']
    with subprocess.Popen(command, stdout=subprocess.PIPE, encoding='utf-8') as process:
        try:
            facility_sequence(builder, process.stdout)
        except BaseException:
            process.kill()
            raise
        if process.wait():
            raise subprocess.CalledProcessError(process.returncode, command)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--offices', type=Path, nargs='+', required=True)
    parser.add_argument('--towns', type=Path, nargs='+', required=True)
    parser.add_argument('--osm', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('data/geocode.sqlite'))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.geocode-', dir=args.output.parent) as temp:
        work = Path(temp)
        db_path = work / 'geocode.sqlite'
        db = sqlite3.connect(db_path)
        try:
            builder = Builder(db)
            municipalities = towns(builder, args.towns)
            offices(builder, args.offices, municipalities)
            if not builder.counts['office'] or not builder.counts['town']:
                parser.error('役場または町丁目のデータが空です')
            facilities(builder, args.osm, work)
            if not builder.counts['facility']:
                parser.error('OSM の施設データが空です')
            db.commit()
        finally:
            db.close()
        db_path.replace(args.output)
    counts = builder.counts
    print(f"{args.output}: 本庁 {counts['office']:,} / 町丁目 {counts['town']:,} / 施設 {counts['facility']:,}", file=sys.stderr)


if __name__ == '__main__':
    main()
