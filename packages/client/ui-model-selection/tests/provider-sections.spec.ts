import { describe, expect, it } from 'vitest'
import type { ModelCatalogModel, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { providerSections } from '../src/client/provider-sections.ts'

const capabilities = { vision: true, thinking: true, tools: true }
const model = (id: string, name: string): ModelCatalogModel => ({ id, name, capabilities })
const group = (id: string, name: string, names: readonly string[]): ModelProviderGroup => ({
  id, name, models: names.map((name, index) => model(`${id}-${index}`, name)),
})

describe('providerSections', () => {
  it('names and orders priority families by OAuth, API, then OpenRouter', () => {
    const sections = providerSections([
      group('openrouter', 'openrouter', ['Anthropic: Claude 4', 'Anthropic: Claude 5', 'OpenAI: GPT-5', 'OpenAI: GPT-6']),
      group('openai', 'openai', ['GPT-5']),
      group('anthropic', 'anthropic', ['Claude 5']),
      group('anthropic-oauth', 'anthropic-oauth', ['Claude 5']),
    ])
    expect(sections.map(section => section.name)).toEqual([
      'Anthropic: OAuth', 'Anthropic: API', 'Anthropic: OpenRouter',
      'OpenAI: API', 'OpenAI: OpenRouter',
    ])
  })

  it('filters batch and dated snapshots before splitting OpenRouter', () => {
    const [anthropic, openai] = providerSections([group('openrouter', 'openrouter', [
      'Anthropic: Claude Opus 5', 'Anthropic: Claude Sonnet 5', 'Anthropic: Claude Opus 5 (batch)',
      'OpenAI: GPT-4o', 'OpenAI: GPT-4o (2024-05-13)', 'OpenAI: GPT-5',
    ])])
    expect(anthropic?.name).toBe('Anthropic: OpenRouter')
    expect(anthropic?.models.map(entry => entry.name)).toEqual(['Claude Opus 5', 'Claude Sonnet 5'])
    expect(openai?.models.map(entry => entry.name)).toEqual(['GPT 5', 'GPT 4o'])
  })

  it('uses OpenAI Latest names as its explicit latest group without stripping the suffix', () => {
    const [section] = providerSections([group('openrouter', 'openrouter', [
      'OpenAI: GPT Chat Latest', 'OpenAI: GPT Luna Latest', 'OpenAI: GPT Mini Latest',
      'OpenAI: GPT So Latest', 'OpenAI: GPT Terra Latest', 'OpenAI: GPT-6', 'OpenAI: GPT-5.4',
    ])])
    expect(section?.name).toBe('OpenAI: OpenRouter')
    expect(section?.latestCount).toBe(5)
    expect(section?.models.slice(0, 5).map(entry => entry.name)).toEqual([
      'GPT Chat Latest', 'GPT Luna Latest', 'GPT Mini Latest', 'GPT So Latest', 'GPT Terra Latest',
    ])
  })

  it('keeps singleton and unprefixed models in generic OpenRouter while repairing known prefixes', () => {
    const sections = providerSections([group('openrouter', 'openrouter', [
      'Mistral Large', 'Mistral: Small 4', 'Qwen2.5 72B Instruct', 'Qwen: Qwen3 14B',
      'Sao10K: Llama 3.1 Euryale 70B v2.2', 'Reka Edge', 'Auto',
    ])])
    expect(sections.find(section => section.name === 'Mistral: OpenRouter')?.models.map(entry => entry.name))
      .toEqual(['Small 4', 'Large'])
    expect(sections.find(section => section.name === 'Qwen: OpenRouter')?.models.map(entry => entry.name))
      .toEqual(['Qwen 3 14B', 'Qwen 2.5 72B Instruct'])
    expect(sections.at(-1)?.name).toBe('OpenRouter')
    expect(sections.at(-1)?.models.map(entry => entry.name)).toEqual(expect.arrayContaining([
      'Sao10K: Llama 3.1 Euryale 70B v2.2', 'Reka Edge', 'Auto',
    ]))
  })

  it('treats Qwen 3.8 OpenRouter models as latest', () => {
    const sections = providerSections([group('openrouter', 'openrouter', [
      'Qwen: Qwen3.8 14B', 'Qwen: Qwen3.8 32B', 'Qwen: Qwen3.5 72B', 'Qwen: Qwen3 235B',
    ])])
    const qwen = sections.find(section => section.name === 'Qwen: OpenRouter')
    expect(qwen?.models.slice(0, 2).map(entry => entry.name)).toEqual(['Qwen 3.8 14B', 'Qwen 3.8 32B'])
    expect(qwen?.latestCount).toBe(2)
  })


  it('treats the newest GLM minor generation as latest', () => {
    const [section] = providerSections([group('zai', 'zai', [
      'GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-Highspeed', 'GLM-5.2', 'GLM-5.2-Highspeed', 'GLM-5-Turbo', 'GLM-4.7',
    ])])
    expect(section?.models.slice(0, 3).map(entry => entry.name)).toEqual([
      'GLM 5.3', 'GLM 5.3 Flash', 'GLM 5.3-Highspeed',
    ])
    expect(section?.latestCount).toBe(3)
  })

  it('moves free variants to a single group after paid models', () => {
    const sections = providerSections([group('openrouter', 'openrouter', [
      'NVIDIA: Nemotron 3.5 Lightning', 'NVIDIA: Nemotron 3.5 Lightning Free',
      'NVIDIA: Nemotron 3 Super', 'NVIDIA: Nemotron 3 Super Free',
      'NVIDIA: Nemotron 3 Ultra', 'NVIDIA: Nemotron 3 Ultra Free',
    ])])
    const nvidia = sections.find(section => section.name === 'NVIDIA: OpenRouter')
    expect(nvidia?.models.map(entry => entry.name)).toEqual([
      'Nemotron 3.5 Lightning', 'Nemotron 3 Super', 'Nemotron 3 Ultra',
      'Nemotron 3.5 Lightning Free', 'Nemotron 3 Super Free', 'Nemotron 3 Ultra Free',
    ])
  })

  it('groups the newest major generation before a divider and sorts versions descending', () => {
    const [section] = providerSections([group('openai', 'openai', [
      'GPT-5.4', 'GPT-6 Sol', 'GPT-5.6', 'GPT-6 Luna', 'GPT-5.5',
    ])])
    expect(section?.latestCount).toBe(2)
    expect(section?.models.map(entry => entry.name)).toEqual([
      'GPT 6 Luna', 'GPT 6 Sol', 'GPT 5.6', 'GPT 5.5', 'GPT 5.4',
    ])
  })

  it('normalizes zai and preserves remaining family source order', () => {
    const sections = providerSections([
      group('amazon', 'Amazon', ['Nova 2']),
      group('zai', 'zai', ['GLM 5']),
      group('bytedance', 'ByteDance', ['Seed 2']),
    ])
    expect(sections.map(section => section.name)).toEqual(['Z.ai: API', 'Amazon: API', 'ByteDance: API'])
  })
})


describe('Local provider preprocessing', () => {
  it('merges LM Studio and Apple Foundation at the very end and normalizes Apple model name', () => {
    const sections = providerSections([
      group('lmstudio', 'LM Studio', ['qwen3.5-4b']),
      group('anthropic', 'anthropic', ['Claude 5']),
      group('apple-foundation', 'Apple Foundation', ['Apple Foundation (on-device)']),
      group('openrouter', 'openrouter', ['Auto', 'Reka Edge']),
    ])
    expect(sections.map(section => section.name)).toEqual(['Anthropic: API', 'OpenRouter', 'Local'])
    expect(sections.at(-1)?.models.map(entry => entry.name)).toEqual(['qwen3.5-4b', 'Apple Foundation Model'])
  })
})


describe('latest grouping confidence', () => {
  it('drops the distinction when either side has exactly one model', () => {
    const sections = providerSections([{ id: 'provider', name: 'Example', models: [
      model('current', 'Current Latest'), model('older-2', 'Older 2'), model('older-1', 'Older 1'),
    ] }])
    expect(sections[0]?.latestCount).toBe(0)
  })
})
