#!/usr/bin/env python
"""CopyKiller-risk proxy: train / save / predict.

train:   segments.json -> char+word TF-IDF + per-tag LogReg + severity -> model.joblib
predict: model.joblib + text(s) -> per-tag prob + composite risk (재랭커용)

핵심 태그(데이터 다수·점수 주범)만 composite risk에 반영. group-CV로 검증된 견고 태그 위주.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.sparse import hstack, csr_matrix
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
import joblib

# group-CV AUC 기준 가중치(견고할수록↑, 약한 태그 0). C13 실측 반영.
RISK_WEIGHTS = {
    "구체적 근거 부족": 0.85,
    "주관성의 지나친 배제": 0.83,
    "무견해, 판단 회피적 성향": 0.78,
    "추상적, 일반적 내용 구성": 0.75,
    "간접 화법, 비인칭 서술": 0.72,
    # 기계적 균일성·요약압축은 group-CV에서 약(<0.68) → 제외
}


def build_feats(texts, char_vec=None, word_vec=None, fit=False):
    if fit:
        char_vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=3, max_features=20000)
        word_vec = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=3, max_features=20000)
        Xc = char_vec.fit_transform(texts)
        Xw = word_vec.fit_transform(texts)
    else:
        Xc = char_vec.transform(texts)
        Xw = word_vec.transform(texts)
    return hstack([Xc, Xw]).tocsr(), char_vec, word_vec


def train(args):
    segs = json.loads(Path(args.segments).read_text(encoding="utf-8"))
    texts = [s["text"] for s in segs]
    X, char_vec, word_vec = build_feats(texts, fit=True)
    print(f"segments: {len(texts)}  feat dim: {X.shape[1]}")

    tags = sorted({t for s in segs for t in s["tags"]})
    models = {}
    for tag in tags:
        y = np.array([1 if tag in s["tags"] else 0 for s in segs])
        if y.sum() < args.min_pos or (len(y) - y.sum()) < args.min_pos:
            continue
        clf = LogisticRegression(class_weight="balanced", max_iter=2000)
        clf.fit(X, y)
        models[f"tag:{tag}"] = clf
    sev = np.array([1 if s["severity"] == "중간" else 0 for s in segs])
    clf = LogisticRegression(class_weight="balanced", max_iter=2000)
    clf.fit(X, sev)
    models["severity:중간"] = clf

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"char_vec": char_vec, "word_vec": word_vec, "models": models,
                 "risk_weights": RISK_WEIGHTS}, out)
    print(f"saved: {out}  ({len(models)} heads)")


def _score_texts(bundle, texts):
    X, _, _ = build_feats(texts, bundle["char_vec"], bundle["word_vec"], fit=False)
    out = []
    for i in range(len(texts)):
        row = {}
        for name, clf in bundle["models"].items():
            row[name] = float(clf.predict_proba(X[i])[0, 1])
        rw = bundle["risk_weights"]
        num = sum(rw[t] * row.get(f"tag:{t}", 0.0) for t in rw)
        den = sum(rw.values())
        row["composite_risk"] = round(num / den, 3)
        out.append(row)
    return out


def predict(args):
    bundle = joblib.load(args.model)
    if args.text:
        texts = [args.text]
    elif args.json:
        data = json.loads(Path(args.json).read_text(encoding="utf-8"))
        texts = [data] if isinstance(data, str) else [d["text"] if isinstance(d, dict) else d for d in data]
    else:
        texts = [sys.stdin.read()]
    res = _score_texts(bundle, texts)
    for i, r in enumerate(res):
        top = sorted(((k, v) for k, v in r.items() if k.startswith("tag:")), key=lambda x: -x[1])[:3]
        print(f"[{i}] composite_risk={r['composite_risk']:.3f} severity중간={r.get('severity:중간',0):.2f}")
        for k, v in top:
            print(f"      {k}: {v:.2f}")


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train"); t.add_argument("--segments", "-s", required=True); t.add_argument("--out", "-o", default="models/copykiller_proxy.joblib"); t.add_argument("--min-pos", type=int, default=25); t.set_defaults(func=train)
    p = sub.add_parser("predict"); p.add_argument("--model", "-m", default="models/copykiller_proxy.joblib"); p.add_argument("--text", "-t"); p.add_argument("--json", "-j"); p.set_defaults(func=predict)
    args = ap.parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
