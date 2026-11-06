# アニ漢 — アニメ漢字テスト（iPad / Apple Pencil 対応）

アニメのタイトルやキャラクター名によく使われる漢字を **1万字** 収録した、手書きの漢字書き取りテストアプリです。
iPad の Safari で動く Web アプリ（PWA）なので、インストール不要・ホーム画面に追加すればアプリのように全画面で使えます。

## 主な機能

| 機能 | 内容 |
|---|---|
| 1万字収録 | JIS第1〜第4水準を中心に 10,000字。アニメのタイトル・キャラ名・頻出語（約1,900件の独自コーパス）での出現が多い順に並べています |
| ランク分け | 1000字ごとに **10ランク**（見習い → 駆け出し → 一人前 → 熟練者 → 達人 → 師範 → 賢者 → 大賢者 → 伝説 → 神）。**ランク1〜3はさらに200字ごとの5段階**（例: ランク1-1「見習い・壱」〜1-5「見習い・伍」、各20ステージ）。ランク4以降は1ランク100ステージ × 10字 |
| 90点で次へ | ステージテストは 10問 × 10点。**100点中90点以上で合格**すると次のステージが解放。ランク1〜3は200字（20ステージ）ごと、ランク4以降は1000字（100ステージ）ごとに **昇格試験**（20問 × 5点、90点以上）で次のランクへ。上級者向けに「飛び級試験」や、ランク1〜3を1000字まとめて受ける「まとめて飛び級試験」も可能 |
| 忘却曲線で復習 | 字ごとに記憶の安定度 S を記録し、記憶保持率 `R = 0.9^(経過日数 / S)` が **90%** を下回る頃に復習を出題。正解するたびに間隔が約2.5倍（1日→3日→6日→2週間→1か月…）、間違えると10分後から覚え直し。アプリを開くと復習アラート、アイコンバッジ、カレンダー通知（.ics）で復習を促します |
| Apple Pencil で解答 | 筆圧対応のキャンバスに手書き。ペンを検出すると指・手のひらのタッチを自動で無視（パームリジェクション）。1画戻す／消す／なぞり書き練習 |
| 自動採点 | 手書き文字を認識して正誤判定（認識候補の1位／3位／5位までを選択可）。部品の間が空いて1字が2字に読まれたとき（響 →「郷音」、好 →「女子」など）は、隙間を詰めて縦横比を整えたうえで読み直し。二／ニ、口／ロ のように形が同じカタカナは漢字として判定。誤認識時は「認識ミス（正解にする）」で訂正可能。オフライン時はお手本と見比べる自己採点に自動で切り替え |
| チャレンジモード | メジャーな **アニメタイトル3,000件・キャラクター名7,000件** から出題。名前の中の漢字を **ひと文字ずつ全部** 書き、1字でも違えば不正解。**5回間違えたらゲームオーバー**（ライフ制）。最初は有名作品から、正解が続くほど幅広い作品から出題。ベスト記録を保存。間違えたタイトル・キャラ名は **復習待ちに追加** され、忘却曲線に沿って「名前の復習」として出題 |
| 漢字図鑑 | 1万字を学習状態（未学習・学習中・要復習・定着）で色分け表示。漢字・読み・英語で検索、字ごとの忘却曲線グラフ |
| セーブ | 学習状況は解答のたびに **自動セーブ**（右上の「セーブ」ボタンで確認）。セーブ画面から **セーブスロット**（3つ。ロード・リセット前の状態は自動バックアップに残る）、**ファイル書き出し**（共有メニューから iCloud Drive などへ）／読み込み、**セーブコード**（1行の文字列）のコピー＆貼り付けで、Safari とホーム画面のアプリ間や別の iPad へ引き継ぎ可能。しばらくバックアップしていないとホームでお知らせ |

## iPad で使う

1. このリポジトリを GitHub Pages などの静的ホスティングで公開します（下記）。
2. iPad の Safari で公開 URL を開きます。
3. 共有ボタン →「ホーム画面に追加」。以後はホーム画面のアイコンから全画面で起動できます。
   ホーム画面に追加しておくと、Safari による学習データの自動削除も避けられます。

### GitHub Pages で公開する

1. GitHub のリポジトリ画面で **Settings → Pages** を開きます。
2. **Build and deployment** の Source を「Deploy from a branch」、Branch を公開したいブランチ・`/ (root)` にして Save。
3. 数分後に `https://<ユーザー名>.github.io/ipad/` で開けるようになります。

※ ビルド手順は不要です（静的ファイルのみ）。ローカルで試す場合は `python3 -m http.server` などで配信してください（`file://` では動きません）。

## 手書き認識について

自動採点では、書いた線の座標データを Google の手書き入力（Input Tools）の認識サービスに送信して文字を判定します。
1字が2字に分かれて読まれたときなどは、隙間を詰めた線のデータでもう一度問い合わせます。
通信できないときや、設定で「自己採点」を選んだときは、端末の外にデータを送りません。

