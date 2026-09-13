# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/).

## [0.1.0] — 2026-09-13

Primera versión. Rastro nace completo: percepción mínima, traza causal,
investigación a demanda, seguridad para operación desatendida y grabación de
flujos humanos.

### Añadido

**Percepción mínima (el núcleo)**
- `rastro view` muestra solo la superficie interactiva que un humano percibe:
  elementos con `ref` (`e12`), agrupados por región, con las regiones grandes
  colapsadas a un preview + contador. Medido en sitios reales: Hacker News 62
  tokens, `/login` 55, Wikipedia 268.
- Cada acción (`click`, `fill`, `press`, `select`, `goto`…) devuelve **una línea
  de efecto**: `#3 → /dashboard · 1 req (1× 200) · +1 cookie`. El agente no
  recibe la página entera otra vez.
- Construido sobre `page.ariaSnapshot({mode:'ai'})` de `playwright-core` 1.63;
  los refs se resuelven con el selector `aria-ref=eN` y son estables entre
  snapshots del mismo elemento.

**Traza causal de eventos**
- Sesión CDP cruda por página (Playwright descarta el `initiator`) que registra
  requests, respuestas, navegaciones, cookies, consola, diálogos y descargas en
  SQLite append-only (`node:sqlite`, WAL, un DB por sesión, modo 0600).
- **Atribución acción → efecto**, el diferenciador: ventana silenciosa (500 ms,
  tope 5 s) + `initiator` de CDP + detección de ruido de fondo (hosts de
  analytics, stacks de `setInterval` — requiere `Runtime.setAsyncCallStackDepth`
  —, URLs recurrentes por coeficiente de variación < 0.35, ping/beacon).
  Tres cubos: `attributed` / `background` / `unattributed`. **Nada se descarta.**
- Investigación por niveles: `effects <n>` → `request <id> --curl` →
  `snapshot <n> --before` → `trace --action <n>`.
- Cuerpos de respuesta en un `BodyStore` con nombre sha256, fuera de la traza.

**Seguridad para operar sin humano delante**
- **Write guard:** POST/PUT/PATCH/DELETE hacia hosts fuera de `--allow-write` se
  bloquean antes de salir del navegador; cubre redirects 307/308 vía CDP Fetch.
- **Mascarado de secretos** en *todas* las salidas: `--json`, HAR, `pw-trace`,
  snapshots ARIA y aria. Reconoce nombres de campo en inglés, español y
  portugués (`clave`, `contrasena`, `senha`, `codigo`), con stripping de
  diacríticos, y el valor form-urlencoded. `--reveal` desenmascara puntualmente.
- **Contenido de página delimitado en «»** — datos, nunca instrucciones.
- Detección de bloqueos (CAPTCHA, 2FA, bot-block) que reporta `blocked:` y para
  la ejecución automática.
- Sandbox de subida de archivos (`--allow-upload`), descargas a 0600, políticas
  explícitas de diálogos y popups.

**Flujos (fase 2)**
- `rastro record start/stop` graba una sesión humana con navegador visible y la
  guarda como YAML causal (por pestaña, rechazando pasos cross-frame).
- Runner con parámetros, condiciones y aserciones.
- Export a test de Playwright; import desde Chrome DevTools Recorder.

**Integración**
- CLI primero; daemon por sesión sobre socket Unix (JSON por líneas, auto-spawn,
  salida por inactividad).
- Servidor MCP con 10 herramientas y `resource_link` para archivos.
- Plugin de Claude Code: skill `rastro` (≤ 1500 tokens), subagente `navegador`,
  `.mcp.json`.
- Exportes: HAR 1.2, Chrome Trace Event Format (Perfetto/DevTools),
  Playwright `trace.zip`.

### Notas de plataforma

- **La GPU discreta se queda dormida.** `--disable-gpu` por sí solo no impide que
  el proceso GPU de Chromium abra `/dev/nvidiactl`. Rastro apunta el entorno del
  navegador a los vendors no-NVIDIA (`__EGL_VENDOR_LIBRARY_FILENAMES`,
  `VK_ICD_FILENAMES`, `__GLX_VENDOR_LIBRARY_NAME=mesa`, `CUDA_VISIBLE_DEVICES=""`).
  Verificado: 0 descriptores NVIDIA con Wikipedia abierta. Se desactiva con
  `RASTRO_KEEP_GPU_ENV=1`; los valores que ponga el usuario ganan.
- TypeScript ejecutado directamente por Node ≥ 22.5 (type stripping,
  `erasableSyntaxOnly`: sin enums, sin parameter properties, sin namespaces; los
  imports relativos terminan en `.ts`).

### Calidad

- 336 tests en 19 archivos (unitarios, integración y e2e CLI → daemon → motor
  real), `tsc` y `eslint` limpios.
- Una revisión adversarial (20 hallazgos) y una auditoría de seguridad
  (13 hallazgos, 5 altos) corregidas por completo y con test de regresión cada
  una. Los 5 altos eran fugas de secretos por `--json`, snapshots, HAR y
  `pw-trace`.

[0.1.0]: https://github.com/Rixmerz/rastro/releases/tag/v0.1.0
