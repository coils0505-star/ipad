#!/usr/bin/env python3
"""漢字データ生成スクリプト

アニメタイトル・キャラクター名コーパス (tools/anime_corpus.txt) と
EDRDG の KANJIDIC2 / JMdict / JMnedict（jamdict-data パッケージ同梱の SQLite）から、
アプリが読み込む data/kanji-data.js を生成します。

使い方:
    pip download jamdict-data==1.5 --no-deps   # または PyPI から tar.gz を取得
    tar xzf jamdict_data-1.5.tar.gz && xz -d jamdict_data-1.5/jamdict_data/jamdict.db.xz
    python3 tools/build_data.py path/to/jamdict.db

並び順（ランク）は「アニメでの使われやすさ」スコアの降順です:
    アニメコーパス出現数 > 一般語での使用頻度 > 人名・固有名詞での使用頻度
    > 新聞頻度・常用/人名用漢字 の重み付き合計。
上位から1000字ごとにランク1〜10、10字ごとにステージ（各ランク100ステージ）。
"""
import hashlib
import json
import math
import re
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "tools" / "anime_corpus.txt"
OUT = ROOT / "data" / "kanji-data.js"

TOTAL = 10000
PER_RANK = 1000
PER_STAGE = 10

RANK_NAMES = [
    "見習い", "駆け出し", "一人前", "熟練者", "達人",
    "師範", "賢者", "大賢者", "伝説", "神",
]


def is_kanji(ch):
    o = ord(ch)
    return (0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or
            0xF900 <= o <= 0xFAFF or 0x20000 <= o <= 0x3FFFF or ch == "々")


def kata2hira(s):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def load_corpus():
    entries = []  # (text, reading, kind, src)
    section = None
    work = None
    for line in CORPUS.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            work = None
            continue
        if line.startswith("@"):
            section = "chars"
            work = line[1:].strip()
            continue
        text, reading = line.split("\t")
        kind = {"titles": "t", "vocab": "v", "chars": "c"}[section]
        entries.append((text, reading, kind, work if kind == "c" else None))
    return entries


def jis_key(v):
    p = v.split("-")
    return tuple(int(x) for x in p)


