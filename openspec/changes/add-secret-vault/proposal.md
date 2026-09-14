# Bóveda de secretos y hogar por defecto para los flows

## Why

Hoy un flow que necesita una contraseña obliga al usuario a ponerla en la línea
de comandos (`rastro fill e19 "$(cat archivo)" --secret`). Eso tiene tres
problemas: la fricción de inventar un archivo por cada credencial, el valor
acaba en el historial del shell o en la transcripción de la sesión, y el flow
no es reutilizable porque lleva la ruta del archivo dentro.

En paralelo, `rastro flow save` exige una ruta explícita, así que no hay ningún
sitio donde los flows se acumulen. Cada uno acaba en el directorio desde el que
se corrió el comando y no se vuelve a encontrar.

Las dos cosas bloquean lo mismo: reejecutar un flujo conocido sin volver a
armarlo a mano.

## What Changes

- Se añade una **bóveda** de secretos con nombre, respaldada por el keyring del
  sistema (libsecret vía `secret-tool`), compartida por todas las sesiones:
  `rastro secret set|list|rm`. `set` pide el valor sin eco por la terminal; si
  no hay terminal, abre una.
- **No hay `rastro secret get`.** El valor solo lo lee el daemon al ejecutar.
- Los parámetros de un flow aceptan la referencia `secret:<nombre>`, que el
  daemon resuelve contra la bóveda. El valor nunca pasa por `argv`.
- `rastro flow save|run` aceptan un **nombre pelado** además de una ruta, y lo
  resuelven contra `./.rastro/flows/` y luego `~/.config/rastro/flows/`.

## Impact

- Affected specs: `write-safety` (bóveda y no-`get`), `flow-recording`
  (referencia `secret:` y hogar de los flows).
- Affected code: `src/security/vault.ts` (nuevo), `src/cli/prompt.ts` (nuevo),
  `src/core/paths.ts`, `src/cli/main.ts`, `src/flow/format.ts`,
  `src/engine/flows.ts`.
- Nueva dependencia de entorno: el binario `secret-tool` y un keyring
  desbloqueado. Sin él, los comandos de bóveda fallan con una pista; el resto
  de Rastro sigue igual.
- Modelo de amenaza: con el keyring desbloqueado, cualquier proceso de la
  sesión del usuario puede leer estos valores, igual que las contraseñas
  guardadas del navegador. Es aceptable y queda documentado.
