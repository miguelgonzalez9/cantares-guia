#!/usr/bin/env python3
"""
12_build_doc_catalog.py — Sistema de Información Cantares (SIC), capa de documentos.

Centraliza, categoriza y hace BUSCABLES los documentos de la reserva (censos e
inventarios de especies, trabajo ambiental, normativo, administrativo, cartografía,
interpretación). Dos funciones:

  1. AUTO-ARCHIVA: cualquier archivo que dejes en `info/_inbox/` se mueve a su
     carpeta de categoría según su nombre (censos_inventarios/, ambiental/, …).
  2. INDEXA: escanea todos los documentos (en `info/` + los PDFs de `inputs/`),
     extrae un resumen de texto (markitdown), y escribe:
        info/catalog.json  — índice para máquina / búsqueda
        info/INDEX.md      — catálogo navegable por un humano

No mueve archivos que estén ABIERTOS (lock de Office `~$…`) ni los PDFs de
`inputs/` (los usan otros scripts): esos se indexan en su sitio.

Uso:  python data_prep/12_build_doc_catalog.py [--no-preview]
Requiere: markitdown (para el resumen de texto; opcional).
"""

import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # …/Cantares
INFO = ROOT / "info"                                 # hub de documentos
# Los documentos ahora viven centralizados en info/. `inputs/documentos` se mantiene
# solo por si queda algún archivo suelto pendiente de mover (indexar en sitio).
EXTRA_SCAN = [
    ROOT / "inmersive_app" / "inputs" / "documentos",
]
# En el hub `info/` indexamos documentos + imágenes de marca (logos).
IMG_EXT = {".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"}
DOC_EXT = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".csv", ".txt", ".md"} | IMG_EXT
# Fuera del hub `info/` solo indexamos documentos "de verdad" (no READMEs ni imágenes de la app).
EXTRA_DOC_EXT = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"}
PREVIEW_MAX_MB = 15          # no extraer texto de archivos enormes (lento)
PREVIEW_CHARS = 500
NO_PREVIEW = "--no-preview" in sys.argv

# --- Privacidad ---
# Archivos sensibles: se mueven a info/_privado/ y NUNCA se leen ni se indexan.
PRIVATE_DIR = "_privado"
SENSITIVE_NAMES = ["ps_ac"]        # subcadena del nombre (sin importar mayúsculas)
# Carpetas internas que el indexador ignora por completo.
SKIP_DIRS = {"_inbox", PRIVATE_DIR, "_procesados"}
GENERATED = {"INDEX.md", "catalog.json"}


def is_sensitive(path: Path) -> bool:
    n = path.name.lower()
    return any(s in n for s in SENSITIVE_NAMES)

# Categoría → palabras clave (en nombre de archivo o carpeta). Orden = prioridad.
CATEGORIES = {
    "censos_inventarios": ["inventario", "inventaro", "censo", "especies", "tangara", "flora", "fauna",
                            "ave", "mamifero", "anfibio", "biodiversidad", "monitoreo", "checklist",
                            "arbol", "árbol", "arbusto", "ficha", "registrad", "album", "álbum",
                            "listado", "planta"],
    "ambiental":          ["restauracion", "ndvi", "carbono", "ambiental", "ecolog", "bosque",
                            "reforest", "hidr", "suelo", "clima", "vegetacion"],
    "normativo":          ["resolucion", "ley", "decreto", "rnsc", "registro", "parques",
                            "plan_de_manejo", "plan de manejo", "permiso", "acuerdo", "juridico", "legal"],
    "cartografia":        ["mapa", "carto", "ortofoto", "sendero", "camino", "geo", "predial",
                            "zonific", "limite", "shape", "raster"],
    "interpretacion":     ["guion", "interpretativo", "guia", "educ", "letrero", "senaletica"],
    "identidad_visual":   ["logo", "logotipo", "isotipo", "marca", "identidad", "imagen corporativa",
                            "brand", "afiche", "poster"],
    "administrativo":     ["administ", "presupuesto", "contab", "factura", "cuenta",
                            "nomina", "pago", "ingreso", "gasto", "balance", "financ"],
}
DEFAULT_CAT = "otros"
ALL_CATS = list(CATEGORIES) + [DEFAULT_CAT]

