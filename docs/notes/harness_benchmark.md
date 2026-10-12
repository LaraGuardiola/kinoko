# Harness benchmark: kinoko vs pi (Flappy Bird con power-ups)

Fecha: 2026-10-09. Mismo prompt, mismo modelo (Qwen3.6-35B-A3B Q4_K_M en llama.cpp :8085), mismo
sampling, 131k de contexto y 32k de salida máx. Repos: `~/Projects/kinoko-bird` y `~/Projects/pi-bird`.

**Veredicto corto:** **pi-bird es mejor proyecto**, pero **ninguno de los dos funciona tal y como se
entregó**. pi escribió un juego mucho más completo y correcto y falló en la "fontanería" de servirlo
(son unas 10 líneas de arreglo). kinoko sirve bien en `dev`, pero el juego en sí está roto en lo
importante: los power-ups no se pueden recoger y ni el tap ni Space inician la partida. Además kinoko
gastó unas 2,8 veces más tokens de prompt y necesitó dos intervenciones tuyas.

---

## 1. Cómo lo medí

- `bun install && bun run check` en los dos repos.
- Levanté `bun run dev` y `bun run start` de cada uno y pedí con curl el HTML, el JS, el CSS, el manifest y el favicon.
- Lo jugué en Chromium headless a través de DevTools Protocol: pulsaciones de Space y Enter, clic,
  capturas de pantalla, errores de consola, localStorage y redimensionado en vivo.
- A pi-bird lo serví además con un servidor estático mío (bundle para navegador y sin el overlay de
  "Loading...") para poder juzgar el juego por debajo de los fallos de servidor.
- Leí el código de los sistemas clave: loop, input, física, colisión, power-ups y servidores.
- Analicé turno a turno los logs de sesión de cada harness:
  - kinoko: `~/.kinoko/sessions/nu1cktkorwfi/2f94035d-….jsonl`
  - pi: `~/.pi/agent/sessions/--home-enterprise-Projects-pi-bird--/2026-10-09T19-19-26-….jsonl`

## 2. Resultado: ¿funciona?

| Comprobación | kinoko-bird | pi-bird |
|---|---|---|
| `bun run check` (tsc + oxlint + build) | ✅ 0 errores / 0 warnings | ✅ 0 errores / 0 warnings |
| `bun run dev` sirve el juego | ✅ sí (`/dist/main.js` 200) | ❌ **no**: el HTML pide `/src/main.ts`, que da 404 (y aunque se sirviera sería TS crudo, que el navegador no ejecuta) |
| `bun run start` sirve el juego | ❌ `/dist/main.js` da 404 (busca `dist/dist/main.js`) | ❌ JS y CSS dan 404, y `index.html` sale como `application/octet-stream` (la tabla MIME usa `".html"` pero busca `"html"`) |
| La página se ve | ✅ menú | ❌ un overlay `#loading` con z-index 100 que nunca se quita (tapa el juego aunque se sirva bien) |
| Iniciar con Space / tap / clic (lo que dice la pantalla) | ❌ **no**: solo Enter o "A" inician, y no siempre | ✅ |
| Flap | ⚠️ por estado "mantenido": un tap rápido se pierde y mantener pulsado aplica flap en cada tick | ✅ por evento |
| Recoger power-ups | ❌ **imposible**: `checkPowerUps()` y `powerUpManager.apply()` nunca se llaman | ✅ |
| Shield / Ghost | ❌ Shield mira un array vacío y Ghost no afecta a la colisión | ✅ (Ghost con aviso de parpadeo) |
| Inverted gravity / Heavy (flap débil) / Jitter | ❌ la "inversión" aplica la misma gravedad, el multiplicador de flap nunca se pasa y Jitter no hace nada | ✅ |
| Duración de efectos | ❌ `powerUpManager.update(dt)` se llama dos veces por tick, así que duran la mitad | ✅ |
| Pausa / mute con tecla | ❌ alternan en cada tick mientras se mantiene P o M (parpadeo) | ✅ Esc/P y botón 🔊 |
| High score en localStorage | ⚠️ existe, pero en mis pruebas no se guardó nada (score 0) | ✅ (`flappy-powerups-high-score`) |
| Render interpolado | ❌ `_interpolation` se ignora | ❌ `render(_interpolation)` se ignora |
| Muerte en el techo | ✅ | ⚠️ solo limita la posición, no mata |
| URLs LAN al arrancar | ⚠️ solo IPs `192.168.*` | ✅ todas las IPv4 no internas |

