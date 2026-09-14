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
| Navegador | Chromium (`playwright-core`) | multi | Chrome | multi | Chromium |

Los dos diferenciadores reales son la **atribución causal** (ninguna otra
herramienta te dice "este click disparó estas 4 peticiones, esta cookie y esta
navegación", consultable a mitad de tarea) y el **resumen de efecto en una
línea**, que evita volcar la página entera tras cada acción.

Dónde Rastro **no** es la respuesta: no tiene visión, así que una página que solo
se entiende por píxeles es terreno de `browser-use`; es solo Chromium; y es
nuevo, frente a la adopción que ya tiene Playwright MCP.

## Instalación

Requisitos: Node.js ≥ 22.5, Chromium instalado en el sistema (`/usr/bin/chromium` por defecto).

```bash
pnpm install
pnpm link --global
# o: npm i -g .
```

Variables de entorno (opcionales):
- `RASTRO_CHROMIUM` — ruta a Chromium (default `/usr/bin/chromium`)
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

```bash
rastro open https://api.example.test --allow-write example.test,api.example.test
```

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
