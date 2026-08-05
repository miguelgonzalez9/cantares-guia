#!/usr/bin/env python3
"""
28_mirror_app_folder.py — copia las FOTOS (no los vídeos) del archivo clasificado
a la carpeta de la app de Dropbox, para que la app pueda traer muestras sola.

Por qué existe: la app lee el archivo por la API de Dropbox con una app de tipo
**App folder**, que sólo ve `Dropbox/Apps/<nombre>/` — el resto de la cuenta
(escrituras, contabilidad, lo personal) le es invisible aunque el código fallara.
Esa es la frontera real. El precio es que las fotos tienen que estar AHÍ, y el
clasificador escribe en `Cantares/fotos`. Este paso cierra ese hueco después de
cada clasificación, así que la copia no se queda vieja.

Qué NO copia, y por qué importa:
  - VÍDEO (mp4/avi/mov): 6,6 de los 11 GB del archivo. La función de muestras sólo
    procesa imágenes, así que copiarlo sería duplicar gigas para nada.
  - `infraestructura/`: 5,5 GB y el clasificador ya la excluye (AUTO_EXCLUDE).
  - Carpetas de trabajo (`_sin_clasificar`, `_desde_app`): sin revisar. Lo que se
    sube desde la app queda alcanzable por URL pública, así que lo no revisado no
    tiene por qué estar ni disponible.

Usa `robocopy`, que salta lo que no ha cambiado (tamaño + fecha): la primera
pasada copia ~3,5 GB y las siguientes son segundos.

Uso:
  python data_prep/28_mirror_app_folder.py            # copia
  python data_prep/28_mirror_app_folder.py --dry-run  # enseña qué haría
  python data_prep/28_mirror_app_folder.py selftest   # lógica pura, sin tocar disco

Destino configurable con la variable de entorno CANTARES_APP_FOLDER.
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
CANTARES = HERE.parent.parent
SRC = CANTARES / "fotos"
# Ajusta el nombre si en el App Console pusiste otro. La variable de entorno gana,
# para no tener que editar el archivo en otra máquina.
DEFAULT_DST = Path.home() / "Dropbox" / "Apps" / "Cantares Guía" / "fotos"
EXTS = ["*.jpg", "*.jpeg", "*.png", "*.webp"]
SKIP_DIRS = ["_sin_clasificar", "_desde_app", "infraestructura"]


def dst_path():
    env = os.environ.get("CANTARES_APP_FOLDER")
    return Path(env) if env else DEFAULT_DST


# ------------------------------------------------------------------ puras
def robocopy_ok(code):
    """robocopy NO usa 0 = éxito como todo lo demás: devuelve un mapa de bits.
    0 = nada que copiar, 1 = copió, 2 = extras, 4 = desajustes… y cualquier
    combinación por debajo de 8 sigue siendo un éxito. A partir de 8 hay fallos
    de verdad y 16 es fatal. Tratar «1» como error es EL error clásico al
    envolver robocopy: el paso pasa a fallar justo cuando ha hecho su trabajo."""
    return isinstance(code, int) and 0 <= code < 8


def robocopy_cmd(src, dst, dry=False):
    cmd = ["robocopy", str(src), str(dst), *EXTS, "/S", "/XD", *SKIP_DIRS,
           "/R:1", "/W:1", "/NFL", "/NDL", "/NP"]
    if dry:
        cmd.append("/L")   # sólo listar, no tocar nada
    return cmd


# ------------------------------------------------------------------ comandos
def cmd_run(args):
    src, dst = SRC, dst_path()
    if not src.is_dir():
        print(f"  ✗ no existe el origen: {src}")
        return 1
    # La carpeta de la app la crea Dropbox al VINCULAR la app por primera vez. Si
    # todavía no está, esto no es un fallo: es que aún no se ha conectado. Salir
    # con 0 evita una alarma semanal por algo que no está roto.
    if not dst.parent.exists():
        print(f"  · la carpeta de la app aún no existe ({dst.parent})")
        print("    Se crea al conectar la app desde Dropbox. Paso omitido.")
        return 0
    if shutil.which("robocopy") is None:
        print("  · robocopy no está disponible (¿no es Windows?). Paso omitido.")
        return 0

    # Un simulacro no puede tocar el disco, ni siquiera para crear el destino.
    if not args.dry_run:
        dst.mkdir(parents=True, exist_ok=True)
    cmd = robocopy_cmd(src, dst, args.dry_run)
    print(f"  {'(simulacro) ' if args.dry_run else ''}{src}  →  {dst}")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    # El resumen de robocopy son las últimas líneas; el detalle ya va silenciado.
    tail = [l for l in (r.stdout or "").splitlines() if l.strip()][-6:]
    for l in tail:
        print("    " + l.strip())
    if not robocopy_ok(r.returncode):
        print(f"  ✗ robocopy falló (código {r.returncode})")
        print((r.stderr or "").strip()[-500:])
        return 1
    print(f"  ✓ copia al día (código {r.returncode})")
    return 0


def cmd_selftest(args):
    # El mapa de bits de robocopy, que es donde se equivoca todo el mundo.
    for ok in (0, 1, 2, 3, 5, 7):
        assert robocopy_ok(ok), f"{ok} es ÉXITO en robocopy"
    for bad in (8, 9, 15, 16, -1):
        assert not robocopy_ok(bad), f"{bad} es fallo"
    assert not robocopy_ok(None) and not robocopy_ok("1")

    # El comando lleva lo que debe y NADA destructivo: sin /MIR ni /PURGE, que
    # con un origen equivocado borrarían el destino entero.
    c = robocopy_cmd("A", "B")
    assert c[0] == "robocopy" and c[1] == "A" and c[2] == "B"
    assert "/S" in c and "/XD" in c
    for d in SKIP_DIRS:
        assert d in c, f"falta excluir {d}"
    for e in EXTS:
        assert e in c
    assert not any(f in c for f in ("/MIR", "/PURGE", "/MOVE")), "nada que borre en el destino"
    # Sólo imágenes: el vídeo es 6,6 de los 11 GB y la app ni lo mira.
    assert not any(x in " ".join(c).lower() for x in (".mp4", ".avi", ".mov"))
    # `--dry-run` no puede tocar disco.
    assert "/L" in robocopy_cmd("A", "B", dry=True)
    assert "/L" not in robocopy_cmd("A", "B", dry=False)
    print("selftest 28_mirror_app_folder: 6/6 OK")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", default="run", choices=["run", "selftest"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    sys.exit((cmd_selftest if args.cmd == "selftest" else cmd_run)(args))


if __name__ == "__main__":
    main()