**Lo jugué así:**
- **pi-bird** (con su servidor arreglado): menú con leyenda de los 12 power-ups coloreada por
  buff/debuff, tubos, puntuación, game over con "NEW HIGH SCORE" y high score guardado. Se ve pulido.
- **kinoko-bird** (`dev`): el menú se ve bien, pero Space y clic no hacen nada. Manteniendo Enter
  arranca, aparecen los tubos y la colisión funciona, pero los orbes no se pueden recoger, que es
  justo el giro que pedía el prompt.

**Coste de dejarlos funcionando:**
- **pi**: servir el bundle compilado en lugar de `/src/main.ts`, arreglar la tabla MIME y quitar
  `#loading`. Son unos minutos.
- **kinoko**: rehacer el input (flanco en vez de estado), conectar la recogida de orbes, pasar los
  power-ups activos a la colisión, implementar Ghost, Inverted, Heavy y Jitter, quitar la doble
  llamada a `update` y arreglar `start`. Es reescribir medio `main.ts`.

## 3. Calidad del código y cumplimiento del prompt

| | kinoko-bird | pi-bird |
|---|---|---|
| Archivos fuente (src) | 23 | 43 |
| Archivo más grande | `render/renderer.ts` 456, `main.ts` 423 (el prompt pedía que main fuera "bootstrap only") | `game.ts` 534 (el orquestador; `main.ts` sí es bootstrap, 24 líneas) |
| "Un archivo por power-up + registrarlo" | ❌ todos en `config/powerups.ts`; el comentario dice "add a file", pero no hay archivos por power-up, y además están duplicados a mano en `renderer.ts` (duraciones e iconos) | ✅ 12 archivos en `src/powerups/` y un `registry.ts` (además hay que añadir el id a la unión `PowerUpTypeId`) |
| Carpeta `ui/` | un solo `uiRenderer.ts` | `menu-screen`, `pause-screen`, `game-over-screen` |
| Debuffs más raros | sin peso por tipo (aleatorio uniforme) | 60/40 buff/debuff (el `spawnChance` de cada power-up no se usa) |
| Commits | 10, conventional, por fase ✅ (pero después de que tú se lo recordaras) | **2** (todo en un solo `feat: initial…`) ❌ el prompt pedía commits pequeños |
| "Nunca commitear sin pasar check" | ❌ los 6 primeros commits se hicieron **antes del primer `typecheck`** | ✅ commiteó después del check (aunque en un único commit) |
| Basura en el repo | `.kinoko/spill/*.txt` commiteado y el CSS duplicado en `src/styles` y `public/styles` | — |
| README | ✅ completo | ✅ completo |
| `build` | `--target bun` (debería ser `browser`; el dev server compila para browser) | `--target:bun` (igual) |

En los dos casos el resumen final del agente **dice que todo funciona**, y en ninguno es verdad.
Los dos verificaron con curl, pero mal:
- **kinoko** sí pidió `/dist/main.js`, vio "Not Found" y lo arregló. Es la única razón por la que su
  `dev` funciona. Nunca probó `start`, y no podía ver la lógica de juego rota sin un navegador.
- **pi** pidió el HTML, el CSS y el manifest, pero **nunca el script**. Por eso no se enteró de que
  `/src/main.ts` daba 404.

## 4. Cómo trabajó cada harness (logs de sesión)

| Métrica | kinoko | pi |
|---|---|---|
| Duración | 20:38 → ~21:13 (~35 min, **incluye el tiempo esperándote** tras el corte) | 21:19:57 → 21:56:00 (36 min, sin intervención) |
| Peticiones al modelo (turnos) | **170** | **63** |
| Tool calls | 168 (**1 por turno**) | 140 (**2,2 por turno**, hasta 8 `write` en un turno) |
| Por herramienta | edit 60 · bash 47 · write 36 · read 17 · todo 8 | write 56 · edit 54 · bash 19 · read 11 |
| Tokens de prompt procesados | **9,69 M** (de ellos 9,61 M de caché → ~76k nuevos) | **3,40 M** (3,375 M de caché + 23k nuevos) |
| Tokens de salida | 54,4k | 55,7k |
| Contexto al final | ~103k / 131k | ~78k / 131k (59,7 %) |
| Tool errors | 0 | 9 (5 `edit` sin coincidencia exacta, 4 `tsc` con exit≠0) |
| Cortes de conexión | 1 → **se paró y tuviste que escribir "what happened brother? continue"** | 1 → **reintentó solo** y siguió |
| Intervenciones del usuario | **2** (recordarle git/commits en el turno 20, y "continue") | 0 |

