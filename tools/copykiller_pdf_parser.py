#!/usr/bin/env python
"""
Parse CopyKiller AI detailed-result PDFs into segment-level labels.

Outputs:
  - segments.json: one record per suspicious segment
  - docs.csv: one record per PDF
  - paired.csv: one record per original/humanized document pair
  - qa_report.md: parser QA summary
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "PyMuPDF is required. Install with: python -m pip install pymupdf"
    ) from exc


SEVERITIES = {"높음", "중간", "낮음"}

TAGS = [
    "추상적, 일반적 내용 구성",
    "구체적 근거 부족",
    "주관성의 지나친 배제",
    "무견해, 판단 회피적 성향",
    "간접 화법, 비인칭 서술",
    "기계적 정확성 및 균일성",
    "지나친 요약 및 압축 서술",
    "짜여진 흐름, 구조적 전형성",
    "과도하게 경직된 문어체",
    "복잡한 문장 및 서술 구조",
    "동일 내용의 과도한 반복",
    "문장 및 문단 구조의 반복",
]


@dataclass
class OpenSegment:
    severity: str
    page_no: int
    y0: float
    text_lines: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def compact_text(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def norm_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def int_or_none(value: str | None) -> int | None:
    if not value:
        return None
    digits = re.sub(r"\D", "", value)
    return int(digits) if digits else None


def extract_pdf_id(path: Path, header_text: str = "") -> int | None:
    m = re.search(r"-\s*(\d+)\.pdf$", path.name, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"검사번호\s*([0-9]{8,})", header_text)
    if m:
        return int(m.group(1).lstrip("0") or "0")
    return None


def extract_doc_name(header_text: str) -> str | None:
    m = re.search(r"문서명\s+(.+?\.docx?)", header_text, re.S | re.I)
    if not m:
        return None
    return norm_space(m.group(1))


def split_doc_id_version(doc_name: str | None, pdf_file: str) -> tuple[str, str]:
    source = doc_name or pdf_file
    base = re.sub(r"\.docx?$", "", source, flags=re.I)

    suffix_patterns = [
        ("휴머나이징결과", "휴머나이징"),
        ("휴머나이징", "휴머나이징"),
        ("휴머나", "휴머나이징"),
        ("원문", "원문"),
    ]

    for suffix, version in suffix_patterns:
        marker = f"_{suffix}"
        if marker in base:
            return base.rsplit(marker, 1)[0], version

    if "휴머" in pdf_file:
        return base, "휴머나이징"
    if "원문" in pdf_file:
        return base, "원문"
    return base, "미상"


def parse_doc_header(path: Path, doc: fitz.Document) -> dict[str, Any]:
    header_text = doc[0].get_text()
    warnings: list[str] = []

    ai_match = re.search(r"AI작성률\s*([0-9]{1,3})\s*%", header_text, re.S)
    ai_rate = int(ai_match.group(1)) if ai_match else None
    if ai_rate is None:
        warnings.append("missing ai_rate")

    total = suspect = high = mid = low = None
    info_match = re.search(r"분석\s*정보(.*?)(?:본 결과확인서는|Copyrights|$)", header_text, re.S)
    if info_match:
        tokens = re.findall(r"[0-9]{1,3}\s*%|\d+", info_match.group(1))
        values = [int_or_none(token) for token in tokens[:6]]
        if len(values) >= 6 and all(value is not None for value in values[:6]):
            if ai_rate is None:
                ai_rate = values[0]
            total, suspect, high, mid, low = values[1:6]
        else:
            warnings.append("analysis_info_numbers_incomplete")
    else:
        warnings.append("missing analysis_info")

    doc_name = extract_doc_name(header_text)
    if not doc_name:
        warnings.append("missing doc_name")

    doc_id, version = split_doc_id_version(doc_name, path.name)

    return {
        "pdf_id": extract_pdf_id(path, header_text),
        "pdf_file": path.name,
        "doc_name": doc_name,
        "doc_id": doc_id,
        "version": version,
        "ai_rate": ai_rate,
        "total_areas": total,
        "suspect_areas": suspect,
        "high": high,
        "mid": mid,
        "low": low,
        "pages": doc.page_count,
        "parse_warnings": warnings,
    }


def page_lines(page: fitz.Page) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if norm_space(span.get("text", ""))]
            if not spans:
                continue
            spans.sort(key=lambda span: (span["bbox"][1], span["bbox"][0]))
            text = norm_space(" ".join(span.get("text", "") for span in spans))
            if not text:
                continue
            x0 = min(span["bbox"][0] for span in spans)
            y0 = min(span["bbox"][1] for span in spans)
            x1 = max(span["bbox"][2] for span in spans)
            y1 = max(span["bbox"][3] for span in spans)
            rows.append({"text": text, "x0": x0, "y0": y0, "x1": x1, "y1": y1})
    rows.sort(key=lambda row: (row["y0"], row["x0"]))
    return rows


def is_footer_or_watermark(line: dict[str, Any], page: fitz.Page) -> bool:
    text = line["text"]
    compact = compact_text(text)
    if line["y0"] > page.rect.height - 95:
        if (
            "본결과확인서는" in compact
            or "Copyrights" in text
            or "MUHAYU" in text
            or re.fullmatch(r"\d+/\d+", text)
        ):
            return True
    if re.fullmatch(r"\d+/\d+", text):
        return True
    if compact in {"CopyKiller", "CopyKillerCAMPUS", "CAMPUS"}:
        return True
    return False


def is_severity_line(line: dict[str, Any], page: fitz.Page) -> bool:
    text = norm_space(line["text"])
    return text in SEVERITIES and line["x0"] < page.rect.width * 0.12


def extract_tags(blob: str) -> list[str]:
    compact_blob = compact_text(blob)
    found = []
    for tag in TAGS:
        if compact_text(tag) in compact_blob:
            found.append(tag)
    return found


def clean_segment_text(lines: list[str]) -> str:
    text = norm_space(" ".join(lines))
    if not text:
        return ""

    text = re.sub(r"Copy\s*K\s*iller", " ", text, flags=re.I)
    text = re.sub(r"\bCAMPUS\b", " ", text, flags=re.I)
    text = text.replace("AI 의심 결과", " ")
    text = text.replace("AI생성 특징", " ")
    for tag in TAGS:
        text = text.replace(tag, " ")

    text = re.sub(
        r"^\s*\d{1,3}[._]\s*.{0,140}?-\s*(?:원문|휴머나이징(?:결과)?)\s*이전\s*문제\s*[:：]\s*",
        "",
        text,
    )
    if re.search(r"^\s*\d{1,3}[._].{0,260}?(?:분량\s*\d+%|신규엔티티\s*\d+|모드\s*\S+)", text):
        text = re.sub(
            r"^\s*\d{1,3}[._].{0,260}?모드\s*[^\s,.;:：·-]+\s*[·,.;:：-]*\s*",
            "",
            text,
        )

    return norm_space(text)


def finalize_segment(
    doc_row: dict[str, Any],
    segment: OpenSegment,
    seg_idx: int,
) -> dict[str, Any]:
    text = clean_segment_text(segment.text_lines)
    warnings = list(segment.warnings)
    if not text:
        warnings.append("empty_segment_text")
    if not segment.tags:
        warnings.append("missing_tags")

    return {
        "pdf_id": doc_row["pdf_id"],
        "pdf_file": doc_row["pdf_file"],
        "doc_id": doc_row["doc_id"],
        "version": doc_row["version"],
        "doc_ai_rate": doc_row["ai_rate"],
        "seg_idx": seg_idx,
        "severity": segment.severity,
        "tags": segment.tags,
        "text": text,
        "char_len": len(text),
        "parse_warning": "; ".join(warnings) if warnings else None,
    }


def parse_segments(path: Path, doc: fitz.Document, doc_row: dict[str, Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    open_segment: OpenSegment | None = None

    for page_index in range(1, doc.page_count):
        page = doc[page_index]
        for line in page_lines(page):
            text = line["text"]
            if is_footer_or_watermark(line, page):
                continue
            if text == "AI 의심 결과":
                continue

            if is_severity_line(line, page):
                if open_segment is not None:
                    open_segment.warnings.append(
                        f"new_severity_before_feature page={page_index + 1}"
                    )
                    segments.append(finalize_segment(doc_row, open_segment, len(segments)))
                open_segment = OpenSegment(
                    severity=text,
                    page_no=page_index + 1,
                    y0=float(line["y0"]),
                )
                continue

            if "AI생성 특징" in text:
                if open_segment is None:
                    doc_row["parse_warnings"].append(
                        f"orphan_feature_anchor page={page_index + 1} y={line['y0']:.1f}"
                    )
                    continue
                open_segment.tags = extract_tags(text)
                segments.append(finalize_segment(doc_row, open_segment, len(segments)))
                open_segment = None
                continue

            if open_segment is not None and line["x0"] > page.rect.width * 0.12:
                open_segment.text_lines.append(text)

    if open_segment is not None:
        open_segment.warnings.append("unterminated_segment_no_feature_anchor")
        segments.append(finalize_segment(doc_row, open_segment, len(segments)))

    return segments


def validate_doc(doc_row: dict[str, Any], segments: list[dict[str, Any]]) -> None:
    warnings = doc_row["parse_warnings"]

    suspect = doc_row.get("suspect_areas")
    if suspect is not None and len(segments) != suspect:
        warnings.append(f"segment_count_mismatch expected={suspect} actual={len(segments)}")

    expected_counts = {
        "높음": doc_row.get("high"),
        "중간": doc_row.get("mid"),
        "낮음": doc_row.get("low"),
    }
    actual_counts = Counter(seg["severity"] for seg in segments)
    for severity, expected in expected_counts.items():
        if expected is not None and actual_counts.get(severity, 0) != expected:
            warnings.append(
                f"severity_count_mismatch {severity} expected={expected} actual={actual_counts.get(severity, 0)}"
            )

    valid_tags = set(TAGS)
    for seg in segments:
        bad_tags = [tag for tag in seg["tags"] if tag not in valid_tags]
        if bad_tags:
            seg["parse_warning"] = norm_space(
                f"{seg.get('parse_warning') or ''}; unknown_tags={bad_tags}"
            ).strip("; ")


def parse_pdf(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    with fitz.open(path) as doc:
        doc_row = parse_doc_header(path, doc)
        segments = parse_segments(path, doc, doc_row)
        validate_doc(doc_row, segments)
        doc_row["seg_count"] = len(segments)
    return doc_row, segments


def sort_key_doc_id(doc_id: str) -> tuple[int, str]:
    m = re.match(r"(\d+)", doc_id or "")
    return (int(m.group(1)) if m else 999999, doc_id or "")


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def build_doc_csv_rows(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for doc in docs:
        rows.append(
            {
                "pdf_id": doc.get("pdf_id"),
                "pdf_file": doc.get("pdf_file"),
                "doc_id": doc.get("doc_id"),
                "version": doc.get("version"),
                "ai_rate": doc.get("ai_rate"),
                "total_areas": doc.get("total_areas"),
                "suspect_areas": doc.get("suspect_areas"),
                "high": doc.get("high"),
                "mid": doc.get("mid"),
                "low": doc.get("low"),
                "pages": doc.get("pages"),
                "seg_count": doc.get("seg_count"),
                "parse_warning": "; ".join(doc.get("parse_warnings") or []),
            }
        )
    rows.sort(key=lambda row: (sort_key_doc_id(row["doc_id"]), row["version"], row["pdf_id"] or 0))
    return rows


def build_paired_rows(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for doc in docs:
        version = doc.get("version")
        if version in {"원문", "휴머나이징"}:
            grouped[doc["doc_id"]][version] = doc

    rows = []
    for doc_id, versions in grouped.items():
        orig = versions.get("원문")
        hum = versions.get("휴머나이징")
        orig_rate = orig.get("ai_rate") if orig else None
        hum_rate = hum.get("ai_rate") if hum else None
        delta = hum_rate - orig_rate if orig_rate is not None and hum_rate is not None else None
        warnings = []
        if orig is None:
            warnings.append("missing_original")
        if hum is None:
            warnings.append("missing_humanized")
        rows.append(
            {
                "doc_id": doc_id,
                "orig_rate": orig_rate,
                "hum_rate": hum_rate,
                "delta": delta,
                "orig_seg_count": orig.get("seg_count") if orig else None,
                "hum_seg_count": hum.get("seg_count") if hum else None,
                "orig_pdf_id": orig.get("pdf_id") if orig else None,
                "hum_pdf_id": hum.get("pdf_id") if hum else None,
                "parse_warning": "; ".join(warnings),
            }
        )
    rows.sort(key=lambda row: sort_key_doc_id(row["doc_id"]))
    return rows


def write_qa_report(path: Path, docs: list[dict[str, Any]], segments: list[dict[str, Any]]) -> None:
    warning_docs = [doc for doc in docs if doc.get("parse_warnings")]
    warning_segments = [seg for seg in segments if seg.get("parse_warning")]
    severity_counts = Counter(seg["severity"] for seg in segments)
    tag_counts = Counter(tag for seg in segments for tag in seg["tags"])

    lines = [
        "# CopyKiller PDF Parser QA",
        "",
        f"- PDFs: {len(docs)}",
        f"- Segments: {len(segments)}",
        f"- Warning PDFs: {len(warning_docs)}",
        f"- Warning segments: {len(warning_segments)}",
        "",
        "## Severity Counts",
        "",
    ]
    for severity in ["높음", "중간", "낮음"]:
        lines.append(f"- {severity}: {severity_counts.get(severity, 0)}")

    lines.extend(["", "## Tag Counts", ""])
    for tag, count in tag_counts.most_common():
        lines.append(f"- {tag}: {count}")

    if warning_docs:
        lines.extend(["", "## PDF Warnings", ""])
        for doc in warning_docs[:30]:
            lines.append(
                f"- {doc.get('pdf_file')}: {'; '.join(doc.get('parse_warnings') or [])}"
            )
        if len(warning_docs) > 30:
            lines.append(f"- ... {len(warning_docs) - 30} more")

    if warning_segments:
        lines.extend(["", "## Segment Warnings", ""])
        for seg in warning_segments[:30]:
            lines.append(
                f"- {seg.get('pdf_file')} seg={seg.get('seg_idx')}: {seg.get('parse_warning')}"
            )
        if len(warning_segments) > 30:
            lines.append(f"- ... {len(warning_segments) - 30} more")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Parse CopyKiller AI detailed-result PDFs.")
    parser.add_argument(
        "--input",
        "-i",
        required=True,
        help="Folder containing CopyKiller PDF files.",
    )
    parser.add_argument(
        "--output",
        "-o",
        required=True,
        help="Output folder for segments.json, docs.csv, paired.csv.",
    )
    parser.add_argument(
        "--glob",
        default="*.pdf",
        help="PDF glob pattern. Default: *.pdf",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    input_dir = Path(args.input)
    output_dir = Path(args.output)

    if not input_dir.exists():
        print(f"Input folder not found: {input_dir}", file=sys.stderr)
        return 2

    pdfs = sorted(input_dir.glob(args.glob))
    if not pdfs:
        print(f"No PDFs matched {args.glob} in {input_dir}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    docs: list[dict[str, Any]] = []
    all_segments: list[dict[str, Any]] = []
    for pdf in pdfs:
        doc_row, segments = parse_pdf(pdf)
        docs.append(doc_row)
        all_segments.extend(segments)

    doc_rows = build_doc_csv_rows(docs)
    paired_rows = build_paired_rows(docs)

    (output_dir / "segments.json").write_text(
        json.dumps(all_segments, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_csv(
        output_dir / "docs.csv",
        doc_rows,
        [
            "pdf_id",
            "pdf_file",
            "doc_id",
            "version",
            "ai_rate",
            "total_areas",
            "suspect_areas",
            "high",
            "mid",
            "low",
            "pages",
            "seg_count",
            "parse_warning",
        ],
    )
    write_csv(
        output_dir / "paired.csv",
        paired_rows,
        [
            "doc_id",
            "orig_rate",
            "hum_rate",
            "delta",
            "orig_seg_count",
            "hum_seg_count",
            "orig_pdf_id",
            "hum_pdf_id",
            "parse_warning",
        ],
    )
    write_qa_report(output_dir / "qa_report.md", docs, all_segments)

    warning_docs = sum(1 for doc in docs if doc.get("parse_warnings"))
    warning_segments = sum(1 for seg in all_segments if seg.get("parse_warning"))
    print(f"PDFs: {len(docs)}")
    print(f"Segments: {len(all_segments)}")
    print(f"Paired rows: {len(paired_rows)}")
    print(f"Warning PDFs: {warning_docs}")
    print(f"Warning segments: {warning_segments}")
    print(f"Output: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
