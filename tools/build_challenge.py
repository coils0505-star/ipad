#!/usr/bin/env python3
"""チャレンジモード用データ（data/challenge-data.js）の生成

入力:
  CACHE_DIR   tools/fetch_challenge_sources.py が保存した Wikidata / Wikipedia のキャッシュ
  NEOLOGD     mecab-ipadic-NEologd の seed 辞書（mecab-user-dict-seed.*.csv）… 読みの補完に使用
  JAMDICT_DB  jamdict-data の SQLite（一般語の除外に使用）

    python3 tools/build_challenge.py CACHE_DIR NEOLOGD_CSV JAMDICT_DB

出題対象:
  アニメタイトル … Wikidata のアニメ作品（テレビ・映画・OVA・Web）のうち漢字を含むもの。
                  Wikipedia 記事の冒頭「'''作品名'''（よみ）」や NEologd から読みを付け、
                  他言語版を含む Wikipedia 記事数（知名度）の順に上位 3,000件。
  キャラクター名 … 日本語版 Wikipedia の「〜の登場人物」記事や作品記事の登場人物節にある
                  「; 名前（よみ）」形式の見出し、Wikidata のアニメ・漫画キャラクターから。
                  作品の知名度と記事内の登場順で並べ、1作品あたり最大 MAX_PER_WORK 人で上位 7,000件。
  どちらも tools/anime_corpus.txt に手で入力した作品名・キャラ名を優先します。
"""
import json
import math
import re
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'challenge-data.js'
CORPUS = ROOT / 'tools' / 'anime_corpus.txt'
N_TITLES = 3000
N_CHARS = 7000
MAX_PER_WORK = 45
ANIME = {'Q63952888', 'Q20650540', 'Q1047299', 'Q220898', 'Q1107', 'Q113671041', 'Q581714', 'Q100269041'}

KANJI_RE = re.compile(r'[㐀-鿿豈-﫿]')
IVS_RE = re.compile('[\U000E0100-\U000E01EF︀-️​-‍⁠]')
KANA_READ_RE = re.compile(r'^[ぁ-ゖァ-ヺー・゙-゜ ・ー〜]+$')


def clean(s):
    s = IVS_RE.sub('', s or '')
    s = unicodedata.normalize('NFC', s)
    return s.strip()


def norm_key(s):
    s = unicodedata.normalize('NFKC', clean(s))
    return re.sub(r'[\s☆★・･!?！？。、,，〜～\-‐―…:：/／「」『』【】()（）\[\]“”"\'’]', '', s)


def kata2hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def nice_reading(text, reading):
    """読みをひらがなにし、表記中のカタカナ部分は読みでもカタカナのまま残す"""
    r = kata2hira(reading).replace('　', ' ').strip()
    r = re.sub(r'\s+', ' ', r)
    for run in re.findall(r'[ァ-ヺー]{2,}', text):
        h = kata2hira(run)
        if h in r:
            r = r.replace(h, run, 1)
    return r


def kanji_count(s):
    return len(KANJI_RE.findall(s))


def ok_text(s, max_len=40, max_kanji=12):
    if not s or len(s) > max_len:
        return False
    if any(ord(c) > 0xFFFF for c in s):
        return False
    k = kanji_count(s)
    return 1 <= k <= max_kanji


def ok_reading(r):
    return bool(r) and not KANJI_RE.search(r) and 1 <= len(r) <= 60


# ---------------------------------------------------------------- 入力
def load_corpus():
    titles, chars = {}, {}
    section, work = None, None
    for line in CORPUS.read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        if line.startswith('['):
            section, work = line.strip('[]'), None
            continue
        if line.startswith('@'):
            section, work = 'chars', line[1:].strip()
            continue
        text, read = line.split('\t')
        if section == 'titles':
            titles[text] = read
        elif section == 'chars':
            chars[(text, work)] = read
    return titles, chars


