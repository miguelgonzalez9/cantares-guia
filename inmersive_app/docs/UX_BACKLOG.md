# Backlog UX — hallazgos del panel de usuarios simulados (2026-07-11)

Seis personas (papás-admin, turista EN, familia con niños, visitante en campo,
visitante con cuenta, auditor UX/WCAG) evaluaron la app. Los arreglos de alta
prioridad ya se implementaron (ver commit "Panel de usuarios: arreglos UX").
Esto es lo que queda, ordenado por impacto.

## Contenido (requiere datos de Miguel, no código)

1. **Fotos de especies para el juego** — `media.json` no tiene fotos por especie;
   los candidatos del juego salen sin imagen y un niño no puede identificar así.
   Correr `data_prep/10_process_photos.py` con fotos al menos de las ~15 flagship.
2. **`reserve_info.json` vacío** — teléfono, WhatsApp, horarios, cómo llegar,
   parqueadero: la pestaña Info muestra "Por completar" ×5 y no hay número de la
   reserva para emergencias. Llenar con los datos reales.
3. **21 especies de flora sin `common_name_en`** (tabaquillo, cariseco, dulumoco…).

## Cuenta y progreso (features medianas)

4. **Caminatas a la nube** — `recorder.js` guarda solo en IndexedDB local; la
   promesa "tu progreso te sigue entre dispositivos" no aplica a caminatas.
   Crear tabla `walks` en Supabase y subirlas por la cola de `sync.js`.
5. **Avistamientos offline** — `addSighting` es best-effort con señal; encolar
   en `sync.js` (con foto) cuando falle por red.
6. **Migrar progreso de invitado al crear cuenta** — hoy `cantares_player` se
   sobrescribe y las capturas previas del invitado "desaparecen" del panel.
7. **Geocerco**: exigirlo solo al CREAR cuenta (no en cada login); buffer de
   ~75 m alrededor del polígono (GPS bajo dosel); aviso al registrarse
   "guarda tu contraseña — no hay recuperación por email";
   `autocomplete="new-password"` en signup para que iCloud Keychain la guarde.

## Juego (familia con niños)

8. **Cambio de explorador** en un mismo teléfono (dos hermanos, un iPhone):
   selector en `.gm-head`; el ranking ya soporta varios jugadores.
9. **Premios por visita**, no por ranking histórico del dispositivo.
10. **Especie del día**: hoy solo flora; considerar rotar grupo (aves los fines
    de semana) para birders.
11. **Tono de los textos del juego**: más para niños, menos "inventario vivo".

## Accesibilidad / pulido

12. **Contraste**: CTAs naranjas (`#e07a1f` con texto blanco ≈ 3:1 < 4.5:1 AA);
    oscurecer a ~`#b35c0f` o texto oscuro. Tipografías de 9.5–11px → ≥11.5px.
13. **`prettyAuthError` según idioma** (hoy solo ES) y estado "verificando
    ubicación…" en contenedor neutro (hoy usa el contenedor de error, rojo).
14. **Borrado en dos toques del juego** (`.gm-rec-del`): el estado armado no
    expira; añadir timeout de 3 s y unificar patrón de confirmación.
15. **Manifest y `<title>` en EN**; `aria-label` localizados vía `applyStaticI18n`.
16. **Doble `watchPosition`** si grabas caminata durante un recorrido guiado:
    unificar en un solo watch compartido (batería).
17. **Botón "Descargar mapa de la reserva"**: precachear proactivamente los
    tiles del polígono (y fotos flagship) al entrar con wifi, en vez de confiar
    en lo que el visitante haya visto en pantalla.