def main(dbpath):
    db = sqlite3.connect(dbpath)

    # ---------------- KANJIDIC2 ----------------
    chars = {}
    for cid, lit, strokes, grade, freq in db.execute(
            "select ID, literal, stroke_count, grade, freq from character"):
        chars[cid] = dict(k=lit, s=strokes or 0, g=int(grade) if grade else 0,
                          f=int(freq) if freq else 0, on=[], kun=[], nan=[],
                          m=[], rad=0, jis=None, var=[])
    jis_lookup = {}
    for cid, t, v in db.execute("select cid, cp_type, value from codepoint"):
        if t in ("jis208", "jis212", "jis213"):
            jis_lookup[(t, jis_key(v))] = cid
            if t == "jis208":
                chars[cid]["jis"] = "208"
            elif t == "jis213" and chars[cid]["jis"] != "208":
                chars[cid]["jis"] = "213"
            elif t == "jis212" and not chars[cid]["jis"]:
                chars[cid]["jis"] = "212"
    for cid, t, v in db.execute("select cid, var_type, value from variant"):
        if t in ("jis208", "jis212", "jis213"):
            chars[cid]["var"].append((t, jis_key(v)))
    for cid, t, v in db.execute("select cid, rad_type, value from radical"):
        if t == "classical":
            chars[cid]["rad"] = int(v)
    for cid, t, v in db.execute(
            "select g.cid, r.r_type, r.value from reading r join rm_group g on r.gid = g.ID"):
        if t == "ja_on" and v not in chars[cid]["on"]:
            chars[cid]["on"].append(v)
        elif t == "ja_kun" and v not in chars[cid]["kun"]:
            chars[cid]["kun"].append(v)
    for cid, v in db.execute("select cid, value from meaning m join rm_group g on m.gid = g.ID "
                             "where m.m_lang = '' or m.m_lang is null or m.m_lang = 'en'"):
        chars[cid]["m"].append(v)
    for cid, v in db.execute("select cid, value from nanori"):
        chars[cid]["nan"].append(v)

    by_lit = {c["k"]: c for c in chars.values()}

    # ---------------- corpus ----------------
    corpus = load_corpus()
    anime_cnt = Counter()
    for text, _, kind, _ in corpus:
        for ch in set(text):
            if ch in by_lit:
                anime_cnt[ch] += 1.0 if kind != "v" else 0.8

    # ---------------- JMdict ----------------
    kanji_forms = {}  # kid -> (idseq, text)
    for kid, idseq, text in db.execute("select ID, idseq, text from Kanji"):
        kanji_forms[kid] = (idseq, text)
    pri = defaultdict(set)
    for kid, t in db.execute("select kid, text from KJP"):
        pri[kid].add(t)
    kinfo = defaultdict(set)
    for kid, t in db.execute("select kid, text from KJI"):
        kinfo[kid].add(t)
    kana = defaultdict(list)  # idseq -> [(kana_id, text, nokanji)]
    for kaid, idseq, text, nok in db.execute("select ID, idseq, text, nokanji from Kana"):
        kana[idseq].append((kaid, text, nok))
    knr = defaultdict(set)
    for kaid, t in db.execute("select kid, text from KNR"):
        knr[kaid].add(t)
    kana_info = defaultdict(set)
    for kaid, t in db.execute("select kid, text from KNI"):
        kana_info[kaid].add(t)

    def word_priority(kid):
        p = pri.get(kid, set())
        score = 0
        if p & {"news1", "ichi1", "spec1", "gai1"}:
            score += 100
        elif p & {"spec2", "news2", "ichi2", "gai2"}:
            score += 60
        for t in p:
            if t.startswith("nf"):
                score += (49 - int(t[2:])) * 0.8
        return score

    jm_common = Counter()
    jm_all = Counter()
    words_by_char = defaultdict(list)  # ch -> [(prio, text, reading)]
    bad_info = {"word containing irregular kanji usage", "word containing irregular kana usage"}
    for kid, (idseq, text) in kanji_forms.items():
        if len(text) > 6:
            continue
        info = kinfo.get(kid, set())
        if info & bad_info:
            continue
        reading = None
        for kaid, ktext, nok in kana[idseq]:
            if nok:
                continue
            if knr.get(kaid) and text not in knr[kaid]:
                continue
            if "out-dated or obsolete kana usage" in kana_info.get(kaid, ()):
                continue
            reading = ktext
            break
        if not reading:
            continue
        prio = word_priority(kid)
        outdated = "word containing out-dated kanji" in info
        uniq = set(ch for ch in text if is_kanji(ch) and ch != "々")
        for ch in uniq:
            if ch not in by_lit:
                continue
            jm_all[ch] += 1
            if prio >= 60:
                jm_common[ch] += 1
            words_by_char[ch].append((prio - (40 if outdated else 0), text, reading))

    # ---------------- JMnedict ----------------
    ne_cnt = Counter()
    ne_types = defaultdict(set)
    for idseq, t in db.execute(
            "select t.idseq, a.text from NETranslation t join NETransType a on a.tid = t.ID"):
        ne_types[idseq].add(t)
    person_types = {"surname", "given", "fem", "masc", "person", "unclass"}
    ne_kana = {}
    for idseq, text in db.execute("select idseq, text from NEKana"):
        ne_kana.setdefault(idseq, text)
    names_by_char = defaultdict(list)
    ne_any_by_char = defaultdict(list)
    for idseq, text in db.execute("select idseq, text from NEKanji"):
        types = ne_types.get(idseq, set())
        uniq = set(ch for ch in text if is_kanji(ch) and ch != "々")
        isperson = bool(types & person_types)
        for ch in uniq:
            if ch not in by_lit:
                continue
            ne_cnt[ch] += 1 if isperson else 0.5
            r = ne_kana.get(idseq)
            if not r:
                continue
            if isperson and 2 <= len(text) <= 3 and all(is_kanji(c) for c in text):
                names_by_char[ch].append((text, kata2hira(r), types))
            elif 2 <= len(text) <= 5 and len(ne_any_by_char[ch]) < 40:
                ne_any_by_char[ch].append((text, kata2hira(r), types))

    # ---------------- candidate selection & scoring ----------------
    cand = []
    for c in by_lit.values():
        ch = c["k"]
        if ord(ch) > 0xFFFF:
            continue
        if unicodedata.normalize("NFC", ch) != ch:
            continue
        if not (c["on"] or c["kun"]):
            continue
        if not c["jis"]:
            continue
        a = anime_cnt[ch]
        score = (3.2 * math.log1p(a) + 1.0 * math.log1p(jm_common[ch]) +
                 0.35 * math.log1p(jm_all[ch]) + 0.45 * math.log1p(ne_cnt[ch]))
        if c["f"]:
            score += 2.5 * (1 - c["f"] / 2501)
        if c["g"] in (1, 2, 3, 4, 5, 6, 8):
            score += 1.2
        elif c["g"] == 9:
            score += 1.0
        elif c["g"] == 10:
            score += 0.3
        if c["jis"] == "212":
            score -= 0.6
        c["score"] = score
        cand.append(c)
    # 同点の字は部首が固まらないようハッシュ順で混ぜる
    cand.sort(key=lambda c: (-round(c["score"], 6), hashlib.md5(c["k"].encode()).hexdigest()))
    print("candidates:", len(cand), file=sys.stderr)
    selected = cand[:TOTAL]
    index = {c["k"]: i for i, c in enumerate(selected)}

    def difficulty_of(text, target):
        """例文中の他の漢字の難しさ（小さいほど易しい）"""
        worst = 0
        for ch in text:
            if ch == target or not is_kanji(ch) or ch == "々":
                continue
            worst = max(worst, index.get(ch, TOTAL + 2000))
        return worst

    # ---------------- readings helpers ----------------
    def reading_set(c):
        rs = set()
        for r in c["on"]:
            h = kata2hira(r).replace("-", "")
            rs.add(h)
            # 促音化（例: がく→がっ）
            if len(h) >= 2 and h[-1] in "くつちき":
                rs.add(h[:-1] + "っ")
        for r in c["kun"]:
            stem = r.replace("-", "").split(".")[0]
            rs.add(stem)
        for r in c["nan"]:
            rs.add(r)
        rs.discard("")
        return rs

    def rendaku(s):
        table = str.maketrans("かきくけこさしすせそたちつてとはひふへほ",
                              "がぎぐげござじずぜぞだぢづでどばびぶべぼ")
        out = {s, s.translate(table)[:1] + s[1:]}
        hb = str.maketrans("はひふへほ", "ぱぴぷぺぽ")
        out.add(s[:1].translate(hb) + s[1:])
        return out

    def aligned(text, reading, cs):
        """2〜3字の名前が各字の既知の読みで分解できるか"""
        def rec(i, pos):
            if i == len(text):
                return pos == len(reading)
            c = by_lit.get(text[i])
            if not c:
                return False
            for r in cs[text[i]]:
                for rr in (rendaku(r) if i > 0 else {r}):
                    if reading.startswith(rr, pos) and rec(i + 1, pos + len(rr)):
                        return True
            return False
        return rec(0, 0)

    rs_cache = {}

    def rs_of(ch):
        if ch not in rs_cache:
            rs_cache[ch] = reading_set(by_lit[ch]) if ch in by_lit else set()
        return rs_cache[ch]

    class RS(dict):
        def __missing__(self, k):
            v = rs_of(k)
            self[k] = v
            return v

    rsmap = RS()

    # ---------------- example selection ----------------
    corpus_by_char = defaultdict(list)
    for text, reading, kind, src in corpus:
        for ch in set(text):
            corpus_by_char[ch].append((text, reading, kind, src))

    works = []
    work_idx = {}

    def wid(name):
        if name not in work_idx:
            work_idx[name] = len(works)
            works.append(name)
        return work_idx[name]

    stats = Counter()
    out_entries = []
    for i, c in enumerate(selected):
        ch = c["k"]
        ex = []
        seen = set()
        # 1) アニメコーパス
        ac = corpus_by_char.get(ch, [])
        kind_order = {"t": 0, "c": 1, "v": 2}
        ac_sorted = sorted(ac, key=lambda e: (difficulty_of(e[0], ch) > i + 3000,
                                              len(e[0]) > 12, kind_order[e[2]], len(e[0])))
        used_kinds = Counter()
        for text, reading, kind, src in ac_sorted:
            if len(ex) >= 3:
                break
            if used_kinds[kind] >= 2:
                continue
            if text in seen:
                continue
            seen.add(text)
            used_kinds[kind] += 1
            item = [text, reading, kind]
            if src:
                item.append(wid(src))
            ex.append(item)
        if ex:
            stats["anime"] += 1
        # 2) JMdict 一般語
        words = words_by_char.get(ch, [])
        words = sorted(words, key=lambda w: (
            -(w[0] >= 60),
            difficulty_of(w[1], ch) > max(i + 1500, 3000),
            -w[0], abs(len(w[1]) - 2), difficulty_of(w[1], ch)))
        n_words = 0
        want_words = 2 if ex else 3
        for prio, text, reading in words:
            if n_words >= want_words:
                break
            if text in seen:
                continue
            seen.add(text)
            ex.append([text, reading, "w"])
            n_words += 1
        if n_words:
            stats["word"] += 1
        # 3) 人名（読みが規則的に分解できるもの）
        if len(ex) < 2:
            names = names_by_char.get(ch, [])
            good = [n for n in names if aligned(n[0], n[1], rsmap)]
            good.sort(key=lambda n: (difficulty_of(n[0], ch), len(n[0])))
            for text, reading, types in good[: 2 - len(ex)]:
                if text in seen:
                    continue
                seen.add(text)
                ex.append([text, reading, "n"])
                stats["name"] += 1
        # 4) それでも無ければ地名・人名など固有名詞（読みの分解は問わない）
        if not ex:
            pool = names_by_char.get(ch, []) + ne_any_by_char.get(ch, [])
            pool = sorted(pool, key=lambda n: (difficulty_of(n[0], ch), len(n[0])))
            for text, reading, types in pool:
                if len(ex) >= 2:
                    break
                if text in seen:
                    continue
                seen.add(text)
                label = "p" if types & {"place", "station"} else "n"
                ex.append([text, reading, label])
            if ex:
                stats["ne_fallback"] += 1
        if not ex:
            stats["noexample"] += 1

        # 異体字
        variants = []
        for t, key in c["var"]:
            vcid = jis_lookup.get((t, key))
            if vcid is None:
                continue
            vlit = chars[vcid]["k"]
            if vlit != ch and vlit in index and vlit not in variants:
                variants.append(vlit)

        rad_char = unicodedata.normalize("NFKC", chr(0x2F00 + c["rad"] - 1)) if c["rad"] else ""
        meanings = [m for m in c["m"] if "radical" not in m.lower()][:3] or c["m"][:2]
        entry = {
            "k": ch,
            "s": c["s"],
            "b": rad_char,
            "on": c["on"][:6],
            "kun": c["kun"][:8],
            "m": "; ".join(meanings)[:80],
            "ex": ex,
        }
        if c["nan"]:
            entry["n"] = c["nan"][:5]
        if variants:
            entry["v"] = "".join(variants[:3])
        if c["g"]:
            entry["g"] = c["g"]
        out_entries.append(entry)

    print("stats:", dict(stats), file=sys.stderr)
    payload = {
        "version": 1,
        "perRank": PER_RANK,
        "perStage": PER_STAGE,
        "rankNames": RANK_NAMES,
        "works": works,
        "kanji": out_entries,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    js = ("/* 自動生成ファイル: tools/build_data.py\n"
          " * 漢字データ: KANJIDIC2 / JMdict / JMnedict (C) EDRDG, CC BY-SA 4.0\n"
          " * https://www.edrdg.org/edrdg/licence.html */\n"
          "window.KANJI_DATA=" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
    OUT.write_text(js, encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)", file=sys.stderr)

    # 確認用に各ランク先頭の字を表示
    for r in range(TOTAL // PER_RANK):
        seg = "".join(e["k"] for e in out_entries[r * PER_RANK:r * PER_RANK + 60])
        print(f"rank{r+1}: {seg}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
