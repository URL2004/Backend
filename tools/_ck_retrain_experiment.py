#!/usr/bin/env python
"""비파괴 검증: doc-level AI%-정렬 모델이 현 프록시(r=0.30)를 이기는가.
   같은 피처(char_wb 2-5 + word 1-2 TFIDF). pair 단위 GroupKFold(orig/hum 누수 차단).
   타깃 ①회귀 ai_rate ②이진 AI-high(>=50). OOF 상관/AUC 보고."""
import json, numpy as np
from pathlib import Path
from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import Ridge, LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score

ROOT = Path("C:/Users/dbvision10/Documents/당근대학생")
ck = json.loads((ROOT / "copykiller_results.json").read_text(encoding="utf-8"))
tx = json.loads((ROOT / "오늘-원문-휴머나이징-2026-06-19.json").read_text(encoding="utf-8"))
bynum = {int(r["번호"]): r for r in tx}

texts, y, groups, side = [], [], [], []
for r in ck:
    t = bynum.get(r["pair"])
    if not t:
        continue
    if r.get("orig") is not None:
        texts.append(t["원문"] or ""); y.append(r["orig"]); groups.append(r["pair"]); side.append("orig")
    if r.get("human") is not None:
        texts.append(t["휴머나이징된글"] or ""); y.append(r["human"]); groups.append(r["pair"]); side.append("hum")
y = np.array(y, float); groups = np.array(groups)
print(f"docs: {len(texts)}  (pairs: {len(set(groups))})  ai% mean {y.mean():.1f}")

def feats(train_texts, test_texts):
    cv = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, max_features=20000)
    wv = TfidfVectorizer(analyzer="word", ngram_range=(1, 2), min_df=2, max_features=20000)
    Xc = cv.fit_transform(train_texts); Xw = wv.fit_transform(train_texts)
    Xtr = hstack([Xc, Xw]).tocsr()
    Xte = hstack([cv.transform(test_texts), wv.transform(test_texts)]).tocsr()
    return Xtr, Xte

def pearson(a, b):
    a = np.asarray(a, float); b = np.asarray(b, float)
    if a.std() == 0 or b.std() == 0:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])

gkf = GroupKFold(n_splits=5)
oof_reg = np.zeros(len(texts)); oof_clf = np.zeros(len(texts))
yhigh = (y >= 50).astype(int)
for tr, te in gkf.split(texts, y, groups):
    Xtr, Xte = feats([texts[i] for i in tr], [texts[i] for i in te])
    # regression (Ridge, strong reg)
    rg = Ridge(alpha=5.0); rg.fit(Xtr, y[tr]); oof_reg[te] = rg.predict(Xte)
    # binary high (LogReg)
    if len(set(yhigh[tr])) == 2:
        lr = LogisticRegression(C=1.0, class_weight="balanced", max_iter=2000)
        lr.fit(Xtr, yhigh[tr]); oof_clf[te] = lr.predict_proba(Xte)[:, 1]

print("\n=== 신모델(doc-level, OOF=honest) ===")
print(f"  회귀 OOF  Pearson(pred, ai%)  r = {pearson(oof_reg, y):.3f}")
print(f"  이진 OOF  Pearson(prob, ai%)  r = {pearson(oof_clf, y):.3f}")
try:
    print(f"  이진 OOF  AUC(AI>=50)            = {roc_auc_score(yhigh, oof_clf):.3f}")
except Exception as e:
    print("  AUC err", e)
print("  (현 프록시 composite_risk vs 실제 = r=0.30 / 입력 r=0.15 기준)")

# 가장 중요: 신모델이 '악화(사람글->AI)'를 잡나? orig vs hum OOF로 delta 예측
pair_pred = {}
for i, g in enumerate(groups):
    pair_pred.setdefault(g, {})[side[i]] = (oof_reg[i], y[i])
pdpd, ckck = [], []
caught = tot = 0
for g, d in pair_pred.items():
    if "orig" in d and "hum" in d:
        pdelta = d["hum"][0] - d["orig"][0]; ckdelta = d["hum"][1] - d["orig"][1]
        pdpd.append(pdelta); ckck.append(ckdelta)
        if ckdelta > 10:
            tot += 1
            if pdelta > 0:
                caught += 1
print(f"\n  신모델 ΔOOF vs 실제Δ  r = {pearson(pdpd, ckck):.3f}  (현 프록시Δ r=0.40)")
print(f"  악화(ckΔ>10) {tot}건 중 신모델도 악화예측: {caught} ({100*caught/max(1,tot):.0f}%)  (현 프록시 23%)")
