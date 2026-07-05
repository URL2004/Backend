#!/usr/bin/env python
import json
import os
import sys
import traceback
from importlib import metadata


def package_version(name):
    try:
        return metadata.version(name)
    except Exception:
        return ""


def try_kss_sentences(text):
    if os.environ.get("LAYOUT_NLP_ENABLE_KSS") != "1":
        return {
            "ok": False,
            "engine": "kss",
            "version": package_version("kss"),
            "sentences": [],
            "error": "skipped_by_policy",
        }
    if len(str(text or "")) > 260:
        return {
            "ok": False,
            "engine": "kss",
            "version": package_version("kss"),
            "sentences": [],
            "error": "skipped_by_length",
        }
    try:
        import kss  # type: ignore
        try:
            sentences = kss.split_sentences(text, num_workers=1)
        except TypeError:
            sentences = kss.split_sentences(text=text)
        return {
            "ok": True,
            "engine": "kss",
            "version": package_version("kss"),
            "sentences": [str(s).strip() for s in sentences if str(s).strip()],
        }
    except Exception as exc:
        return {"ok": False, "engine": "kss", "error": str(exc)}


def try_kiwi(text, want_spacing):
    out = {
        "ok": False,
        "engine": "kiwipiepy",
        "version": package_version("kiwipiepy"),
        "sentences": [],
        "spacedText": "",
        "error": "",
    }
    try:
        from kiwipiepy import Kiwi  # type: ignore
        kiwi = Kiwi()
        out["ok"] = True
        try:
            sents = kiwi.split_into_sents(text)
            out["sentences"] = [str(getattr(s, "text", s)).strip() for s in sents if str(getattr(s, "text", s)).strip()]
        except Exception:
            pass
        if want_spacing and hasattr(kiwi, "space"):
            try:
                out["spacedText"] = str(kiwi.space(text))
            except Exception:
                out["spacedText"] = ""
        return out
    except Exception as exc:
        out["error"] = str(exc)
        return out


def try_pykospacing(text, want_spacing):
    out = {
        "ok": False,
        "engine": "pykospacing",
        "version": package_version("pykospacing"),
        "spacedText": "",
        "error": "",
    }
    if not want_spacing:
        return out
    try:
        from pykospacing import Spacing  # type: ignore
        spacing = Spacing()
        out["spacedText"] = str(spacing(text))
        out["ok"] = True
        return out
    except Exception as exc:
        out["error"] = str(exc)
        return out


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        text = str(payload.get("text") or "")
        want_spacing = bool(payload.get("needsSpacingRepair"))
        max_chars = int(payload.get("maxChars") or 6000)
        work = text[:max_chars]

        kiwi_result = try_kiwi(work, want_spacing)
        kss_result = try_kss_sentences(work)
        pykospacing_result = try_pykospacing(work, want_spacing)

        sentences = []
        sentence_engine = ""
        if kiwi_result.get("ok") and kiwi_result.get("sentences"):
            sentences = kiwi_result.get("sentences") or []
            sentence_engine = "kiwipiepy"
        elif kss_result.get("ok") and kss_result.get("sentences"):
            sentences = kss_result.get("sentences") or []
            sentence_engine = "kss"

        spaced_text = ""
        spacing_engine = ""
        if pykospacing_result.get("ok") and pykospacing_result.get("spacedText"):
            spaced_text = pykospacing_result.get("spacedText") or ""
            spacing_engine = "pykospacing"
        elif kiwi_result.get("ok") and kiwi_result.get("spacedText"):
            spaced_text = kiwi_result.get("spacedText") or ""
            spacing_engine = "kiwipiepy"

        print(json.dumps({
            "ok": True,
            "sentenceEngine": sentence_engine,
            "spacingEngine": spacing_engine,
            "sentences": sentences,
            "spacedText": spaced_text,
            "engines": {
                "kss": kss_result,
                "kiwipiepy": kiwi_result,
                "pykospacing": pykospacing_result,
            },
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "trace": traceback.format_exc()[-1500:],
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
