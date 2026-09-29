/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * While open, ↑/↓ move focus across the rows of the shown pane (wrapping; a
 * step taken while the trigger still holds focus enters at the near end), Tab
 * settles like Enter, and Escape and Shift+Tab leave a drilled pane first and
 * otherwise close back to the trigger. A drilled pane hands focus to the row
 * of the value in use, and returning to the root pane hands it back to the
 * cell that opened it. Data and submission ride the SAME per-session
 * ModelDirectory as the /model popup; exact-model reasoning metadata and the
 * selected effort come from the Host rather than a client-owned vocabulary. A
 * rejected selection announces through the shared transient Toast anchored to
 * the composer card; the in-menu strip with Retry remains the catalog-load
 * surface.
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconApiOutline14, IconDataOutline16, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'
import { modelHasCapability, providerRoute, providerSections, type Capability, type ProviderRoute } from './provider-sections.ts'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }


function RouteIcon({ route, className }: { route: ProviderRoute; className: string | undefined }) {
  if (route === 'local') return <IconDataOutline16 className={className} size={16} />
  if (route === 'oauth') return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.8 17 4.4v4.7c0 4.2-2.7 7.3-7 9.1-4.3-1.8-7-4.9-7-9.1V4.4l7-2.6Z" fill="none" stroke="currentColor" strokeWidth="1.55" /><circle cx="10" cy="7.2" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.8 13.5c.5-2.1 1.6-3.2 3.2-3.2s2.8 1.1 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  if (route === 'openrouter') return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h4M6 10c2.5 0 3-4 5.5-4H17M6 10c2.5 0 3 4 5.5 4H17M14.5 3.5 17 6l-2.5 2.5M14.5 11.5 17 14l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
  return <svg className={className} viewBox="0 0 20 20" aria-hidden="true"><rect x="1.8" y="3" width="16.4" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m7 7-3 3 3 3m6-6 3 3-3 3m-2.2-7.2-1.6 8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<Readonly<Record<string, readonly Capability[]>>>({})
  const sections = useMemo(() => providerSections(state.groups), [state.groups])
  const [pane, setPane] = useState<Pane>('root')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => sections.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [sections])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // A pane switch unmounts the row that had focus, which drops focus onto the
  // page body — outside the card's subtree, where its key handling no longer
  // sees a keystroke. Every switch therefore names where the keyboard lands:
  // drilling on the pane's current value, coming back on the cell that opened
  // the pane left.
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  useEffect(() => {
    const intent = paneFocus.current
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      // The checked row is the value in use; a pane without one opens on its
      // first row.
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? itemRefs.current.find(item => item !== null && !item.disabled)
      // Rows a selection in flight disabled cannot take the keyboard; the
      // trigger does, so the card's keys still reach the menu.
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane])


  // Entering the model pane keeps the current selection visible and centers it
  // when the scroll range permits, making nearby choices in its provider easy to reach.
  useLayoutEffect(() => {
    if (!open || pane !== 'model') return
    const selected = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
    if (typeof selected?.scrollIntoView === 'function') selected.scrollIntoView({ block: 'center' })
  }, [open, pane, sections])

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because pane switches and async catalog loads resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, state])
  /* jscpd:ignore-end */

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const drill = (next: Pane): void => {
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') back(pane)
      else close(true)
      return
    }
    if (!open) return
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root') back(pane)
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) close(true)
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <RouteIcon route={currentChoice === undefined ? 'local' : providerRoute(currentChoice.group)} className={css.routeIcon} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {sections.map((group) => {
                  const headingId = `${id}-${group.id}-${group.sourceIndex}`
                  const active = filters[group.name] ?? (group.latestCount > 0 ? ['latest'] : [])
                  const capabilities = (['free', 'latest', 'vision', 'thinking', 'tools'] as const)
                    .filter(capability => group.models.some(model => modelHasCapability(group, model, capability)))
                  const universal = capabilities.filter(capability => group.models
                    .every(model => modelHasCapability(group, model, capability)))
                  const models = group.models.filter(model => active.every(capability => modelHasCapability(group, model, capability)))
                  const toggle = (capability: Capability): void => {
                    setFilters(current => ({
                      ...current,
                      [group.name]: active.includes(capability)
                        ? active.filter(value => value !== capability)
                        : [...active, capability],
                    }))
                  }
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={`${group.name}-${group.sourceIndex}`}>
                      <div className={css.groupHeader}>
                        <div className={css.groupTitle} id={headingId}><RouteIcon route={providerRoute(group)} className={css.routeIcon} /><span>{group.name.replace(/: (?:OAuth|API|OpenRouter)$/u, '')}</span></div>
                        <div className={css.capabilityFilters} aria-label={`${group.name} capability filters`}>
                          {capabilities.includes('free') && <button type="button" className={clsx(css.capabilityFilter, (active.includes('free') || universal.includes('free')) && css.capabilityFilterActive)} aria-pressed={active.includes('free')} disabled={universal.includes('free')} title="Filter to free models" onMouseDown={(event) => { event.preventDefault() }} onClick={() => { toggle('free') }}><span className={css.freeIcon} aria-hidden="true">$</span></button>}
                          {capabilities.includes('latest') && <button type="button" className={clsx(css.capabilityFilter, active.includes('latest') && css.capabilityFilterActive)} aria-pressed={active.includes('latest')} title="Filter to latest-generation models" onMouseDown={(event) => { event.preventDefault() }} onClick={() => { toggle('latest') }}><svg className={css.capabilitySvg} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.25 9.2 5l3.55-1.75L11 6.8 14.75 8 11 9.2l1.75 3.55L9.2 11 8 14.75 6.8 11l-3.55 1.75L5 9.2 1.25 8 5 6.8 3.25 3.25 6.8 5 8 1.25Z" fill="currentColor" /></svg></button>}
                          {capabilities.includes('vision') && <button type="button" className={clsx(css.capabilityFilter, (active.includes('vision') || universal.includes('vision')) && css.capabilityFilterActive)} aria-pressed={active.includes('vision')} disabled={universal.includes('vision')} title="Filter to models that read images" onMouseDown={(event) => { event.preventDefault() }} onClick={() => { toggle('vision') }}><svg className={css.capabilitySvg} viewBox="0 0 16 16" aria-hidden="true"><path d="M1.2 8s2.5-4 6.8-4 6.8 4 6.8 4-2.5 4-6.8 4-6.8-4-6.8-4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg></button>}
                          {capabilities.includes('thinking') && <button type="button" className={clsx(css.capabilityFilter, (active.includes('thinking') || universal.includes('thinking')) && css.capabilityFilterActive)} aria-pressed={active.includes('thinking')} disabled={universal.includes('thinking')} title="Filter to thinking models" onMouseDown={(event) => { event.preventDefault() }} onClick={() => { toggle('thinking') }}><svg className={css.capabilitySvg} viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 10.1c-1-0.8-1.7-2-1.7-3.4A4.5 4.5 0 0 1 8 2.2a4.5 4.5 0 0 1 4.5 4.5c0 1.4-.7 2.7-1.8 3.5-.5.4-.7.8-.8 1.3H6c-.1-.5-.3-1-.8-1.4Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M6.2 13h3.6M6.8 14.5h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg></button>}
                          {capabilities.includes('tools') && <button type="button" className={clsx(css.capabilityFilter, (active.includes('tools') || universal.includes('tools')) && css.capabilityFilterActive)} aria-pressed={active.includes('tools')} disabled={universal.includes('tools')} title="Filter to models with tool use" onMouseDown={(event) => { event.preventDefault() }} onClick={() => { toggle('tools') }}><IconApiOutline14 size={14} /></button>}
                        </div>
                      </div>
                      {models.map((model, modelIndex) => {
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        return (
                          <div key={model.id}>
                            {group.latestCount > 0 && modelIndex === group.latestCount && <div className={css.latestDivider} />}
                            {modelIndex > group.latestCount && model.name.endsWith(' Free') && !models[modelIndex - 1]?.name.endsWith(' Free') && <div className={css.latestDivider} />}
                            {modelIndex > group.latestCount && /Router|^Auto$/u.test(model.name) && !/Router|^Auto$/u.test(models[modelIndex - 1]?.name ?? '') && <div className={css.latestDivider} />}
                            <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={selected} className={clsx(css.option, selected && css.selected)} title={model.name} disabled={busy} onClick={() => { choose({ provider: group.id, model: model.id }) }}>
                              <span className={css.optionCopy}><span className={css.modelName}>{group.name.startsWith('Anthropic:') ? model.name.replace(/^Claude /u, '') : model.name}</span></span>
                              <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                            </button>
                          </div>
                        )
                      })}
                      {models.length === 0 && <div className={css.filteredEmpty}>No models match these capabilities.</div>}
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
