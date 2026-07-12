-- Cantares — recategoriza los puntos "otros" (tipo 'punto') a la nueva
-- categoría de árboles ('arbol'). Pega esto en el SQL Editor de Supabase y
-- córrelo una vez. Afecta sólo a los puntos de la nube (los del inventario
-- estático ya son tipo 'arbol').
update public.waypoints set tipo = 'arbol' where tipo = 'punto';
