#!/usr/bin/env python3
"""チャレンジモード用データの取得（ネットワークが必要）

Wikidata（SPARQL）でアニメ作品・原作・キャラクターを集め、日本語版 Wikipedia の
本文（作品記事と「〜の登場人物」記事）を取得してキャッシュに保存します。
保存したキャッシュから tools/build_challenge.py が data/challenge-data.js を作ります。

    python3 tools/fetch_challenge_sources.py CACHE_DIR

必要な接続先: query.wikidata.org, ja.wikipedia.org
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = 'AnikanDataBuilder/1.0 (kanji study app; build script)'
ANIME = ['Q63952888', 'Q20650540', 'Q1047299', 'Q220898', 'Q1107', 'Q113671041', 'Q581714', 'Q100269041']
SOURCE = ['Q21198342', 'Q747381', 'Q104213567']  # 漫画・ライトノベル・ウェブ漫画
CHAR_CLASSES = ['Q80447738', 'Q87576284', 'Q15632617', 'Q3658341', 'Q28020127', 'Q15773347', 'Q15773317',
                'Q15711870', 'Q95074', 'Q1114461', 'Q34315358', 'Q30061417', 'Q17624054', 'Q89050960',
                'Q30061294', 'Q3050815', 'Q32851726', 'Q30170627', 'Q30168244', 'Q22074477', 'Q18327510',
                'Q3959568', 'Q1569167', 'Q106080057']


def http_json(url, data=None, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.load(res)
        except Exception as e:  # noqa: BLE001
            print('  retry', k + 1, e, file=sys.stderr)
            # 429（混雑・制限中）は長めに待つ
            time.sleep(65 if '429' in str(e) else 5 * (k + 1))
    raise RuntimeError(f'failed: {url[:120]}')


def sparql(query):
    url = 'https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': query, 'format': 'json'})
    return http_json(url)['results']['bindings']


def qid(v):
    return v.rsplit('/', 1)[1]


def values(ids):
    return ' '.join('wd:' + i for i in ids)


def fetch_wikidata(cache):
    out = {}
    print('works…', file=sys.stderr)
    rows = sparql(f'''SELECT ?w ?ja ?sl ?cls ?art WHERE {{
      VALUES ?cls {{ {values(ANIME + SOURCE)} }}
      ?w wdt:P31 ?cls ; wikibase:sitelinks ?sl .
      OPTIONAL {{ ?w rdfs:label ?ja . FILTER(LANG(?ja) = "ja") }}
      OPTIONAL {{ ?a schema:about ?w ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?art . }}
    }}''')
    works = {}
    for b in rows:
        w = works.setdefault(qid(b['w']['value']), {'ja': None, 'sl': int(b['sl']['value']), 'cls': [], 'art': None})
        if 'ja' in b:
            w['ja'] = b['ja']['value']
        if 'art' in b:
            w['art'] = b['art']['value']
        c = qid(b['cls']['value'])
        if c not in w['cls']:
            w['cls'].append(c)
    out['works'] = works
    time.sleep(2)
    print('based on…', file=sys.stderr)
    rows = sparql(f'''SELECT ?a ?m WHERE {{ VALUES ?cls {{ {values(ANIME)} }} ?a wdt:P31 ?cls ; wdt:P144 ?m . }}''')
    out['based_on'] = [[qid(b['a']['value']), qid(b['m']['value'])] for b in rows]
    print('characters…', file=sys.stderr)
    chars = {}
    for ct in CHAR_CLASSES:
        time.sleep(2)
        rows = sparql(f'''SELECT ?c ?ja ?kana ?sl ?work WHERE {{
          VALUES ?cls {{ {values(ANIME + SOURCE)} }}
          ?c wdt:P31 wd:{ct} .
          {{ ?c wdt:P1441 ?work }} UNION {{ ?work wdt:P674 ?c }}
          ?work wdt:P31 ?cls .
          ?c rdfs:label ?ja ; wikibase:sitelinks ?sl .
          FILTER(LANG(?ja) = "ja")
          OPTIONAL {{ ?c wdt:P1814 ?kana . }}
        }}''')
        for b in rows:
            c = chars.setdefault(qid(b['c']['value']), {'ja': b['ja']['value'], 'sl': int(b['sl']['value']), 'kana': [], 'works': []})
            if 'kana' in b and b['kana']['value'] not in c['kana']:
                c['kana'].append(b['kana']['value'])
            w = qid(b['work']['value'])
            if w not in c['works']:
                c['works'].append(w)
        print(' ', ct, len(chars), file=sys.stderr)
    out['chars'] = chars
    (cache / 'wikidata.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    return out


def fetch_pages(titles, cache_file):
    done = {}
    if cache_file.exists():
        for line in cache_file.read_text(encoding='utf-8').splitlines():
            rec = json.loads(line)
            done[rec['req']] = rec
    todo = [t for t in titles if t not in done]
    print(f'pages: {len(titles)} (cached {len(titles) - len(todo)})', file=sys.stderr)
    with cache_file.open('a', encoding='utf-8') as fh:
        for i in range(0, len(todo), 40):
            batch = todo[i:i + 40]
            params = {'action': 'query', 'prop': 'revisions', 'rvprop': 'content', 'rvslots': 'main',
                      'format': 'json', 'formatversion': 2, 'redirects': 1, 'maxlag': 5}
            data = urllib.parse.urlencode({**params, 'titles': '|'.join(batch)}).encode()
            res = http_json('https://ja.wikipedia.org/w/api.php', data=data)
            q = res.get('query', {})
            alias = {}
            for n in q.get('normalized', []):
                alias[n['to']] = n['from']
            for r in q.get('redirects', []):
                alias[r['to']] = alias.get(r['from'], r['from'])
            for p in q.get('pages', []):
                req = alias.get(p['title'], p['title'])
                text = ''
                if 'revisions' in p:
                    text = p['revisions'][0]['slots']['main']['content']
                rec = {'req': req, 'title': p['title'], 'missing': 'missing' in p, 'text': text}
                done[req] = rec
                fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
            for t in batch:
                if t not in done:
                    rec = {'req': t, 'title': t, 'missing': True, 'text': ''}
                    done[t] = rec
                    fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
            print(f'  {min(i + 40, len(todo))}/{len(todo)}', file=sys.stderr)
            time.sleep(1.0)
    return done


LIST_LINK = re.compile(r'\[\[([^\]|#]*登場人物[^\]|#]*)(?:[|#][^\]]*)?\]\]|\{\{\s*(?:Main|main|See also|See|Further)\s*\|([^}]*登場人物[^}]*)\}\}')


def main(cache_dir):
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    wd_file = cache / 'wikidata.json'
    wd = json.loads(wd_file.read_text(encoding='utf-8')) if wd_file.exists() else fetch_wikidata(cache)
    works = wd['works']
    # 記事: アニメ作品の記事 + そのアニメの原作の記事（人気順）
    score = {}
    for q, w in works.items():
        if w['art'] and set(w['cls']) & set(ANIME):
            score[w['art']] = max(score.get(w['art'], 0), w['sl'] + 1)
    for a, m in wd['based_on']:
        if a in works and m in works and works[m]['art']:
            score[works[m]['art']] = max(score.get(works[m]['art'], 0), works[a]['sl'] + 1)
    arts = sorted(score, key=lambda t: -score[t])
    pages = fetch_pages(arts, cache / 'pages.jsonl')
    # 「〜の登場人物」記事へのリンクを集める
    lists = []
    seen = set()
    for t in arts:
        text = pages.get(t, {}).get('text', '')
        for m in LIST_LINK.finditer(text):
            for name in (m.group(1), m.group(2)):
                if not name:
                    continue
                for part in name.split('|'):
                    part = part.strip()
                    if '登場人物' in part and '=' not in part and part not in seen and len(part) < 80:
                        seen.add(part)
                        lists.append(part)
    fetch_pages(lists, cache / 'lists.jsonl')
    (cache / 'articles.json').write_text(json.dumps({'arts': arts, 'score': score, 'lists': lists}, ensure_ascii=False), encoding='utf-8')
    print('done', len(arts), 'articles', len(lists), 'list pages', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
