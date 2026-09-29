import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'

export type Capability = keyof ModelCatalogModel['capabilities'] | 'free' | 'latest'
export interface ModelSection extends ModelProviderGroup {
  readonly sourceIndex: number
  readonly latestCount: number
}


function stableLatestCount(modelCount: number, latestCount: number): number {
  const historicalCount = modelCount - latestCount
  return latestCount === 1 || historicalCount === 1 ? 0 : latestCount
}


export type ProviderRoute = 'oauth' | 'api' | 'openrouter' | 'local'

export function providerRoute(section: Pick<ModelProviderGroup, 'id' | 'name'>): ProviderRoute {
  if (section.name === 'Local') return 'local'
  const value = `${section.id} ${section.name}`.toLocaleLowerCase()
  if (value.includes('openrouter')) return 'openrouter'
  if (value.includes('oauth')) return 'oauth'
  return 'api'
}


export function modelHasCapability(section: ModelSection, model: ModelCatalogModel, capability: Capability): boolean {
  if (capability === 'free') return freeModel(model.name)
  if (capability === 'latest') return section.latestCount > 0 && section.models.indexOf(model) < section.latestCount
  // Cached catalogs from before capability metadata was introduced may omit it.
  return (model as Partial<ModelCatalogModel>).capabilities?.[capability] ?? false
}

const PRIORITY = ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Z.ai', 'Qwen'] as const
const ROUTE_ORDER = { OAuth: 0, API: 1, OpenRouter: 2 } as const
const dated = /(?:\(\d{4}-\d{2}-\d{2}\)|\s\d{4}-\d{2}-\d{2})$/u
const batch = /\s\(batch\)$/iu
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function titleCaseRoute(value: string): string {
  const normalized = value.toLocaleLowerCase()
  const names: Record<string, string> = {
    anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek',
    zai: 'Z.ai', 'z.ai': 'Z.ai', qwen: 'Qwen', openrouter: 'OpenRouter',
  }
  return names[normalized] ?? value.replace(/\b\w/gu, letter => letter.toLocaleUpperCase())
}

function routeKind(group: ModelProviderGroup): 'OAuth' | 'API' | 'OpenRouter' {
  const route = providerRoute(group)
  if (route === 'openrouter') return 'OpenRouter'
  if (route === 'oauth') return 'OAuth'
  return 'API'
}

function familyName(group: ModelProviderGroup): string {
  const routeSuffix = /(?:[-\s:]\s*)(?:oauth|api|openrouter)$/iu
  return titleCaseRoute(group.name.replace(routeSuffix, ''))
}


function isLocalGroup(group: ModelProviderGroup): boolean {
  const value = `${group.id} ${group.name}`.toLocaleLowerCase()
  return value.includes('lmstudio') || value.includes('lm studio') || value.includes('apple foundation')
}

function localModels(group: ModelProviderGroup): readonly ModelCatalogModel[] {
  return group.models.map(model => ({
    ...model,
    name: model.name === 'Apple Foundation (on-device)' ? 'Apple Foundation Model' : model.name,
  }))
}

function version(name: string): readonly number[] {
  const match = /(?:^|\D)(\d+(?:\.\d+)+|\d+)(?!\w)/u.exec(name)
  return match?.[1]?.split('.').map(Number) ?? []
}

function generation(name: string, family?: string): readonly number[] {
  const value = version(name)
  return family === 'Qwen' || family === 'Z.ai' ? value.slice(0, 2) : value.slice(0, 1)
}

