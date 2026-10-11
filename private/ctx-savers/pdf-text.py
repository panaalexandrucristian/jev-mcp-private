#!/usr/bin/env python3
"""pdf-text: the text of a PDF, compact, with the images flagged instead of embedded.

usage: pdf-text.py FILE.pdf [--pages 1,3-4]

Prints one block per page: normalised text (runs of blanks collapsed, empty lines dropped), then a one-line note for every page that
holds images. Needs pypdf or PyMuPDF (fitz); without either it exits with 3 and says so. Exit 2: unreadable file or bad arguments.
"""
import re
import sys


def parse_pages(spec, count):
    wanted = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            wanted.update(range(int(a), int(b) + 1))
        else:
            wanted.add(int(part))
    return [p for p in sorted(wanted) if 1 <= p <= count]


def normalise(text):
    text = text.replace(" ", " ")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def read_with_pypdf(path):
    from pypdf import PdfReader

    reader = PdfReader(path)
    pages = []
    for page in reader.pages:
        try:
            images = len(list(page.images))
        except Exception:
            images = 0
        pages.append((page.extract_text() or "", images))
    return pages


def read_with_fitz(path):
    import fitz

    document = fitz.open(path)
    return [(page.get_text(), len(page.get_images())) for page in document]


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 2
    path = argv[0]
    spec = None
    if "--pages" in argv:
        spec = argv[argv.index("--pages") + 1] if argv.index("--pages") + 1 < len(argv) else None
        if spec is None:
            print("--pages needs a value such as 1,3-4", file=sys.stderr)
            return 2
    pages = None
    last_error = None
    for reader in (read_with_pypdf, read_with_fitz):
        try:
            pages = reader(path)
            break
        except ImportError as error:
            last_error = error
        except Exception as error:  # unreadable or not a PDF
            print(f"cannot read {path}: {error}", file=sys.stderr)
            return 2
    if pages is None:
        print(f"pdf-text needs pypdf or PyMuPDF (pip install pypdf): {last_error}", file=sys.stderr)
        return 3
    chosen = parse_pages(spec, len(pages)) if spec else list(range(1, len(pages) + 1))
    texts = {n: normalise(pages[n - 1][0]) for n in chosen}
    total = sum(len(t) for t in texts.values())
    images = sum(pages[n - 1][1] for n in chosen)
    print(f"# {path.split('/')[-1]}: {len(pages)} pages, {total} text chars, {images} images")
    for n in chosen:
        text, count = texts[n], pages[n - 1][1]
        print(f"## page {n} ({len(text)} chars, {count} image{'s' if count != 1 else ''})")
        print(text if text else "(no text on this page: scanned or image only)")
        if count:
            print(f"[page {n} holds {count} image{'s' if count != 1 else ''}, not shown here: Read the PDF with pages={n} to see {'them' if count != 1 else 'it'}]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
