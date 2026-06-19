#!/usr/bin/env python
"""신 ai%-정렬 모델 학습 + JSON export (라이브 태그 프록시와 별개 artifact).
   타깃=AI작성률>=50 이진(LogReg). 피처=char_wb 2-5 + word 1-2 TFIDF(기존 프록시와 동일 전처리).
   export 포맷은 export_proxy.py와 동일 → copykiller-proxy.js가 그대로 읽음.
"""
from __future__ import annotations
import json, numpy as np
from pathlib import Path
from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score

ROOT = Path("C:/Users/dbvision10/Documents/당근대학생")
OUT = Path(__file__).resolve().parent.parent / "engine" / "copykiller_airate_model.json"

ck = json.loads((ROOT / "copykiller_results.json").read_text(encoding="utf-8"))
tx = json.loads((ROOT / "오늘-원문-휴머나이징-2026-06-19.json").read_text(encoding="utf-8"))
bynum = {int(r["번호"]): r for r in tx}

texts, y, groups = [], [], []
for r in ck:
    t = bynum.get(r["pair"])
    if not t:
        continue
    if r.get("orig") is not None:
        texts.append(t["원문"] or ""); y.append(r["orig"]); groups.append(r["pair"])
    if r.get("human") is not None:
        texts.append(t["휴머나이징된글"] or ""); y.append(r["human"]); groups.append(r["pair"])
y = np.array(y, float); groups = np.array(groups)
yhigh = (y >= 50).astype(int)
print(f"docs {len(texts)} pairs {len(set(groups))}  AI>=50: {int(yhigh.sum())}/{len(yhigh)}")

cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, max_features=20000)
wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, max_features=15000)
Xc = cv.fit_transform(texts); Xw = wv.fit_transform(texts)
X = hstack([Xc, Xw]).tocsr()

# honest CV AUC (기록용)
gkf = GroupKFold(n_splits=5); oof = np.zeros(len(texts))
for tr, te in gkf.split(texts, yhigh, groups):
    m = LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000)
    m.fit(X[tr], yhigh[tr]); oof[te] = m.predict_proba(X[te])[:, 1]
cv_auc = roc_auc_score(yhigh, oof)
print(f"CV(group) AUC = {cv_auc:.3f}")

# 최종 모델 = 전체 데이터
clf = LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000)
clf.fit(X, yhigh)

def vec_dump(vec):
    return {"vocab": {t: int(i) for t, i in vec.vocabulary_.items()}, "idf": vec.idf_.tolist(), "dim": len(vec.idf_)}

char = vec_dump(cv); word = vec_dump(wv)
out = {
    "config": {"char_ngram": list(cv.ngram_range), "word_ngram": list(wv.ngram_range),
               "lowercase": True, "char_dim": char["dim"], "word_dim": word["dim"],
               "token_pattern": wv.token_pattern},
    "char": char, "word": word,
    "heads": {"airate": {"coef": clf.coef_[0].tolist(), "intercept": float(clf.intercept_[0])}},
    "meta": {"kind": "binary_ai>=50", "target": "AI작성률>=50", "n": len(texts),
             "cv_group_auc": round(float(cv_auc), 3), "trained": "2026-06-19", "source": "264 CK PDF labels"},
}
OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print(f"exported {OUT}  ({OUT.stat().st_size//1024}KB)  char_dim={char['dim']} word_dim={word['dim']}")
# sanity: print a few predicted probs
import scipy
def prob(i):
    z = clf.intercept_[0] + X[i].dot(clf.coef_[0])
    return 1/(1+np.exp(-z))
print("sample probs (first 3):", [round(float(prob(i)),3) for i in range(3)], "labels:", yhigh[:3].tolist())