CAT_LABEL = {
    "censos_inventarios": "🦋 Censos e inventarios de especies",
    "ambiental": "🌿 Trabajo ambiental y restauración",
    "normativo": "⚖️ Normativo y jurídico",
    "cartografia": "🗺️ Cartografía y mapas",
    "interpretacion": "📖 Interpretación y educación",
    "identidad_visual": "🎨 Identidad visual (logos, marca)",
    "administrativo": "💼 Administrativo y financiero",
    "otros": "📁 Otros",
}


def categorize(path: Path) -> str:
    hay = (path.name + " " + " ".join(p.name for p in path.parents)).lower()
    for cat, kws in CATEGORIES.items():
        if any(k in hay for k in kws):
            return cat
    return DEFAULT_CAT


def is_open_lock(path: Path) -> bool:
    return path.name.startswith("~$")


def ensure_folders():
    INFO.mkdir(exist_ok=True)
    (INFO / "_inbox").mkdir(exist_ok=True)
    (INFO / PRIVATE_DIR).mkdir(exist_ok=True)
    for c in ALL_CATS:
        (INFO / c).mkdir(exist_ok=True)


def _move_into(item: Path, dest_dir: Path):
    """Mueve archivo o carpeta a dest_dir, evitando colisiones. Ignora si está en uso."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / item.name
    n = 1
    while dest.exists():
        dest = dest_dir / (f"{item.stem}_{n}{item.suffix}" if item.is_file() else f"{item.name}_{n}")
        n += 1
    try:
        shutil.move(str(item), str(dest))
        return True
    except (OSError, shutil.Error):
        return False   # p. ej. abierto en Excel — se reintenta la próxima corrida


def autofile():
    """Archiva lo suelto en info/_inbox/ Y en la raíz de info/ hacia su categoría.
    - Sensibles (ps_ac…) → info/_privado/ y NUNCA se leen.
    - Carpetas (p. ej. 'Logo Cantares') → se mueven enteras a su categoría.
    Devuelve (movidos_a_categoria, movidos_a_privado, pendientes_en_uso)."""
    moved, to_private, busy = [], [], []

    def process(item: Path):
        if item.name.startswith(".") or is_open_lock(item) or item.name in GENERATED:
            return
        if item.is_dir() and item.name in SKIP_DIRS | set(ALL_CATS):
            return
        if is_sensitive(item):
            if _move_into(item, INFO / PRIVATE_DIR):
                to_private.append(item.name)
            else:
                busy.append(item.name)
            return
        cat = categorize(item)
        if _move_into(item, INFO / cat):
            moved.append((item.name, cat))
        else:
            busy.append(item.name)

    # 1) todo lo que esté en _inbox (archivos y carpetas de primer nivel)
    inbox = INFO / "_inbox"
    for item in sorted(inbox.iterdir()) if inbox.exists() else []:
        process(item)
    # 2) sueltos directamente en la raíz de info/ (no las carpetas de categoría)
    for item in sorted(INFO.iterdir()):
        if item.name in SKIP_DIRS or item.name in ALL_CATS:
            continue
        process(item)
    return moved, to_private, busy


def preview_text(path: Path) -> str:
    if NO_PREVIEW or path.suffix.lower() in {".txt", ".md", ".csv"}:
        try:
            return " ".join(path.read_text(encoding="utf-8", errors="ignore").split())[:PREVIEW_CHARS]
        except Exception:
            return ""
    if path.stat().st_size > PREVIEW_MAX_MB * 1024 * 1024:
        return ""
    try:
        out = subprocess.run(["markitdown", str(path)], capture_output=True, text=True,
                             timeout=90, encoding="utf-8", errors="ignore")
        return " ".join((out.stdout or "").split())[:PREVIEW_CHARS]
    except Exception:
        return ""


def scan(prev_cache=None):
    """Indexa info/ (por categoría) + EXTRA_SCAN (en su sitio).
    prev_cache: {path: (mtime, preview)} del catálogo anterior → evita re-extraer
    texto de archivos que no cambiaron (markitdown es lento en PDFs grandes)."""
    prev_cache = prev_cache or {}
    records = []
    seen = set()

    def add(path: Path, category: str):
        rp = path.resolve()
        # Privacidad: nunca indexar (ni leer) archivos sensibles ni la carpeta privada.
        if is_sensitive(path) or PRIVATE_DIR in {p.name for p in path.parents}:
            return
        if path.name in GENERATED:          # no auto-indexar INDEX.md/catalog.json
            return
        if rp in seen or is_open_lock(path) or path.suffix.lower() not in DOC_EXT:
            return
        seen.add(rp)
        is_img = path.suffix.lower() in IMG_EXT
        st = path.stat()
        rel = str(path.relative_to(ROOT)).replace("\\", "/")
        # Reusa la vista previa cacheada si el archivo no cambió (mtime igual).
        cached = prev_cache.get(rel)
        if is_img:
            preview = ""
        elif cached and cached[0] == int(st.st_mtime):
            preview = cached[1]
        else:
            preview = preview_text(path)
        records.append({
            "title": path.stem,
            "file": path.name,
            "category": category,
            "type": path.suffix.lower().lstrip("."),
            "size_kb": round(st.st_size / 1024),
            "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).date().isoformat(),
            "_mtime": int(st.st_mtime),
            "path": rel,
            "preview": preview,
        })

    # info/<categoria>/…  (la carpeta define la categoría)
    for c in ALL_CATS:
        d = INFO / c
        if d.exists():
            for f in sorted(d.rglob("*")):
                if f.is_file():
                    add(f, c)
    # sueltos directamente en info/ (categoriza por nombre)
    for f in sorted(INFO.glob("*")):
        if f.is_file():
            add(f, categorize(f))
    # docs fuera del hub → indexar en sitio
    for base in EXTRA_SCAN:
        if base.exists():
            for f in sorted(base.rglob("*")):
                if f.is_file() and f.suffix.lower() in EXTRA_DOC_EXT:
                    add(f, categorize(f))
    return records


def write_outputs(records, moved):
    records.sort(key=lambda r: (ALL_CATS.index(r["category"]), r["title"].lower()))
    catalog = {
        "system": "Sistema de Información Cantares — documentos",
        "generated": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
        "n_documents": len(records),
        "categories": {c: sum(1 for r in records if r["category"] == c) for c in ALL_CATS},
        "documents": records,
    }
    (INFO / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# 📚 Catálogo de documentos — Reserva Cantares", "",
             f"*Generado automáticamente por `data_prep/12_build_doc_catalog.py` — "
             f"{catalog['generated'][:10]}. {len(records)} documentos.*", "",
             "> Para añadir documentos: déjalos en **`info/_inbox/`** y corre el script "
             "(o espera al workflow periódico); se archivan solos en su categoría.", "",
             "## Resumen", ""]
    for c in ALL_CATS:
        n = catalog["categories"][c]
        if n:
            lines.append(f"- {CAT_LABEL[c]}: **{n}**")
    lines.append("")
    for c in ALL_CATS:
        rows = [r for r in records if r["category"] == c]
        if not rows:
            continue
        lines += [f"## {CAT_LABEL[c]}", ""]
        for r in rows:
            lines.append(f"### {r['title']}")
            lines.append(f"`{r['path']}` · {r['type'].upper()} · {r['size_kb']} KB · {r['modified']}")
            if r["preview"]:
                lines.append("")
                lines.append(f"> {r['preview']}")
            lines.append("")
    (INFO / "INDEX.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ensure_folders()
    moved, to_private, busy = autofile()
    # caché de vistas previas del catálogo anterior (evita re-extraer texto lento)
    prev_cache = {}
    if (INFO / "catalog.json").exists():
        try:
            old = json.loads((INFO / "catalog.json").read_text(encoding="utf-8"))
            prev_cache = {r["path"]: (r.get("_mtime"), r.get("preview", ""))
                          for r in old.get("documents", []) if r.get("_mtime")}
        except Exception:
            pass
    records = scan(prev_cache)
    write_outputs(records, moved)

    print(f"Sistema de Información Cantares — documentos")
    print(f"  Indexados: {len(records)} documentos")
    for c in ALL_CATS:
        n = sum(1 for r in records if r["category"] == c)
        if n:
            print(f"    {c}: {n}")
    if moved:
        print(f"  Archivados en su categoría: {len(moved)}")
        for name, cat in moved:
            print(f"    {name} -> {cat}/")
    if to_private:
        print(f"  Movidos a _privado (sensibles, no indexados): {len(to_private)}")
        for name in to_private:
            print(f"    {name} -> _privado/")
    if busy:
        print(f"  ⚠️ En uso (ciérralos y re-corre para archivarlos): {', '.join(busy)}")
    print(f"  Escrito: info/INDEX.md  +  info/catalog.json")


if __name__ == "__main__":
    main()
