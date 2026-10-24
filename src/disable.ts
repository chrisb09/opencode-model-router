import { join } from "node:path"

/** Targeted rollback: never restore a whole stale config over newer user edits. */
export function removeInstallation(current: Record<string, any>, manifest: Record<string, any>, original: Record<string, any>) {
  const config = structuredClone(current)
  const warnings: string[] = []
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  config.plugins = (config.plugins ?? []).filter((p: any) => (typeof p === "string" ? p : p.package) !== join(manifest.repo, "plugin"))
  for (const [id, definition] of Object.entries(manifest.agents)) {
    if (equal(config.agents?.[id], definition)) {
      if (original.agents?.[id]) config.agents[id] = original.agents[id]
      else delete config.agents[id]
    } else if (["plan", "build"].includes(id) && config.agents?.[id] && (definition as any).permissions.every((owned: any) => config.agents[id].permissions?.some((r: any) => equal(r, owned)))) {
      // A later manually configured primary model/color must survive disabling
      // routing, without retaining the router's stale delegation allowlist.
      const remaining = [...config.agents[id].permissions]
      for (const owned of (definition as any).permissions) {
        const index = remaining.findIndex(r => equal(r, owned))
        if (index >= 0) remaining.splice(index, 1)
      }
      const restored = [...(original.agents?.[id]?.permissions ?? []), ...remaining]
      if (restored.length) config.agents[id].permissions = restored
      else delete config.agents[id].permissions
    } else warnings.push(`Kept subsequently edited agent: ${id}`)
  }
  if (Object.keys(config.agents ?? {}).length === 0 && !original.agents) delete config.agents
  if (equal(config.mcp?.servers?.["model-router"], manifest.mcp)) delete config.mcp.servers["model-router"]
  else warnings.push("Kept subsequently edited model-router MCP configuration")
  if (config.experimental?.subagent_depth === 1) {
    if (original.experimental?.subagent_depth !== undefined) config.experimental.subagent_depth = original.experimental.subagent_depth
    else delete config.experimental.subagent_depth
    if (Object.keys(config.experimental).length === 0) delete config.experimental
  }
  return { config, warnings }
}