function sameGeneration(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function namedLatest(name: string): boolean { return /(?:\s\(latest\)|\sLatest)$/iu.test(name) }
function normalizeName(name: string): string {
  return name.trim()
    .replace(/\s+\((free|latest)\)$/iu, (_, designation: string) => ` ${designation[0]?.toLocaleUpperCase()}${designation.slice(1)}`)
    .replace(/^DeepSeek-V41-Flash$/u, 'DeepSeek 4.1 Flash')
    .replace(/^DeepSeek-V(\d+(?:\.\d+)?)-(.+)$/u, 'DeepSeek $1 $2')
    .replace(/^DeepSeek V(\d)/u, 'DeepSeek $1')
    .replace(/^GLM-(\d)/u, 'GLM $1')
    .replace(/^(GLM \d+(?:\.\d+)?)V\b/u, '$1 Vision')
    .replace(/^GPT-(\d)/u, 'GPT $1')
    .replace(/^GPT-(Realtime)/u, 'GPT $1')
    .replace(/^gpt-oss-/iu, 'GPT OSS ')
    .replace(/^o([134])(?!\d)/u, 'GPT o$1')
    .replace(/-mini\b/giu, ' Mini')
    .replace(/-nano\b/giu, ' Nano')
    .replace(/-(Codex|Max|Pro|Turbo|Flash)\b/gu, ' $1')
    .replace(/\bmini\b/gu, 'Mini')
    .replace(/\bnano\b/gu, 'Nano')
    .replace(/\bpro\b/gu, 'Pro')
    .replace(/^GPT o4 Mini$/u, 'GPT o4')
    .replace(/^GPT OSS safeguard-/iu, 'GPT OSS Safeguard ')
    .replace(/^Aion-(\d)/u, 'Aion $1')
    .replace(/^Seed-(\d)/u, 'Seed $1')
    .replace(/^Nex-N/u, 'Nex ')
    .replace(/^MiMo-V(\d)/u, 'MiMo $1')
    .replace(/-VL\b/gu, ' Vision')
    .replace(/\bVL\b/gu, 'Vision')
    .replace(/\bpreview\b/giu, 'Preview')
    .replace(/-V(\d)/gu, ' $1')
    .replace(/\bQwen(\d)/gu, 'Qwen $1')
    .replace(/\bQwen-(Plus)\b/gu, 'Qwen $1')
    .replace(/(Qwen \d+(?:\.\d+)?)-/gu, '$1 ')
    .replace(/-(\d+[Bb])-/gu, ' $1 ')
    .replace(/-(A\d+[Bb])\b/gu, ' $1')
    .replace(/\s{2,}/gu, ' ')
    .replace(/^(GPT o\d)-/u, '$1 ')
}
function freeModel(name: string): boolean { return /(?:\s\(free\)|\sFree)$/iu.test(name) }

function sortedModels(
  models: readonly ModelCatalogModel[],
  preserveNamedLatest = false,
  family?: string,
): { models: readonly ModelCatalogModel[]; latestCount: number } {
  const explicitlyLatest = models.filter(model => namedLatest(model.name))
  const normalizedForGeneration = models.filter(model => !/\s\d{4}$/u.test(model.name))
  const openAiApiLatest = preserveNamedLatest && models.some(model => model.name === 'GPT-6 Astra')
    ? models.filter(model => /^(?:GPT-6 (?:Astra|Luna|Sol)|GPT-5(?:\.3)? Chat)/u.test(model.name))
    : []
  const cleaned = models.map(model => ({ ...model, name: normalizeName(model.name) }))
  const generations = normalizedForGeneration.map(model => generation(normalizeName(model.name), family))
    .filter(value => value.length > 0)
  const newest = generations.sort((left, right) => {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const delta = (right[index] ?? 0) - (left[index] ?? 0)
      if (delta !== 0) return delta
    }
    return 0
  })[0]
  const sorted = [...cleaned].sort((left, right) => {
    const a = version(left.name); const b = version(right.name)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const delta = (b[index] ?? 0) - (a[index] ?? 0)
      if (delta !== 0) return delta
    }
    return collator.compare(left.name, right.name)
  })
  const selectedLatest = openAiApiLatest.length > 0 ? openAiApiLatest : explicitlyLatest
  const latestIds = new Set(selectedLatest.map(model => model.id))
  const latestCandidates = selectedLatest.length > 0
    ? sorted.filter(model => latestIds.has(model.id))
    : newest === undefined ? [] : sorted.filter(model => (
      sameGeneration(generation(model.name, family), newest) && !/\s\d{4}$/u.test(model.name)
    ))
  const latest = latestCandidates.filter(model => !freeModel(model.name))
  const regular = sorted.filter(model => !latestCandidates.includes(model) && !freeModel(model.name) && !/Router|^Auto$/u.test(model.name))
  const free = sorted.filter(model => freeModel(model.name))
  const routers = sorted.filter(model => !latestCandidates.includes(model) && !freeModel(model.name) && /Router|^Auto$/u.test(model.name))
  const ordered = [...latest, ...regular, ...free, ...routers]
  return {
    models: ordered,
    latestCount: latest.length > 0 && regular.length + free.length + routers.length > 0 ? latest.length : 0,
  }
}