def load_pages(path):
    pages = {}
    if not path.exists():
        return pages
    for line in path.read_text(encoding='utf-8').splitlines():
        rec = json.loads(line)
        pages[rec['req']] = rec
    return pages


def load_neologd(path, needed):
    out = defaultdict(set)
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            surf = line.split(',', 1)[0]
            if surf in needed:
                cols = line.rstrip('\n').split(',')
                if len(cols) >= 13 and cols[11] != '*':
                    out[surf].add(cols[11])
    return out


def load_common_words(dbpath):
    """一般名詞（店長・先生など）をキャラ名から除くための JMdict 表記→読み"""
    words = defaultdict(set)
    db = sqlite3.connect(dbpath)
    kana = defaultdict(list)
    for idseq, text in db.execute('select idseq, text from Kana'):
        kana[idseq].append(kata2hira(text))
    for idseq, text in db.execute('select idseq, text from Kanji'):
        for r in kana[idseq]:
            words[text].add(r)
    return words


# ---------------------------------------------------------------- Wikipedia 解析
TEMPLATE_KEEP_FIRST = re.compile(r'\{\{\s*(?:Visible anchor|visible anchor|Vanc|vanc|Anchor2)\s*\|([^|}]*)[^}]*\}\}')
TEMPLATE_DROP = re.compile(r'\{\{\s*(?:Anchors?|anchors?|Anchor|efn|Efn|Refnest|refnest|Sfn|sfn|要出典|要検証|lang-[a-z]+|Lang|lang)[^{}]*\}\}')
RUBY = re.compile(r'\{\{\s*[Rr]uby\s*\|([^|}]*)\|([^|}]*)[^}]*\}\}')
LINK2 = re.compile(r'\[\[(?:[^\]|]*\|)?([^\]]*)\]\]')
TAGS = re.compile(r'<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->|<[^>]+>', re.S)


def strip_markup(s):
    s = RUBY.sub(lambda m: f'{m.group(1)}（{m.group(2)}）', s)
    s = TEMPLATE_KEEP_FIRST.sub(r'\1', s)
    for _ in range(3):
        s = TEMPLATE_DROP.sub('', s)
    s = re.sub(r'\{\{[^{}]*\}\}', '', s)
    s = LINK2.sub(r'\1', s)
    s = TAGS.sub('', s)
    s = s.replace("'''", '').replace("''", '')
    return s.strip()


NAME_READ = re.compile(r'^(?P<name>[^（(:：]{1,30}?)\s*[（(](?P<read>[^）)]{1,60})[）)]')
BAD_SUFFIX = ('隊', '団', '軍', '会', '組', '族', '家', '国', '帝国', '王国', '市', '町', '村', '学園', '学院', '高校', '中学', '高等学校',
              '部', '社', '党', '教', '流', '術', '技', '刀', '剣', '号', '艦', '機', '型', '式', '編', '章', '話', '期', '巻', '線', '駅',
              '店', '屋', '館', '寺', '院', '城', '島', '山', '川', '界', '星', '局', '課', '署', '庁', '省', '協会', '連合', '同盟', '一族',
              '三兄弟', '兄弟', '姉妹', '一家', '夫妻', '親子', 'たち', '達', '一行', '御一行', 'メンバー', 'シリーズ')


HONORIFIC = ('さん', 'くん', '君', 'ちゃん', '先生', '様', 'さま', '殿', '氏', '博士', '先輩', '師匠', '社長', '部長', '校長', '理事長', '会長')


RELATION = re.compile(r'の(?:お?ばあ|お?じい|お?母|お?父|お?兄|お?姉|弟|妹|祖|娘|息子|妻|夫|友|先生|上司|部下|ママ|パパ|飼い|ペット|一味|仲間)')


def good_name(text):
    if re.search(r'[0-9０-９A-Za-zＡ-Ｚａ-ｚ「」『』【】〈〉《》=＝、。/／&＆+＋→]', text):
        return False
    if '登場人物' in text or text.endswith(BAD_SUFFIX) or text.endswith(HONORIFIC) or RELATION.search(text):
        return False
    return True


