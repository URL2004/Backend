#!/usr/bin/env python
"""CopyKiller tag/severity learnability baseline.

segments.json -> TF-IDF(char n-gram) + numeric features -> per-target 5-fold ROC-AUC.
Tells us which CopyKiller tags are learnable from text (for the engine reranker).
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from scipy.sparse import hstack, csr_matrix
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, GroupKFold, cross_val_score

NUM_RE = re.compile(r"[0-9]")
SPOKEN_RE = re.compile(r"(?:거든요|예요|에요|아요|어요|죠[.,\s]|네요|더라고|잖아)")
HEDGE_RE = re.compile(r"(?:수\s*있다|필요(?:가|성)|중요하다|의미를?\s*가|가능성|볼\s*수\s*있|것이다|로\s*이해|라는\s*점)")


def per1k(text: str, rex) -> float:
    body = re.sub(r"\s", "", text)
    return len(rex.findall(text)) / max(1, len(body)) * 1000.0


def numeric_feats(text: str) -> list[float]:
    body = re.sub(r"\s", "", text)
    sents = [s for s in re.split(r"(?<=[.!?。])\s+", text) if s.strip()]
    lens = [len(re.sub(r"\s", "", s)) for s in sents] or [0]
    mean = sum(lens) / len(lens)
    cv = (np.std(lens) / mean) if mean else 0.0
    return [
        per1k(text, NUM_RE),
        per1k(text, SPOKEN_RE),
        per1k(text, HEDGE_RE),
        len(body),
        float(cv),
    ]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--segments", "-s", required=True)
    ap.add_argument("--min-pos", type=int, default=25)
    ap.add_argument("--exclude", default=None, help="pdf_file에 이 문자열 포함시 제외")
    ap.add_argument("--dedup", action="store_true", help="동일 텍스트 세그먼트 중복 제거")
    args = ap.parse_args(argv)

    segs = json.loads(Path(args.segments).read_text(encoding="utf-8"))
    if args.exclude:
        before = len(segs)
        segs = [s for s in segs if args.exclude not in (s.get("pdf_file") or "")]
        print(f"exclude '{args.exclude}': {before} -> {len(segs)}")
    if args.dedup:
        seen, out = set(), []
        for s in segs:
            key = re.sub(r"\s+", "", s["text"])
            if key in seen:
                continue
            seen.add(key)
            out.append(s)
        print(f"dedup exact text: {len(segs)} -> {len(out)}")
        segs = out
    texts = [s["text"] for s in segs]
    n = len(texts)
    print(f"segments: {n}")

    # features: char-wb tfidf + word tfidf + numeric
    char_vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=3, max_features=20000)
    word_vec = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=3, max_features=20000)
    Xc = char_vec.fit_transform(texts)
    Xw = word_vec.fit_transform(texts)
    Xn = csr_matrix(np.array([numeric_feats(t) for t in texts], dtype=float))
    # standardize numeric
    Xn_arr = Xn.toarray()
    Xn_arr = (Xn_arr - Xn_arr.mean(0)) / (Xn_arr.std(0) + 1e-9)
    X = hstack([Xc, Xw, csr_matrix(Xn_arr)]).tocsr()
    print(f"feature dim: {X.shape[1]} (char+word tfidf + 5 numeric)")

    # targets: each tag (one-vs-rest) + severity
    all_tags = sorted({t for s in segs for t in s["tags"]})
    targets: list[tuple[str, np.ndarray]] = []
    for tag in all_tags:
        y = np.array([1 if tag in s["tags"] else 0 for s in segs])
        if y.sum() >= args.min_pos and (n - y.sum()) >= args.min_pos:
            targets.append((f"tag:{tag}", y))
    sev = np.array([1 if s["severity"] == "중간" else 0 for s in segs])
    if sev.sum() >= args.min_pos and (n - sev.sum()) >= args.min_pos:
        targets.append(("severity:중간vs낮음", sev))

    # ★ GroupKFold by doc_id: 같은 문서(원문+휴머) 세그먼트가 train/test에 섞이는 누수 방지(정직한 AUC)
    groups = np.array([s.get("doc_id", s.get("pdf_id")) for s in segs])
    n_groups = len(set(groups))
    cv = GroupKFold(n_splits=min(5, n_groups))
    print(f"\nGroupKFold by doc_id (groups={n_groups}) — 누수 차단")
    print(f"\n{'target':<34} {'pos':>4} {'ROC-AUC(5cv)':>14}")
    print("-" * 56)
    rows = []
    for name, y in targets:
        clf = LogisticRegression(class_weight="balanced", max_iter=2000, C=1.0)
        try:
            auc = cross_val_score(clf, X, y, cv=cv, groups=groups, scoring="roc_auc").mean()
        except Exception as exc:  # pragma: no cover
            auc = float("nan")
            print(f"{name:<34} err {exc}")
            continue
        rows.append((name, int(y.sum()), auc))
        flag = "  <- 유용(>0.75)" if auc > 0.75 else ("  ~경계" if auc > 0.68 else "")
        print(f"{name:<34} {int(y.sum()):>4} {auc:>14.3f}{flag}")

    print("\n해석: AUC>0.75 = 엔진 재랭커에 쓸 만함 / 0.68~0.75 = 보조 / <0.68 = 텍스트표면으론 학습 어려움(카피킬러 의미판단)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
