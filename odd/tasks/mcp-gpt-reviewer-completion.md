# Reviewer MCP-GPT: identidad de transporte y completion independiente

R2×M. Cambio local de integración; no altera contratos de Facts ni captura resultados
en un repositorio real. La revisión queda consultiva, sin firmas o aislamiento SHS A/V
acreditados; requiere revisión humana antes de merge.

## Causa y decisión

`runInProcessReviewer` conservaba la sesión padre sólo en atribución OpenCode, pero
omitía la identidad exigida por el provider MCP-GPT. El fallo antes del transporte
parecía infraestructura incierta. Además, el adapter MCP-GPT confundía una completion
tool-free con el resumen de compactación.

Cada llamada recibe un UUID privado, `cacheRetention: none` y `toolChoice: none`.
Esto no crea un Agent ni historial retenido del reviewer. El prompt congelado sigue
siendo un mensaje user sin herramientas. Se conservan auth y atribución padre OpenCode,
las negativas tipadas, cancelación y presupuesto del reviewer. El provider compuesto
sigue siendo obligatorio cuando lo expone el registry; no hay fallback builtin nuevo.

El adapter opcional del proyecto hermano `mcp-gpt` admite completion explícita con
texto opaco/nonce y cleanup one-shot. Un veredicto JSON no ejecuta tools Pi, no se
resume y no mueve la sesión principal. Es necesario actualizar ambas capas.

## Pruebas y uso

El RED integrado usa el reviewer real + ModelRegistry Pi + servidor MCP: faltaba
la identidad y el resultado era refused. Un RED independiente del adapter mostraba
el resumen en lugar del veredicto. Las pruebas de headers y provider siguen vigentes.

```bash
node --experimental-strip-types --test tests/inprocess-reviewer.test.ts \
  tests/review-host-relay.test.ts tests/review-host-relay-routing.test.ts \
  tests/review-host-relay-restart-parity.test.ts \
  tests/review-relay-transport-agent.test.ts tests/review-relay-contract.test.ts
bun run typecheck
bun run check:runtime-modules
```

La prueba opt-in en `mcp-gpt/integrations/pi/smoke/gentle-reviewer-electron.test.ts`
cruza Electron real, write nativo Pi, ocho reviewers, resumen concurrente y continuidad.
Sólo el endpoint auth y GPT son localhost fixtures; no acredita veredictos de la cuenta.
Evidencia detallada: proyecto hermano `mcp-gpt/docs/PI-AGENT-EVIDENCE.md`, sección S5-N.

Reiniciar Gentle una vez, desde el mismo cwd del historial, con `gentle-shell --continue`.
Puede conservarse Electron. `/reload` no reemplaza el provider ya cargado. Pedir STATUS
fresco y sólo usar el binding vigente antes de una revisión explícita; no inferir
aprobación ni borrar un fence de agente a partir de reportes anteriores.