def parse_name_line(term):
    t = strip_markup(term)
    m = NAME_READ.match(t)
    if not m:
        return None
    name = clean(m.group('name'))
    read = m.group('read')
    read = re.split(r'[、,，/／;；]|\s[-–—]\s|声|演|CV', read)[0].strip()
    read = clean(read)
    if not read or not KANA_READ_RE.match(read):
        return None
    text = re.sub(r'[\s　]+', '', name)
    if not ok_text(text, max_len=14, max_kanji=8) or len(text) < 2:
        return None
    if not good_name(text):
        return None
    return text, re.sub(r'\s+', ' ', read)


SEG_SPLIT = re.compile(r'([\s\u3000「」『』【】〈〉《》()（）\[\]〜～\-－―‐:：!！?？・/／,，、。…]+)')
TITLE_PREFIX = (('劇場版', 'げきじょうばん'), ('映画', 'えいが'), ('新', 'しん'), ('続', 'ぞく'))
SECTION = re.compile(r'^(=+)\s*(.*?)\s*\1\s*$')


def extract_characters(text, whole_page):
    """記事本文から（名前, よみ）を登場順に取り出す"""
    out = []
    in_sec = whole_page
    sec_level = 0
    skip_level = 0
    for line in text.splitlines():
        m = SECTION.match(line)
        if m:
            level = len(m.group(1))
            head = m.group(2)
            if whole_page:
                # 「用語」「設定」などの節は飛ばす
                bad = re.search(r'用語|設定|組織|勢力|兵器|武器|メカ|技|能力|アイテム|地名|舞台|作品|書誌|脚注|出典|参考|関連|外部リンク|スタッフ|主題歌|放送|各話|単行本|評価|反響', head)
                if bad and not re.search(r'人物|キャラ', head):
                    skip_level = level
                elif skip_level and level <= skip_level:
                    skip_level = 0
            else:
                if re.search(r'登場人物|キャラクター|主要人物|登場キャラ', head):
                    in_sec, sec_level = True, level
                elif in_sec and level <= sec_level:
                    in_sec = False
            continue
        if not in_sec or skip_level:
            continue
        s = line.strip()
        cand = None
        if s.startswith(';'):
            cand = s.lstrip(';').strip()
        elif s.startswith("'''") or s.startswith("*'''") or s.startswith(": '''"):
            cand = s.lstrip('*: ')
        if not cand:
            continue
        r = parse_name_line(cand)
        if r:
            out.append(r)
    return out


LEAD_BOLD = re.compile(r"'''(?:『)?(.+?)(?:』)?'''』?\s*[（(]([^）)]{1,80})[）)]")


def title_reading_from_lead(text, label):
    """作品記事の冒頭「『'''作品名'''』（よみ）」から読みを取る"""
    body = re.sub(r'\{\{[^{}]*\}\}', '', text)
    body = re.sub(r'\{\{[^{}]*\}\}', '', body)
    head = body[:6000]
    key = norm_key(label)
    for m in LEAD_BOLD.finditer(head):
        bold = strip_markup(m.group(1))
        if norm_key(bold) != key:
            continue
        r = re.split(r'[、,，;；]|英語|英:|英題|略称|通称', m.group(2))[0]
        r = strip_markup(r).strip()
        r = re.sub(r'^[\s:：/／・]+|[\s:：/／・]+$', '', r)
        if r and not KANJI_RE.search(r) and len(r) <= 60:
            return r
    return None


