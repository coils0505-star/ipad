#!/usr/bin/env python3
"""認識ミスの記録コード（設定 →「認識ミスの記録」→「記録をコピー」）を読み、中身を表示する。

  python3 tools/replay_misreads.py CODE_FILE            # 記録の一覧
  python3 tools/replay_misreads.py CODE_FILE --query    # 同じ線で認識サービスにもう一度問い合わせる
  python3 tools/replay_misreads.py CODE_FILE --json OUT # 記録を JSON で保存（テスト用）
"""
import base64, gzip, json, sys, urllib.request

API = 'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8'


def decode(text):
    code = ''.join(text.split())
    prefix, _, body = code.partition('-')
    if not prefix.startswith('ANIKANINK'):
        raise SystemExit('ANIKANINK で始まるコードではありません')
    data = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4))
    if prefix.endswith('1'):
        data = gzip.decompress(data)
    return json.loads(data)


def query(ink, w, h, lang='ja'):
    body = {'requests': [{'writing_guide': {'writing_area_width': w, 'writing_area_height': h},
                          'ink': ink, 'language': lang, 'max_num_results': 10, 'max_completions': 0}]}
    req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    out = json.loads(urllib.request.urlopen(req, timeout=20).read())
    return out[1][0][1] if out[0] == 'SUCCESS' else None


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    obj = decode(open(sys.argv[1], encoding='utf-8').read())
    recs = obj.get('records', [])
    print('端末:', obj.get('ua', '?'))
    for i, r in enumerate(recs):
        ink = r['ink']
        pts = sum(len(s[0]) for s in ink)
        print(f"#{i + 1} {r['target']}  {r.get('mode')} {r.get('name', '')}  {len(ink)}画 {pts}点  枠{r['w']}x{r['h']}  pen={r.get('pen')}")
        print('   認識:', r.get('raw'), '| 読み直し:', r.get('raw2'))
        if '--query' in sys.argv:
            print('   再問い合わせ:', (query(ink, r['w'], r['h']) or [])[:6])
    if '--json' in sys.argv:
        out = sys.argv[sys.argv.index('--json') + 1]
        json.dump(recs, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
        print('保存:', out)


if __name__ == '__main__':
    main()
