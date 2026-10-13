# Rastro

*[English](README.md) — el README en inglés es el de referencia; este puede ir un paso por detrás.*

CLI para navegadores con vista mínima de páginas, resúmenes de efecto por acción y trazas de eventos consultables. Rastro mantiene el contexto lean mientras registra todo lo que ocurre debajo: requests, navegaciones, cambios de cookies, errores de consola, diálogos y bloques.

## El problema

Los agentes IA que navegan hoy reciben o bien el árbol de accesibilidad completo (miles de tokens por paso) o solo píxeles. Ninguna herramienta existente (Playwright MCP, Chrome DevTools MCP, agent-browser, Obscura) vincula las acciones del agente a los requests, navegaciones y cambios de estado que causó, en un registro que el agente puede investigar bajo demanda. Los agentes se ahogan en contexto o actúan a ciegas.

Rastro da al agente el mínimo que un humano percibe (qué se puede interactuar y un resumen de efecto de cada acción) mientras registra todo como una traza causal investigable a demanda.

## Comparación

| | **Rastro** | Playwright MCP | Chrome DevTools MCP | browser-use | Obscura |
| --- | --- | --- | --- | --- | --- |
| Qué ve el agente | solo lo interactivo, con refs | snapshot ARIA completo | DOM / CDP crudo | DOM + capturas | DOM filtrado |
| Tokens por página | **~28-62** (HN 62, Wikipedia 268) | miles | miles | muy alto (visión) | medio |
| Resumen de efecto por acción | **sí, una línea** | no | no | no | no |
| Traza causal acción → efecto | **sí, consultable en vivo** | no | traza sin causalidad | no | no |
| Investigación a demanda | **sí**, por niveles | no | sí, sin filtrar | no | parcial |
| Seguro sin humano delante | **write guard + mascarado** | no | no | no | no |
| Grabación humana → script | **sí** (YAML + export PW) | codegen aparte | Chrome Recorder | no | no |
| Corrida → cliente de API autónomo | **sí**, determinista (`flow emit`, TS / Python) | no | no | no | no |
| Mapa del sitio entero por script | **sí** (`flood`: cada pantalla, elemento y llamada; escrituras bloqueadas) | no | no | no | no |
| Navegador | Chromium (`playwright-core`) | multi | Chrome | multi | Chromium |

