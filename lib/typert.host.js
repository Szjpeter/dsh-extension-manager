// Typert host manifest for dsh-extension-manager (hand-written, mirroring the
// shape emitted by @deepseek-ai/dsh-typert-generator).
//
// Exporting `./typert` lets @deepseek-ai/dsh-typert-loader register STRICT
// descriptors for every Remote method of the `extensionManager` namespace.
// Every method is a thin `input` JSON seam over the persistence core, so one
// permissive schema pair covers the whole surface.
import { z } from 'zod'

const inputSchema = z.custom(() => true)
const resultSchema = z.custom(() => true)

const methods = [
  'ping',
  'list',
  'getSkill',
  'createSkill',
  'updateSkill',
  'removeSkill',
  'toggleSkill',
  'getMcp',
  'upsertMcp',
  'removeMcp',
  'toggleMcp',
  'probeMcp',
  'checkMcpUpdate',
  'listPlugins',
  'setPluginEnabled',
  'removePlugin',
  'pluginLeftovers',
  'scanOrphanLeftovers',
  'purgePlugin',
  'mcpStatus',
  'getHotReload',
  'setHotReload',
  'precheckPlugin',
  'restoreRemovedPlugin',
  'checkPluginUpdates',
  'updateOnePlugin',
  'getLazy',
  'enableLazy',
  'disableLazy',
  'setServerMode',
  'gitRepos',
  'gitBrowse',
  'gitInstallSkill',
  'gitInstallPlugin',
  'getState',
  'setState',
  'listSidecars',
  'ensureSidecarsNow',
]

export const TYPERT = {
  package: 'dsh-extension-manager',
  face: 'host',
  schemas: [],
  invocations: methods.map((method) => ({
    id: `dsh-extension-manager#extensionManager/${method}`,
    service: 'extensionManager',
    namespace: 'extensionManager',
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'input',
        wire: 'input',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-extension-manager/types#Input',
          schema: inputSchema,
        },
      },
    ],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-extension-manager/types#JsonValue',
      schema: resultSchema,
    },
  })),
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
