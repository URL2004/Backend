#!/usr/bin/env python
"""copykiller_proxy.joblib -> proxy_model.json (Node/JS 런타임 이식용).

char_wb + word TF-IDF vocab/idf + per-head LogReg coef/intercept를 JSON으로.
JS는 동일 전처리(char_wb pad, word token_pattern)로 재현 → 예측 일치 검증.
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import numpy as np
import joblib


def vec_dump(vec):
    # term -> index, idf[index]
    vocab = {t: int(i) for t, i in vec.vocabulary_.items()}
    idf = vec.idf_.tolist()
    return {"vocab": vocab, "idf": idf, "dim": len(idf)}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", "-m", required=True)
    ap.add_argument("--out", "-o", required=True)
    args = ap.parse_args(argv)
    b = joblib.load(args.model)
    cv, wv = b["char_vec"], b["word_vec"]
    char = vec_dump(cv); word = vec_dump(wv)
    char_dim = char["dim"]
    heads = {}
    for name, clf in b["models"].items():
        coef = clf.coef_[0].tolist()
        heads[name] = {"coef": coef, "intercept": float(clf.intercept_[0])}
    out = {
        "config": {
            "char_ngram": list(cv.ngram_range), "word_ngram": list(wv.ngram_range),
            "lowercase": bool(getattr(cv, "lowercase", True)),
            "char_dim": char_dim, "word_dim": word["dim"],
            "token_pattern": wv.token_pattern,
        },
        "char": char, "word": word, "heads": heads,
        "risk_weights": b.get("risk_weights", {}),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    sz = Path(args.out).stat().st_size
    print(f"exported: {args.out}  ({sz//1024}KB)  char_dim={char_dim} word_dim={word['dim']} heads={len(heads)}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