# ---------------------------------------------------------------- メイン
def main(cache_dir, neologd, jamdict_db):
    cache = Path(cache_dir)
    wd = json.loads((cache / 'wikidata.json').read_text(encoding='utf-8'))
    works = wd['works']
    pages = load_pages(cache / 'pages.jsonl')
    lists = load_pages(cache / 'lists.jsonl')
    corpus_titles, corpus_chars = load_corpus()
    common = load_common_words(jamdict_db)

    # 記事 → 作品名（記事名から「 (アニメ)」などを除いたもの）・知名度（アニメ作品の sitelinks）
    def art_display(art):
        return clean(re.sub(r'\s*\([^)]*\)$', '', art.split('#')[0]))

    art_sl = {}
    for q, w in works.items():
        if w.get('art') and set(w['cls']) & ANIME:
            art_sl[w['art']] = max(art_sl.get(w['art'], 0), w['sl'])
    for a, m in wd['based_on']:
        if a in works and m in works and works[m].get('art'):
            art_sl[works[m]['art']] = max(art_sl.get(works[m]['art'], 0), works[a]['sl'])
    art_work = {art: (art_display(art), sl) for art, sl in art_sl.items()}
    known_titles = {norm_key(w['ja']) for w in works.values() if w.get('ja')} | {norm_key(a) for _, (a, _) in art_work.items()}

    # ---------- タイトル候補
    cand_titles = {}
    for q, w in works.items():
        if not (set(w['cls']) & ANIME) or not w.get('ja'):
            continue
        text = re.sub(r'\s*[(（][^)）]*[)）]$', '', clean(w['ja']))
        if not ok_text(text):
            continue
        k = norm_key(text)
        prev = cand_titles.get(k)
        if not prev or w['sl'] > prev['sl']:
            cand_titles[k] = {'text': text, 'sl': w['sl'], 'art': w.get('art')}

    stat = defaultdict(int)
    # ---------- キャラクター候補（Wikipedia）
    list_src = {}
    LIST_LINK = re.compile(r'\[\[([^\]|#]*登場人物[^\]|#]*)')
    for art in sorted(art_work, key=lambda a: -art_work[a][1]):
        text = pages.get(art, {}).get('text', '')
        for m in LIST_LINK.finditer(text):
            list_src.setdefault(m.group(1).strip(), art)
        for m in re.finditer(r'\{\{\s*(?:Main|main|See also|See|Further)\s*\|([^}]*)\}\}', text):
            for part in m.group(1).split('|'):
                if '登場人物' in part:
                    list_src.setdefault(part.strip(), art)
    cand_chars = []  # (text, read, work, score, source)
    for title, rec in lists.items():
        if rec.get('missing') or not rec.get('text'):
            continue
        art = list_src.get(title)
        if not art or art not in art_work:
            continue
        wsl = art_work[art][1]
        # 「名探偵コナンの登場人物」→「名探偵コナン」
        wname = clean(re.sub(r'の登場人物.*$|登場人物.*$', '', title.split('#')[0])) or art_work[art][0]
        wname = re.sub(r'\s*\([^)]*\)$', '', wname)
        if norm_key(wname) != norm_key(art_work[art][0]):
            same = [sl for a, (d, sl) in art_work.items() if norm_key(d) == norm_key(wname)]
            if same:
                wsl = max(same + [wsl])
            elif not norm_key(wname).startswith(norm_key(art_work[art][0])[:4]):
                # アニメ記事からリンクされているだけの別作品（実写ドラマなど）の一覧は使わない
                stat['list_unrelated'] += 1
                continue
        found = extract_characters(rec['text'], True)
        for pos, (text, read) in enumerate(found):
            cand_chars.append((text, read, wname, wsl, pos, len(found)))
    for art, (wname, wsl) in art_work.items():
        rec = pages.get(art)
        if not rec or not rec.get('text'):
            continue
        found = extract_characters(rec['text'], False)
        for pos, (text, read) in enumerate(found):
            cand_chars.append((text, read, wname, wsl, pos, len(found)))
    # Wikidata のキャラクター
    wd_chars = []
    for q, c in wd['chars'].items():
        text = clean(c['ja'])
        text = re.sub(r'[\s　]+', '', text)
        if not ok_text(text, max_len=14, max_kanji=8) or len(text) < 2:
            continue
        best_w = max((works[w] for w in c['works'] if w in works and works[w].get('ja')), key=lambda w: w['sl'], default=None)
        if not best_w:
            continue
        wd_chars.append((text, c['kana'], clean(best_w['ja']), best_w['sl'], c['sl']))

    # ---------- NEologd で読みを補完
    needed = set()
    for t in cand_titles.values():
        needed.update({t['text'], unicodedata.normalize('NFKC', t['text']), norm_key(t['text'])})
        for seg in SEG_SPLIT.split(t['text']):
            if seg and KANJI_RE.search(seg):
                needed.add(seg)
                for pre in TITLE_PREFIX:
                    if seg.startswith(pre[0]):
                        needed.add(seg[len(pre[0]):])
    for text, *_ in wd_chars:
        needed.add(text)
    neo = load_neologd(neologd, needed)

    def neo_read(text):
        for v in (text, unicodedata.normalize('NFKC', text), norm_key(text)):
            if v in neo:
                return sorted(neo[v], key=lambda r: (len(r), r))[0]
        return None

    known_title_read = {}

    def seg_read(seg):
        if seg in known_title_read:
            return known_title_read[seg]
        r = neo_read(seg)
        if r:
            return kata2hira(r)
        rs = common.get(seg)
        if rs and len(rs) == 1:
            return next(iter(rs))
        return None

    def compose_reading(text):
        """「劇場版 〇〇」「〇〇 天国の扉」のように、区切った各部分の読みがすべて分かるときだけ読みを組み立てる"""
        out = []
        for seg in SEG_SPLIT.split(text):
            if not seg or SEG_SPLIT.fullmatch(seg):
                continue
            if not KANJI_RE.search(seg):
                out.append(seg)
                continue
            r = seg_read(seg)
            if not r:
                for pre, pr in TITLE_PREFIX:
                    if seg.startswith(pre) and len(seg) > len(pre):
                        rest = seg_read(seg[len(pre):]) if KANJI_RE.search(seg[len(pre):]) else seg[len(pre):]
                        if rest:
                            r = pr + rest
                        break
            if not r:
                return None
            out.append(r)
        return ' '.join(out) if out else None

    # ---------- タイトル確定
    titles = []
    seen = set()
    for text, read in corpus_titles.items():
        text = clean(text)
        if not ok_text(text) or not ok_reading(read):
            continue
        k = norm_key(text)
        sl = cand_titles.get(k, {}).get('sl', 0)
        titles.append({'text': text, 'read': read, 'score': sl + 25, 'src': 'corpus'})
        seen.add(k)
        known_title_read[text] = read
    for k, t in cand_titles.items():
        if k in seen:
            continue
        read = None
        src = None
        if t['art'] and t['art'] in pages:
            read = title_reading_from_lead(pages[t['art']].get('text', ''), t['text'])
            src = 'wp' if read else None
        if not read:
            read = neo_read(t['text'])
            src = 'neo' if read else None
        if not read or not ok_reading(read):
            continue
        stat['title_' + src] += 1
        titles.append({'text': t['text'], 'read': nice_reading(t['text'], read), 'score': t['sl'], 'src': src})
        known_title_read[t['text']] = kata2hira(read)
        seen.add(k)
    # 2巡目: 読みが分かった作品名などを組み合わせて読みを作る
    for k, t in cand_titles.items():
        if k in seen:
            continue
        read = compose_reading(t['text'])
        if not read or not ok_reading(read):
            stat['title_noread'] += 1
            continue
        stat['title_composed'] += 1
        titles.append({'text': t['text'], 'read': nice_reading(t['text'], read), 'score': t['sl'] - 1, 'src': 'composed'})
        seen.add(k)
    titles.sort(key=lambda t: (-t['score'], t['text']))
    titles = titles[:N_TITLES]

    # ---------- キャラクター確定
    # 同じ名前が複数の記事に出てくるときは、知名度の最も高いスコアを採用し、
    # 表示する作品名は登場人物の多い（＝シリーズ全体の）記事のものにする
    occ = defaultdict(list)
    for text, read, wname, wsl, pos, pagesize in cand_chars:
        occ[text].append({'read': read, 'work': wname, 'score': 10 * math.log1p(wsl) - 0.12 * pos, 'size': pagesize, 'pos': pos, 'src': 'wp'})
    for text, kanas, wname, wsl, csl in wd_chars:
        if not good_name(text):
            continue
        read = None
        for k in kanas:
            k = clean(k)
            if KANA_READ_RE.match(k):
                read = k
                break
        if not read and text not in occ:
            r = neo_read(text)
            read = nice_reading(text, r) if r else None
        if not read:
            if text not in occ:
                stat['char_wd_noread'] += 1
            continue
        occ[text].append({'read': read, 'work': wname, 'score': 10 * math.log1p(wsl) + 2 * math.log1p(csl) - 3, 'size': 0, 'pos': 99, 'src': 'wd'})

    # 表示する作品: 主要人物（記事の前のほう）として載っている記事のうち、登場人物の多い（＝シリーズ全体の）記事
    def pick_display(lst):
        return min(lst, key=lambda o: (o['pos'] > 10, -o['size'], o['pos'], -o['score']))

    by_name = {}
    corpus_pos = defaultdict(int)
    for (text, work), read in corpus_chars.items():
        text = re.sub(r'\s+', '', clean(text))
        if not ok_text(text, max_len=16, max_kanji=10):
            continue
        pos = corpus_pos[work]
        corpus_pos[work] += 1
        others = occ.get(text, [])
        is_title = norm_key(work) in known_titles or norm_key(work) in {norm_key(t) for t in corpus_titles}
        if others:
            score = max(o['score'] for o in others) + 3
            wname = work if is_title else pick_display(others)['work']
        else:
            wsl = cand_titles.get(norm_key(work), {}).get('sl', 25)
            score = 10 * math.log1p(wsl) - 0.12 * pos
            wname = work if is_title else '*' + work
        by_name[text] = {'text': text, 'read': read, 'work': wname, 'score': score, 'src': 'corpus'}
    for text, lst in occ.items():
        if text in by_name:
            continue
        disp = pick_display(lst)
        read = disp['read']
        if not ok_reading(read):
            continue
        if text in common and kata2hira(read).replace(' ', '') in common[text]:
            stat['char_common_word'] += 1
            continue
        by_name[text] = {'text': text, 'read': read, 'work': disp['work'], 'score': max(o['score'] for o in lst), 'src': disp['src']}

    chars_all = sorted(by_name.values(), key=lambda c: (-c['score'], c['text']))
    per_work = defaultdict(int)
    chars = []
    for c in chars_all:
        if per_work[c['work']] >= MAX_PER_WORK:
            continue
        per_work[c['work']] += 1
        chars.append(c)
        if len(chars) >= N_CHARS:
            break

    work_names = []
    widx = {}
    for c in chars:
        w = c['work']
        if w not in widx:
            widx[w] = len(work_names)
            work_names.append(w)
    payload = {
        'version': 1,
        'works': work_names,
        'titles': [[t['text'], t['read']] for t in titles],
        'chars': [[c['text'], c['read'], widx[c['work']]] for c in chars],
    }
    OUT.write_text('/* 自動生成ファイル: tools/build_challenge.py\n'
                   ' * 作品名・キャラクター名: Wikidata (CC0) / Wikipedia 日本語版の記事見出し（読み）/ mecab-ipadic-NEologd (Apache-2.0)\n'
                   ' * 作品名・キャラクター名の権利は各権利者に帰属します。 */\n'
                   'window.CHALLENGE_DATA=' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    src_t = defaultdict(int)
    for t in titles:
        src_t[t['src']] += 1
    src_c = defaultdict(int)
    for c in chars:
        src_c[c['src']] += 1
    print('titles', len(titles), dict(src_t), file=sys.stderr)
    print('chars', len(chars), dict(src_c), 'works', len(work_names), 'candidates', len(chars_all), file=sys.stderr)
    print('stat', dict(stat), file=sys.stderr)
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    main(*sys.argv[1:4])
