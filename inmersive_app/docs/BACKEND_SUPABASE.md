# Cuentas, progreso global y edición sin código — configuración de Supabase

Esto activa: **login al entrar** (invitado / visitante con cuenta / admin), **progreso
guardado** que sigue al visitante entre dispositivos, un **inventario global** que se
llena entre todos, y un **editor de administrador** para que tú y tus papás cambien
puntos, textos, imágenes y especies **sin programar**.

Mientras no completes estos pasos, la app funciona igual que hoy (estática, sin login).
Todo lo nuevo está apagado hasta que pegues las credenciales en el paso 6.

Tiempo: ~10 minutos, una sola vez.

---

## 1. Crear el proyecto (gratis)
1. Entra a <https://supabase.com> → **Start your project** → crea cuenta (GitHub o correo).
2. **New project**. Nombre: `cantares`. Elige una contraseña de base de datos (guárdala).
   Región: la más cercana (p. ej. *East US* o *São Paulo*). Espera ~2 min a que quede lista.

## 2. Apagar la confirmación por correo (importante)
Como los usuarios entran con **usuario** (no correo), hay que desactivar la verificación:
- Menú **Authentication → Sign In / Providers → Email** → desactiva **Confirm email** → **Save**.

## 3. Crear las tablas y la seguridad
- Menú **SQL Editor → New query**.
- Copia TODO el contenido de `app/public/data/schema.sql`, pégalo y dale **Run**.
  (Crea tablas, seguridad por filas, el disparador de perfiles y el bucket de imágenes.)

## 4. Cargar los datos actuales
- Otra query nueva. Copia TODO `app/public/data/13_seed_supabase.sql`, pégalo y **Run**.
  (Carga las 92 especies, 16 puntos y 19 senderos que ya existen.)
- Si cambias los datos locales, regenera ese archivo con:
  `node data_prep/13_seed_supabase.js`

## 5. Copiar tus credenciales
- Menú **Project Settings → API**. Copia:
  - **Project URL** (algo como `https://xxxx.supabase.co`)
  - **anon public** key (la clave larga marcada *anon* / *public*).
- Estas dos son **públicas y seguras** de versionar (la seguridad la dan las políticas RLS).
  ⚠️ NO copies la clave *service_role* (esa es secreta).

## 6. Pegarlas en la app
- Abre `app/public/js/cloud.js` y llena las dos líneas de arriba:
  ```js
  const CLOUD = {
    url:     'https://xxxx.supabase.co',
    anonKey: 'eyJ...tu-anon-key...',
  };
  ```
- Guarda, haz commit y sube (a GitHub Pages). Al recargar, aparecerá la pantalla de login.

## 7. Hacerte administrador
1. Abre la app y en la pantalla de entrada dale **Crear cuenta** con TU usuario (p. ej. `miguel`)
   y una contraseña. Ya quedaste como *visitante*.
2. Vuelve a Supabase → **SQL Editor** → corre (cambia el usuario):
   ```sql
   update public.profiles set role = 'admin' where username = 'miguel';
   ```
3. Recarga la app. Verás el botón **🛠️** (abajo a la derecha): ese es el editor.
4. Repite el paso 2 con el usuario de cada uno de tus papás para que también editen.

---

## Qué puede hacer el admin (🛠️)
- **Puntos:** añadir uno nuevo (tocas el mapa para ubicarlo), cambiar título y descripción
  (ES/EN), tipo, recorridos, especies asociadas, subir una foto, o eliminarlo.
- **Especies:** añadir/editar/eliminar especies del inventario (nombre, científico, familia,
  grupo, destacada, foto).
- Los cambios se guardan en la nube y **aparecen para todos** al recargar.

## Qué pasa con los visitantes
- Pueden **Explorar como invitado** (sin cuenta) igual que antes, o **crear cuenta**.
- Con cuenta, sus avistamientos y puntos **se guardan en el servidor**: si vuelven —incluso
  en otro celular— siguen donde iban. Además alimentan el **inventario global** de la reserva.

### Geocerco (crear/entrar solo dentro de la reserva)
- Por defecto, **crear o entrar a una cuenta de visitante exige estar físicamente dentro
  del polígono de la reserva** (usa el GPS del celular y `data/boundary.geojson`).
- Los **admins entran desde cualquier lugar** (para editar desde casa) y el modo **invitado
  no exige ubicación**.
- Para activarlo/desactivarlo cambia el parámetro al inicio de `app/public/js/auth-ui.js`:
  `const REQUIRE_IN_RESERVE = true;` (ponlo en `false` para quitar el geocerco).

## Privacidad y seguridad
- Las contraseñas las maneja y cifra Supabase (nunca las vemos ni se guardan en texto).
- Las políticas RLS garantizan: contenido y catálogo = lectura pública, escritura solo admin;
  cada visitante solo edita/borra sus propios avistamientos.
- La `anon key` es pública por diseño; la seguridad no depende de ocultarla.

## Todavía no (siguiente iteración)
- **Dibujar senderos** (líneas) desde el editor: por ahora los senderos se siguen editando en
  QGIS; el editor cubre puntos, textos, imágenes y especies. Se puede añadir un modo "dibujar
  sendero en el mapa" después.
- Editar los textos de "La Reserva" / "Planea tu visita" desde el admin (hoy salen de
  `reserve_info.json`).
