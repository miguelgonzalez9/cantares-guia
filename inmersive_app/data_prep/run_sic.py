#!/usr/bin/env python3
"""
run_sic.py — Orquestador del Sistema de Información Cantares (SIC).

Corre, en orden, las tres piezas del sistema integrado:
  10_process_photos.py     — fotos que dejó el admin → app (especies/puntos/senderos/recorridos)
  13_ingest_game_photos.py — fotos del juego (flujo de vuelta) → inventario local
  12_build_doc_catalog.py  — (re)construye el catálogo buscable de documentos

Pensado para correr a mano o de forma PERIÓDICA (Task Scheduler de Windows —
ver setup_scheduler.ps1). No borra nada del usuario: solo procesa las carpetas
de entrada y reconstruye índices.

Uso:  python data_prep/run_sic.py
"""

import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
STEPS = [
    ("Clasificar fotos nuevas (flora + puntos)", "14_classify_photos.py"),
    ("Fotos admin → app", "10_process_photos.py"),
    ("Fotos del juego → inventario", "13_ingest_game_photos.py"),
    ("Catálogo de documentos", "12_build_doc_catalog.py"),
]


def main():
    print("=" * 60)
    print("Sistema de Información Cantares — ejecución del pipeline")
    print("=" * 60)
    failed = 0
    for title, script in STEPS:
        print(f"\n▶ {title}  ({script})")
        print("-" * 60)
        r = subprocess.run([sys.executable, str(HERE / script)], capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        if r.stdout:
            print(r.stdout.rstrip())
        if r.returncode != 0:
            failed += 1
            print(f"  ⚠️ ERROR ({r.returncode}):")
            print((r.stderr or "").rstrip()[-1500:])
    print("\n" + "=" * 60)
    print(f"Listo. {len(STEPS) - failed}/{len(STEPS)} pasos OK.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