Los dos diferenciadores reales son la **atribución causal** (ninguna otra
herramienta te dice "este click disparó estas 4 peticiones, esta cookie y esta
navegación", consultable a mitad de tarea) y el **resumen de efecto en una
línea**, que evita volcar la página entera tras cada acción.

Dónde Rastro **no** es la respuesta: no tiene visión, así que una página que solo
se entiende por píxeles es terreno de `browser-use`; es solo Chromium; y es
nuevo, frente a la adopción que ya tiene Playwright MCP.

## Instalación

```bash
npm i -g @rixmerz/rastro
```

Requisitos: Node.js ≥ 22.5 y un navegador de la familia Chromium ya instalado —
Rastro maneja tu propio navegador y tu perfil, nunca descarga uno.

Desde un clon, para desarrollo:

```bash
pnpm install
pnpm link --global
# o: npm i -g .
```

Variables de entorno (opcionales):
- `RASTRO_CHROMIUM` — binario del navegador. Por defecto, el primero que exista
  entre `/usr/bin/{chromium, google-chrome-stable, google-chrome, brave,
  brave-origin, microsoft-edge}` en Linux, o `/Applications/{Chromium, Google
  Chrome, Brave Browser, Microsoft Edge}.app` en macOS. Apuntarlo a un Google Chrome real para los
  sitios que exigen la marca `Google Chrome`, entre ellos la Web Store, que no
  instala en nada más. Cambiarlo sobre un perfil ya existente no sale gratis:
  navegador nuevo, nombre de sesión nuevo.
- `RASTRO_EXTENSIONS` — directorios de extensiones descomprimidas separados por
  `:`, para las que un replay headless necesita y nadie puede instalar a mano
- `RASTRO_HOME` — directorio de datos (default `~/.local/share/rastro/`)
- `RASTRO_SESSION` — nombre de sesión (default `default`)
- `RASTRO_IDLE_MS` — ventana silenciosa en ms (default 500)

## Inicio rápido: login

```bash
rastro open https://example.test --allow-write example.test

rastro view
# navigation with 2 links, main form with email (e5), password (e6), submit (e7)

rastro fill e5 user@example.com
# #1 · no effects

rastro fill e6 --secret mypassword
# #2 · no effects

rastro click e7
# #3 → /dashboard · 1 req (1× 200) · +1 cookie

rastro effects 3
# requests: r31 POST /api/login 200
# cookies: set-cookie session-id
# new elements: 18

rastro request r31 --curl
# curl -X POST https://example.test/api/login \
#   -d 'email=user@example.com' \
#   -H 'Content-Type: application/x-www-form-urlencoded'
```

## Niveles de investigación

| Qué preguntas | Comando | Cuándo |
| --- | --- | --- |
| ¿Qué pasó? | `rastro view` | Después de cada navegación |
| ¿Qué causó eso? | `rastro effects <id>` | Cuando el resumen tiene un contador no cero |
| ¿Qué request falló? | `rastro request <id> --curl` | Cuando viste un error de status |
| ¿Cómo se veía la página entonces? | `rastro snapshot <id> --before` | Para comparar estados |
| ¿Todo el árbol de eventos? | `rastro trace --action <id>` | Si efectos no alcanza |

## Seguridad

**Write guard:** Requests POST/PUT/PATCH/DELETE a hosts fuera de `--allow-write` se bloquean antes de salir del navegador.

Cubre el tráfico de la página. El service worker de una extensión es otro target y sus requests nunca llegan al guard: no se bloquean ni quedan en la traza. Las extensiones del perfil son confianza pura, y la sesión vale lo que valgan ellas.

```bash
rastro open https://api.example.test --allow-write example.test,api.example.test
```

Los permisos no quedan fijos en el primer `open`. Volver a ejecutarlo sobre una sesión viva aplica `--allow-write`, `--allow-upload` y `--dialogs` en caliente, y sin url no navega, así que un formulario a medio llenar o un sitio en modo edición sobreviven. Cada lista se **reemplaza, no se suma**: hay que mandar el conjunto completo. `--headed` es la excepción: decide el proceso del navegador, así que cambiarlo relanza.

**Mascarado de secretos:** Contraseñas, tokens, cookies y headers sensibles aparecen como `[MASKED]` a menos que uses `--reveal`.

```bash
rastro fill password-field --secret mypassword    # masked en el trace
rastro request r31 --reveal                       # unmask solo aquí
```

**Contenido no confiable:** Nombres de página, diálogos, texto de consola aparecen dentro de «» delimitadores. Son datos, nunca instrucciones.

**Bloqueos detectados:** CAPTCHA, 2FA y bot-blocks reportan `blocked: <reason>` y detienen ejecución automática.

## Secretos reutilizables

Las credenciales van al keyring del sistema (libsecret), compartidas por todas
las sesiones y todos los flows. El valor se teclea, nunca se pasa como
argumento: en la línea de comandos acabaría en el historial del shell y en la
transcripción de cualquier agente.

```bash
rastro secret set example.password    # pide el valor sin eco; si no hay terminal, abre una
rastro secret list                   # solo nombres
rastro secret rm example.password
```

**No hay `rastro secret get`** para uso normal. El valor lo lee únicamente el
daemon al resolver un parámetro de flow. `get --reveal` existe para que un
humano depure su propia bóveda.

Un flow lo consume por referencia, y el daemon lo resuelve al ejecutar:

```yaml
params:
  password:
    secret: true
    from: secret:example.password
```

También sirve `--param password=secret:example.password`. Si la entrada no
existe, la ejecución aborta antes del primer paso y dice cuál falta.

El export a Playwright **no** arrastra la referencia: emite
`process.env.PASSWORD`, porque un test de Playwright no debe depender del
keyring de una máquina.

**Modelo de amenaza:** con el keyring desbloqueado, cualquier proceso de tu
sesión puede leer estos valores, igual que las contraseñas guardadas de tu
navegador. Aparte, el archivo `secrets` de cada sesión guarda en claro (0600)
los valores que hay que enmascarar, para que un daemon reiniciado siga sabiendo
qué redactar.

## Flows (fase 2)

Registra navegaciones humanas en navegador visible, convierte a YAML, ejecuta con condiciones y parámetros, exporta a tests Playwright, importa desde Chrome Recorder.

Un nombre pelado se guarda y se busca en `./.rastro/flows/` si ese directorio
existe en el proyecto, y si no en `~/.config/rastro/flows/`. Una ruta sigue
siendo una ruta.

```bash
rastro record start https://example.test
# Usuario hace login, llena forma...
rastro record stop --save login-example

rastro flow run login-example --param email=user@test.com
```

## Rutinas: flows como herramientas del agente

Un flow pasa a ser una **rutina** cuando lleva un bloque `tool:`. El agente la
llama como cualquier herramienta, con parámetros tipados, en vez de manejar el
navegador paso a paso o armar una línea de `flow run`.

```yaml
name: publish-file
tool:
  description: Publish a local file as a resource in a course section
  effect: write              # read | write | destructive
  session: school            # opcional: la sesión del daemon donde corre
  allowWrite: [lms.example.edu]
  allowUpload: [~/Documents]
  login: login-school        # opcional: se corre una vez si aparece un login
  loginWhen: { url: /login/* }
params:
  course:  { type: integer, description: numeric course id, example: 12345 }
  section: { type: integer, description: section number }
  file:    { type: path, description: local file to publish }
steps: ...
```

```bash
rastro routine list
rastro routine show publish-file
rastro routine run publish-file --param course=12345 --param section=1 --param file=~/Documents/a.pdf
```

Lo que evita que esto salga mal:

- **Opt-in.** Solo los flows con bloque `tool:` son rutinas, y se llaman como
  el archivo. Las grabaciones crudas siguen siendo flows.
- **Período de prueba.** Una rutina recibe su propia herramienta MCP recién
  cuando los bytes exactos de su archivo completaron una corrida. Editarla la
  devuelve a prueba; mientras tanto se puede correr con `rastro_routine_run`.
- **Permisos acotados.** La corrida usa `allowWrite` y `allowUpload` de la
  rutina y después devuelve las listas de la sesión, también si falla. Los
  parámetros del keyring nunca forman parte de la entrada de la herramienta.
- **Sin escrituras duplicadas.** Una página de login (`loginWhen`) dispara el
  flow `login` y **un** reintento, solo si todavía no se escribió nada. El
  resultado lista las escrituras enviadas y dice si reintentar es seguro. Un
  timeout del cliente responde que la rutina puede seguir corriendo, no que
  falló.
- **Un archivo roto no tumba el servidor.** Pierde su herramienta y aparece en
  `rastro_routines` con el error.

`rastro mcp` expone siempre `rastro_routines` y `rastro_routine_run`, y una
herramienta por rutina verificada, actualizada en vivo cuando cambian los
archivos. `--routines-only` deja al agente solo con rutinas verificadas;
`--routines=catalog` deja solo las dos fijas; `--routines=off` las quita.

## Leer, y rutinas que devuelven datos

`view` lista lo que se puede accionar; el cuerpo de un correo o un párrafo no
está ahí. `rastro read` devuelve el texto que ve una persona:

```bash
rastro read                       # la región main, o la página completa
rastro read --region aside        # una región, con los nombres de view
rastro read --ref e42             # un elemento
rastro read --find "EV.2"         # las líneas alrededor de una palabra
```

Las rutinas devuelven datos con dos pasos que nombran su salida con `as`:
`read` (texto de la página) y `capture` (el JSON con que respondió una request
de la corrida; el patrón admite la query y `json` acepta nombres con punto,
`[n]` y `[*]`, con `fields` para proyectar cada elemento). El resultado trae las
salidas, enmascaradas. Un `capture` sobrevive a `flow link` y vuelve también
desde la réplica HTTP; un `read` no se puede enlazar.

## Enlazar un flow a sus llamadas HTTP

`rastro flow link` convierte una rutina en requests HTTP directos, así corre
sin Chromium: un proceso de Node en vez de un navegador.

```bash
rastro flow link publish-file --param course=12345 --param section=1 --param file=~/Documents/a.pdf
rastro routine run publish-file --engine http ...   # la primera corrida HTTP verifica la receta
```

**El enlace corre el flow una vez de verdad**, en el navegador y con sus
efectos reales, y compila los requests que causó esa corrida. Con
`--from`/`--to` compila una corrida anterior.

Los valores que cambian en cada corrida (un token CSRF, un id de borrador) se
rastrean hasta la respuesta que los entregó y pasan a ser reglas de extracción.
La receta **no guarda credenciales**: si una fuera a quedar en el archivo, el
enlace se aborta. `auto` (el default) usa HTTP solo con una receta vigente y
verificada, y vuelve al navegador **solo si todavía no se envió ninguna
escritura**. Editar el flow deja la receta vieja; editar la receta a mano la
deja sin verificar hasta otra corrida con `--engine http`. El jar de cookies
(`sessions/<sesión>/cookies.json`, modo 0600) guarda solo las cookies de los
hosts de la receta, no el resto del perfil.

**No se puede enlazar, a propósito:** requests firmados por JavaScript de la
página, WebSockets, tokens de vida corta generados en el navegador, y subidas
cuyo cuerpo el navegador no expone. Esas rutinas siguen en el navegador.

### Listas: todas las páginas, no solo la grabada

Al enlazar, una rutina de lectura suele haber traído una sola página. Si el
request producto (el último, o el que nombra un `capture`) es un GET de script
cuyo JSON parece una página de algo más largo, el enlace agrega un bloque
`paginate` y lo avisa:

```yaml
paginate: { query: page, next: { step: 1 }, items: jobs, maxPages: 10 }
```

Reconoce un cursor de la respuesta que vuelve como parámetro de query
(`next: { json: meta.next_cursor }`), una URL siguiente del mismo origen
(`next: { url: next }`), un número de página (`step: 1`) y un offset con
límite (`step: <límite>`). La corrida HTTP trae las páginas siguientes y une
sus ítems en la primera respuesta, así los `capture` ven la lista entera. Para
en `maxPages`, en una página vacía o corta, o cuando se acaba el cursor o la
URL. Solo paginan las lecturas; borrar el bloque vuelve a la página grabada.

## Clientes autónomos: `flow emit`

Una receta verificada puede salir de Rastro como código, para un job de backend
o un script en otro repositorio:

```bash
rastro flow emit publish-file --lang py      # publish_file_client.py, solo biblioteca estándar
rastro flow emit publish-file --lang ts      # publish-file.client.ts, Node >= 22.18 lo corre tal cual
```

La receta va en el archivo como datos, con un runtime chico que la reproduce
con las reglas del runner HTTP: extracción, redirecciones a mano, clases de
status, paginación y capturas. No se infiere nada: el cliente hace lo que hace
la receta verificada, al revés de pedirle a un modelo que adivine un cliente a
partir de un HAR.

- **El archivo no guarda credenciales**, igual que la receta. La sesión la pone
  quien llama: un header Cookie (`--cookie` / `$COOKIE`) o el `cookies.json`
  de la sesión de Rastro (`--cookie-file` / `$RASTRO_COOKIES`). Los parámetros
  del keyring se leen de variables de entorno (`from: secret:api.token` →
  `$API_TOKEN`, listadas en la cabecera del archivo).
- **Una receta vieja se rechaza**; una sin verificar se emite con un aviso.
- Un cliente que escribe lo dice arriba y, si falla, informa las escrituras ya
  enviadas (`ReplayError.writes`) para no reintentarlas a ciegas.

## Mapear un sitio entero: `flood`

Un agente aprende un sitio de a un `view` → `click` → `effects`, y la mayoría
de esos pasos no llevan a nada. `rastro flood` hace esa parte por script, sin
modelo en el ciclo. Activa cada elemento de cada pantalla y registra qué llama
cada uno, y le entrega al agente un mapa que lee de una vez.

La imagen es el agua llenando un laberinto. Cada camino abierto sube un nivel
a la vez, todos juntos, hasta que se acaba la profundidad, el presupuesto o el
tiempo.

```bash
rastro -s tienda open https://shop.test/login --allow-write shop.test   # login una vez, a mano o con una rutina
rastro -s tienda flood https://shop.test/ --workers 4 --depth 3
# shop-test: done · 4 levels · 37 states · 412 actions · 52 endpoints (6 writes, 6 blocked) · 0 unexplored · 3m12s
# map: ~/.local/share/rastro/floods/shop-test/map.md

rastro flood show shop-test           # el mapa, ~4k tokens: escrituras, lecturas, estados, bloqueos
rastro flood show shop-test E7        # un endpoint: quién lo llama, muestras, cómo profundizar
rastro flood show shop-test S4        # un estado: cada elemento, qué hizo y adónde llevó
rastro flood resume shop-test --from S4 --depth +2   # inundar una rama más a fondo
```

- **Cañerías.** `--workers N` corre N sesiones en paralelo,
  `flood-<nombre>-w1…wN`, vaciando una sola cola, lo menos profundo primero.
  Cada worker es una sesión propia porque la atribución es de a una acción por
  página. Todos parten con las cookies y el storage de la sesión desde la que
  corres `flood`, así que te logueas una vez.
- **Estados, no URLs.** Una pantalla es su plantilla de URL más sus controles,
  así que `/orders/1` y `/orders/2` son un solo estado, y un diálogo abierto en
  el lugar es otro. Se pliegan los ids, los números dentro de nombres
  (`page-{n}.html`) y `index.html`. Los slugs se aprenden de links hermanos:
  cinco links que difieren solo en un segmento (`/tag/love/`, `/tag/life/`, …)
  lo vuelven `{slug}`. Treinta links a la misma plantilla se prueban una vez,
  los 20 botones «Añadir al carro» idénticos de una lista una vez, y un
  control del header o la navegación una vez por flood.
- **Educado, nunca sigiloso.** Por defecto, 2 acciones por segundo por host
  entre todos los workers, con jitter y un tope de concurrencia. Un 429 o 503
  baja el ritmo a la mitad y respeta `Retry-After`. Se respeta robots.txt salvo
  con `--ignore-robots`. Un CAPTCHA, 2FA o muro antibot pausa el host, y dos
  seguidos lo detienen. Flood detecta y retrocede. No cambia la huella del
  navegador, no rota identidades ni resuelve desafíos.
- **Las escrituras se encuentran, no se envían.** El guard de escritura queda
  como está por defecto: nada permitido. Una escritura bloqueada se registra
  con método, URL y cuerpo (enmascarado), así el mapa muestra qué enviaría un
  formulario, con sus nombres de campo. Logout, eliminar, pagar, darse de baja
  y similares se listan pero nunca se presionan. `--skip` agrega nombres y
  `--include` deja pasar uno. Los formularios reciben valores neutros antes de
  enviarse. Los campos de contraseña nunca se llenan.
- **Se puede profundizar.** Cada activación es una acción normal (`[flood]` en
  `history`) en la traza de su worker, así que `effects`, `request --curl` y
  `snapshot` funcionan sobre ella, también después del flood.
- **En segundo plano.** `--detach` vuelve de inmediato. Se sigue con
  `flood status`, `flood stop` (lo que quedó pasa a unexplored) y `flood list`.
  Por MCP: `rastro_flood_start`, `rastro_flood_status`, `rastro_flood_map`,
  `rastro_flood_resume`, `rastro_flood_stop`.

Límites: `--depth 3`, `--budget 300` (elementos probados), `--time 10m`,
`--rate 2`, `--concurrency 2`. Los mapas viven en
`~/.local/share/rastro/floods/<nombre>/` (`map.json`, `map.md`).

## Salida para máquinas

Con `--json` cada comando imprime una línea:
`{"schemaVersion":1,"ok":true,"data":…}` o
`{"schemaVersion":1,"ok":false,"error":{"kind","message","hint"}}`. El error en
texto sigue saliendo por stderr. Códigos de salida: `0` éxito, `1` error de
ejecución, `2` error de uso.

## Plugin Claude Code

### Instalación

Copia los directorios `plugin/skills/rastro/` y `plugin/agents/navegador.md` a:

```bash
~/.claude/skills/rastro/
~/.claude/agents/navegador.md
```

O link global desde la ruta del repo:
```bash
claude plugin install /ruta/a/rastro/plugin
```

El plugin trae una entrada MCP que ejecuta `rastro mcp`, así que **el CLI tiene
que estar en el `PATH` primero** (`npm i -g @rixmerz/rastro`). Sin eso el plugin instala
bien y cada llamada falla con `rastro: command not found`.

### Uso

```
/rastro View the page, then click on something and read the summary
```

Delegación para multi-paso:
```
/navegador Log in with user@example.com | password and verify dashboard access
```

Investigación MCP en Claude Code:
```bash
claude mcp add rastro
```

Luego usa las herramientas `rastro` en el panel de herramientas.

## Exportes

```bash
rastro export har [path]        # HTTP Archive 1.2 para cualquier herramienta HAR
rastro export perfetto [path]   # Chrome Trace Event Format para ui.perfetto.dev
rastro export pw-trace [path]   # Playwright trace.zip (si se abrió con --pw-trace)
```

## Usar un perfil de navegador que ya tienes

Por defecto cada sesión tiene su propio perfil. Una sesión puede, en cambio,
usar prestado el perfil de un navegador que ya usas, con sus logins, cookies y
extensiones:

```bash
rastro profiles
rastro -s personal profile use brave-origin:Personal   # por carpeta o por el nombre que muestra el navegador
rastro -s personal open https://mail.example.test
rastro -s personal close                 # devuelve el perfil
rastro -s personal profile use rastro    # vuelve al perfil propio de Rastro
```

`open --profile <ref>` enlaza y abre en un paso. El enlace queda en la sesión,
así que las rutinas que usan esa sesión también lo usan. Navegadores conocidos:
`chromium`, `chrome`, `brave`, `brave-origin`, `edge`, `vivaldi`.

Las escrituras siguen bloqueadas por defecto, y con un perfil prestado es donde
más importa: cada escritura sale con tus cuentas reales. Los hosts en los que
confías se pueden guardar con el enlace, y aplican a cada `open` sin repetirlos:

```bash
rastro -s personal profile use brave-origin:Personal --allow-write youtube.com,google.com
```

Un `open --allow-write` explícito reemplaza la lista guardada en esa ejecución, y
`--allow-write '*'` permite todos los hosts. Volver a enlazar sin
`--allow-write` borra la lista. Solo el CLI la guarda; por MCP, `allowWrite` en
`rastro_open` vale para una ejecución.

**El navegador tiene que estar cerrado antes.** Chromium deja que un solo
proceso use un perfil a la vez. Si el navegador está abierto, `open` falla de
inmediato y lo dice; Rastro nunca lo cierra por ti. Vale en ambos sentidos:
mientras una sesión tiene el perfil, abrir el navegador a mano entrega la
ventana nueva a la instancia de Rastro (headless por defecto). Cierra la sesión
antes de volver a usar el navegador: una sesión con el navegador abierto no se
cierra sola, por mucho que esté inactiva.

Para que el perfil siga siendo tuyo, Rastro lanza el navegador dueño del perfil
(nunca `RASTRO_CHROMIUM`), mantiene el llavero del sistema (sin
`--password-store=basic`), no toca las preferencias del perfil, y respalda
`Sessions/` antes de lanzar y lo restaura al cerrar, para que "continuar donde
lo dejaste" abra tus pestañas y no las de Rastro. Si la sesión muere con
`kill --force`, ese respaldo queda en
`sessions/<nombre>/profile-sessions-backup.prev` en vez de pisar pestañas más
nuevas. Tus pestañas abiertas no aparecen dentro de la sesión de Rastro: parte
en blanco, con tus logins.

## Control de daemons

Cada sesión tiene su daemon. `ps` lo muestra como `rastro[<sesión>]` y su pid
está en `~/.local/share/rastro/sessions/<sesión>/daemon.pid`.

```bash
rastro status                  # running | busy | stopped, por sesión
rastro -s mi-sesion close      # parada limpia (necesita que el daemon responda)
rastro -s mi-sesion kill       # por señal, para un daemon atascado
rastro -s mi-sesion kill --force
```

`busy` no es un fallo: el daemon procesa una petición a la vez, así que durante
una navegación o un flow largo responde `busy` y sigue perfectamente vivo.

## Arquitectura

```
Usuario/Agent
     ↓
CLI (rastro)
     ↓
Daemon local (socket Unix)
     ↓
Playwright + CDP ← Chromium
     ↓
SQLite trace (append-only)
```

Cada sesión tiene su daemon, perfil del navegador y traza persistente.

## Desarrollo

```bash
pnpm test                # suite de tests
pnpm typecheck          # TypeScript
pnpm lint               # Eslint
```

## Licencia

Apache License 2.0. Ver [LICENSE](LICENSE).

Historial de versiones en [CHANGELOG.md](CHANGELOG.md) (en inglés).
Especificaciones normativas en [openspec/specs/](openspec/specs/).
