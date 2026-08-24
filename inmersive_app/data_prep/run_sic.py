#!/usr/bin/env python3
"""
run_sic.py — Orquestador del Sistema de Información Cantares (SIC).

Corre, en orden, las piezas del sistema integrado:
  10_process_photos.py     — fotos que dejó el admin → app (especies/puntos/senderos/recorridos)
  13_ingest_game_photos.py — fotos del juego (flujo de vuelta) → inventario local

Pensado para correr a mano o de forma PERIÓDICA (Task Scheduler de Windows —
ver setup_scheduler.ps1). No borra nada del usuario: solo procesa las carpetas
de entrada.

Uso:  python data_prep/run_sic.py
"""

import subprocess
from datetime import datetime
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
STEPS = [
    ("Clasificar fotos nuevas (flora + puntos)", "14_classify_photos.py"),
    # Antes de 30: las fotos viejas cuyo NOMBRE ya trae la especie ("trogon
    # personatus1.jpg") se mueven a la carpeta de esa especie, y 30 las registra
    # en la misma corrida. Va después de 14 para pillar también lo que el
    # clasificador acabe de dejar en una carpeta de categoría. Deja un registro
    # para deshacer la tanda (--rollback).
    ("Etiquetas del nombre de archivo", "33_filename_labels.py --apply"),
    # Después de clasificar y ANTES del espejo: crea la carpeta de cada especie del
    # inventario y lee lo que hayas arrastrado a mano dentro de ellas (tu etiqueta
    # manda sobre BioCLIP). Va en este orden para que una corrección tuya llegue a
    # la app en la MISMA corrida; detrás del espejo tardaría una semana en verse.
    ("Carpetas por especie + etiquetado manual", "30_species_folders.py"),
    # Después de 30, que es quien acaba de ingerir las etiquetas nuevas: recalcula
    # el prototipo de imagen de cada especie (iNaturalist + tus fotos etiquetadas)
    # para que el motor de especie deje de ser sólo zero-shot. Barato: los vectores
    # están cacheados, sólo se codifica lo nuevo.
    ("Prototipos de especie (few-shot)", "32_build_prototypes.py"),
    # Justo después de clasificar: la app lee de la carpeta de Dropbox de la app
    # (App folder), no de `Cantares/fotos`. Sin este paso esa copia se queda vieja
    # en cuanto el clasificador ordena algo nuevo. Se omite solo si aún no has
    # conectado la app. Ver docs/DROPBOX_MUESTRAS.md.
    ("Espejo → carpeta de la app (Dropbox)", "28_mirror_app_folder.py"),
    ("Fotos admin → app", "10_process_photos.py"),
    ("Fotos del juego → inventario", "13_ingest_game_photos.py"),
]


# La tarea programada corre SIN VENTANA: sin esto no queda ni rastro de si el
# pipeline funcionó, cuánto tardó o dónde falló — que es exactamente la duda
# («veo que se abre y no sé si hace bien su trabajo»). Todo lo que sale por
# pantalla se duplica a este archivo, que se puede abrir después.
LOG = HERE.parents[1] / "fotos" / "_pipeline.log"


class Tee:
    """Escribe en la consola y en el log a la vez, sin buffer."""

    def __init__(self, *streams):
        self.streams = streams

    def write(self, s):
        for st in self.streams:
            try:
                st.write(s)
                st.flush()
            except Exception:
                pass

    def flush(self):
        for st in self.streams:
            try:
                st.flush()
            except Exception:
                pass


def main():
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        logf = open(LOG, "a", encoding="utf-8", errors="replace")
        sys.stdout = Tee(sys.__stdout__, logf)
    except Exception:
        logf = None            # sin log: se sigue igual, no es motivo para no correr
    print("=" * 60)
    print(f"Sistema de Información Cantares — {datetime.now():%Y-%m-%d %H:%M}")
    print("=" * 60)
    failed = 0
    for title, script in STEPS:
        print(f"\n▶ {title}  ({script})")
        print("-" * 60)
        # Salida EN VIVO, línea a línea. Con capture_output la ventana se quedaba
        # muda hasta que el paso terminaba —media hora con mil fotos— y no había
        # forma de ver si avanzaba o estaba atascada. Se lee del hijo y se
        # reimprime, en vez de dejarlo escribir al descriptor 1 directamente:
        # así lo mismo que se ve en pantalla acaba en el log (el hijo hereda el
        # descriptor del sistema, no el sys.stdout de Python, y si no se hace así
        # el archivo se queda sólo con las cabeceras).
        parts = script.split()
        # `script` puede traer banderas ("33_… --apply"): se separa aquí para no
        # tener que duplicar el bloque de ejecución por cada paso con argumentos.
        cmd = [sys.executable, "-u", str(HERE / parts[0])] + parts[1:]
        proc = subprocess.Popen(cmd,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", bufsize=1)
        for line in proc.stdout:
            print(line.rstrip())
        rc = proc.wait()
        if rc != 0:
            failed += 1
            print(f"  ⚠️ ERROR ({rc}) en {script} — ver el detalle arriba.")
    print("\n" + "=" * 60)
    print(f"Listo. {len(STEPS) - failed}/{len(STEPS)} pasos OK.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