## ファイル構成

```
index.html              画面の骨組み
css/style.css           デザイン（ライト／ダーク対応）
js/app.js               画面・テスト進行・ランク解放
js/srs.js               忘却曲線にもとづく復習スケジューラ
js/ink.js               Apple Pencil 手書きキャンバス
js/recognize.js         手書き文字認識・採点
js/store.js             学習データの自動セーブ・読み込み
js/slots.js             セーブスロット（IndexedDB）
js/savedata.js          セーブコードの作成・読み込み
js/data.js              漢字データへのアクセス・ランク／サブランク定義・検索
data/challenge-data.js  チャレンジ用のアニメタイトル・キャラクター名（自動生成・初回のみ読み込み）
data/kanji-data.js      1万字のデータ（自動生成）
tools/anime_corpus.txt  アニメタイトル・キャラクター名・頻出語コーパス
tools/build_data.py     漢字データ生成スクリプト
tools/fetch_challenge_sources.py  チャレンジ用データの取得（Wikidata・Wikipedia）
tools/build_challenge.py          チャレンジ用データの生成
sw.js / manifest.webmanifest / icons/   PWA（オフライン対応・ホーム画面アイコン）
```

## 漢字データの作り方

`data/kanji-data.js` は `tools/build_data.py` で生成しています。

```sh
# EDRDG の辞書データ（KANJIDIC2 / JMdict / JMnedict）を SQLite 化した jamdict-data を取得
curl -LO https://files.pythonhosted.org/packages/97/a5/075928aed2b3b70459fc1db396397dfa6714d266c143c51af9b648551a4e/jamdict_data-1.5.tar.gz
tar xzf jamdict_data-1.5.tar.gz
xz -dk jamdict_data-1.5/jamdict_data/jamdict.db.xz
python3 tools/build_data.py jamdict_data-1.5/jamdict_data/jamdict.db
```

並び順のスコアは、アニメコーパスでの出現数を最も重く、次いで一般語（JMdict）・人名や地名（JMnedict）での使用数、新聞での使用頻度、常用漢字・人名用漢字かどうかを加味しています。
出題には、アニメタイトル／キャラクター名／頻出語 → 一般語 → 人名・地名 の順で例を選び、例がない字は読み・部首・画数・意味から出題します。
コーパス（`tools/anime_corpus.txt`）に作品名やキャラクター名を追加して再生成すれば、出題や並び順に反映されます。

## チャレンジ用データの作り方

```sh
# 1) Wikidata（アニメ作品・キャラクター・知名度）と日本語版 Wikipedia（作品記事・「〜の登場人物」記事）を取得
python3 tools/fetch_challenge_sources.py CACHE_DIR      # query.wikidata.org と ja.wikipedia.org への接続が必要
# 2) 読みの補完に mecab-ipadic-NEologd の seed 辞書を用意
curl -LO https://raw.githubusercontent.com/neologd/mecab-ipadic-neologd/master/seed/mecab-user-dict-seed.20200910.csv.xz
xz -dk mecab-user-dict-seed.20200910.csv.xz
# 3) 生成（jamdict.db は一般名詞をキャラ名から除くのに使用）
python3 tools/build_challenge.py CACHE_DIR mecab-user-dict-seed.20200910.csv jamdict_data-1.5/jamdict_data/jamdict.db
```

- タイトル: Wikidata のアニメ作品（テレビ・映画・OVA・Web）のうち漢字を含むものを、他言語版を含む Wikipedia 記事数（知名度）の順に。読みは Wikipedia 記事冒頭の「'''作品名'''（よみ）」、NEologd、`tools/anime_corpus.txt` から。
- キャラクター: Wikipedia の登場人物一覧の「; 名前（よみ）」見出しと Wikidata のキャラクターから、作品の知名度と登場順で。1作品あたり最大45人。「〜さん」「〜の母」などの呼び名や一般名詞は除外。
- 自動抽出のため、まれに読みや作品の表示が実際と異なる場合があります。

## ライセンス・出典

- 漢字・単語・人名データ: [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project)、[JMdict](https://www.edrdg.org/jmdict/j_jmdict.html)、JMnedict
  © Electronic Dictionary Research and Development Group — [CC BY-SA 4.0](https://www.edrdg.org/edrdg/licence.html)。
  これらから生成した `data/kanji-data.js` も同ライセンスに従います。
- チャレンジ用データ: [Wikidata](https://www.wikidata.org/)（CC0）、[Wikipedia 日本語版](https://ja.wikipedia.org/)の記事見出し（CC BY-SA 4.0）、[mecab-ipadic-NEologd](https://github.com/neologd/mecab-ipadic-neologd)（Apache License 2.0、はてなキーワード等を含む）。
- 作品名・キャラクター名は各権利者に帰属します。本アプリは学習目的で名称を引用しており、各作品とは関係ありません。