**Por qué kinoko gastó más (lo que viste en las barras):**
1. **Un tool call por turno.** kinoko soporta varios (el provider indexa `tool_calls`), pero el modelo
   nunca los agrupó. pi agrupó escrituras por carpeta: todo `powerups/` en un turno, todo `render/` en
   otro. Cada turno extra reenvía todo el contexto (~60–100k), así que 170 turnos frente a 63 explican
   casi todo el ×2,8. Ayuda que el `edit` de pi acepte un array de ediciones (`edits[1]` aparece en
   sus errores) y que la persona/tooling de pi empuje a agrupar.
2. **Escribió todo sin compilar y lo arregló después:** del turno 50 al 128 son ~78 turnos de arreglar
   errores de `tsc` y `oxlint`, uno por uno, con 80–100k de contexto cada uno. pi hizo lo mismo
   (escribió los 45 archivos y luego compiló), pero arregló 5–8 archivos por turno y salió del bucle
   en ~35 turnos.
3. **Ojo con la contabilidad:** kinoko guarda `input` = prompt **total** (incluida la caché), mientras
   que pi guarda `input` = solo lo **no cacheado** (por eso pi muestra "↑23k"). Comparando lo
   comparable, el cómputo nuevo de prompt fue ~76k (kinoko) frente a ~23k (pi), y la salida fue
   prácticamente igual. La diferencia real es el número de peticiones, no que kinoko "piense" mucho
   más: 20k caracteres de thinking frente a 12k de pi, repartidos en 170 turnos frente a 63 (unos
   120 frente a 195 por turno).

**Estilo de pensamiento/estructura:**
- **kinoko** empezó con una lista de `todo` de 16 pasos (bien estructurado y visible en el panel) y
  la siguió de forma lineal. Pero no hizo `git init` hasta que se lo recordaste, y commiteó código
  sin compilar. Al cerrar mira el estado de los endpoints (bien), pero no la lógica.
- **pi** no usa todo-list. Planificó en un solo pensamiento y fue capa por capa
  (config → powerups → core → input/audio → entities → systems → render → ui → game → server) con
  escrituras masivas por turno. Es más rápido y barato, pero menos disciplinado con git (un único
  commit al final) y con la verificación (nunca pidió el JS).
- Los dos dicen "verified/passes cleanly" en el resumen sin haber visto el juego en un navegador.
  Ninguno tenía herramienta para hacerlo.

## 5. Conclusiones útiles para kinoko (el harness)

Son cosas que este experimento señala como diferencia de harness y no de modelo:

1. **Agrupar tool calls.** Es la mayor fuente de coste. Opciones: que `edit` acepte varias ediciones
   por llamada, y/o una línea de política (en config, no en el prompt) que anime a escribir varios
   archivos independientes en un mismo turno.
2. **Reintento automático ante un corte de conexión.** pi reintentó y siguió; kinoko se paró hasta
   que escribiste.
3. **Verificación temprana.** Los dos escribieron todo antes del primer `tsc`. Un hook o extensión de
   "check tras N writes" ahorraría el bucle largo de arreglos (en kinoko fueron ~78 turnos con
   100k de contexto).
4. **Contabilidad de tokens comparable.** Si la barra de kinoko muestra el prompt total y la de pi
   solo lo no cacheado, la comparación visual engaña. Mostrar "nuevo / caché / salida" por separado
   lo dejaría claro.

## 6. Nota final

pi-bird es un juego bastante mejor (más completo, más modular, efectos bien conectados) que se cae
en el último metro. kinoko-bird tiene mejor historial de git y un `dev` que arranca, pero por dentro
la mecánica principal del prompt, los power-ups, no funciona. El rendimiento del harness también va a
favor de pi: el mismo tiempo, ~1/3 de las peticiones y sin ayuda humana.