function openRouterFamily(name: string): { family: string; modelName: string } | undefined {
  if (name === 'Mistral Large') return { family: 'Mistral', modelName: 'Large' }
  if (name.startsWith('Qwen2.5 ')) return { family: 'Qwen', modelName: name }
  const match = /^([^:]+):\s+(.+)$/u.exec(name)
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { family: titleCaseRoute(match[1]), modelName: match[2] }
}

function splitOpenRouter(group: ModelProviderGroup, sourceIndex: number): ModelSection[] {
  const visible = group.models.filter(model => (
    !batch.test(model.name)
    && !dated.test(model.name)
    && model.name !== 'OpenAI: GPT-3.5 Turbo (older v0613)'
    && model.name !== 'Anthropic: Claude 3 Haiku'
    && model.name !== 'DeepSeek: R1'
    && model.name !== 'DeepSeek: R1 0528'
  ))
  const parsed = visible.map(model => ({ model, parsed: openRouterFamily(model.name) }))
  const counts = new Map<string, number>()
  for (const entry of parsed) if (entry.parsed !== undefined) counts.set(entry.parsed.family, (counts.get(entry.parsed.family) ?? 0) + 1)
  const families = new Map<string, ModelCatalogModel[]>()
  const remainder: ModelCatalogModel[] = []
  for (const entry of parsed) {
    if (entry.parsed === undefined || (counts.get(entry.parsed.family) ?? 0) < 2) remainder.push(entry.model)
    else {
      const list = families.get(entry.parsed.family) ?? []
      list.push({ ...entry.model, name: entry.parsed.modelName })
      families.set(entry.parsed.family, list)
    }
  }
  const sections = [...families].map(([family, models], familyIndex): ModelSection => {
    const sorted = sortedModels(models, false, family)
    return { id: group.id, name: `${family}: OpenRouter`, models: sorted.models, latestCount: stableLatestCount(sorted.models.length, sorted.latestCount), sourceIndex: sourceIndex * 1000 + familyIndex }
  })
  if (remainder.length > 0) {
    const sorted = sortedModels(remainder)
    sections.push({ id: group.id, name: 'OpenRouter', models: sorted.models, latestCount: 0, sourceIndex: sourceIndex * 1000 + 999 })
  }
  return sections
}

export function providerSections(groups: readonly ModelProviderGroup[]): readonly ModelSection[] {
  const local = groups.flatMap(group => isLocalGroup(group) ? localModels(group) : [])
  const sourceGroups = groups.filter(group => !isLocalGroup(group))
  const sections = sourceGroups.flatMap((group, sourceIndex): ModelSection[] => {
    if (routeKind(group) === 'OpenRouter') return splitOpenRouter(group, sourceIndex)
    const family = familyName(group); const kind = routeKind(group)
    const sorted = sortedModels(
      group.models.filter(model => !batch.test(model.name) && !dated.test(model.name)),
      family === 'OpenAI' && kind === 'API',
      family,
    )
    return [{ ...group, name: `${family}: ${kind}`, models: sorted.models, latestCount: stableLatestCount(sorted.models.length, sorted.latestCount), sourceIndex }]
  })
  if (local.length > 0) {
    const sorted = sortedModels(local)
    sections.push({ id: 'local', name: 'Local', models: sorted.models, latestCount: 0, sourceIndex: Number.MAX_SAFE_INTEGER })
  }
  return sections.sort((left, right) => {
    if (left.name === 'Local') return 1
    if (right.name === 'Local') return -1
    if (left.name === 'OpenRouter') return 1
    if (right.name === 'OpenRouter') return -1
    const leftFamily = left.name.split(':')[0] ?? left.name
    const rightFamily = right.name.split(':')[0] ?? right.name
    const leftPriority = PRIORITY.indexOf(leftFamily as typeof PRIORITY[number])
    const rightPriority = PRIORITY.indexOf(rightFamily as typeof PRIORITY[number])
    const lp = leftPriority === -1 ? PRIORITY.length : leftPriority
    const rp = rightPriority === -1 ? PRIORITY.length : rightPriority
    if (lp !== rp) return lp - rp
    if (leftFamily === rightFamily) {
      const leftKind = left.name.split(': ').at(-1) as keyof typeof ROUTE_ORDER
      const rightKind = right.name.split(': ').at(-1) as keyof typeof ROUTE_ORDER
      return ROUTE_ORDER[leftKind] - ROUTE_ORDER[rightKind]
    }
    return left.sourceIndex - right.sourceIndex
  })
}
