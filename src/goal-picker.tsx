import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search, Target, X } from 'lucide-react'
import type { Goal, Horizon } from './domain'

export const GOAL_PICKER_HORIZONS: readonly Horizon[] = ['1M', '3M', '6M', '1Y', '2Y']

const horizonLabels: Record<Horizon, string> = {
  '1M': '1 month',
  '3M': '3 months',
  '6M': '6 months',
  '1Y': '1 year',
  '2Y': '2 years',
}

export type GoalPickerGroup = {
  horizon: Horizon
  label: string
  goals: Goal[]
}

const compareText = (left: string, right: string) => left === right ? 0 : left < right ? -1 : 1

export function sortGoalsForPicker(goals: readonly Goal[], prioritizedGoalIds: readonly string[] = []) {
  const priority = new Map(prioritizedGoalIds.map((id, index) => [id, index]))
  return [...goals].sort((left, right) => {
    const leftPriority = priority.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightPriority = priority.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftPriority - rightPriority
      || Number(left.status !== 'active') - Number(right.status !== 'active')
      || compareText(left.deadline, right.deadline)
      || compareText(left.createdAt, right.createdAt)
      || compareText(left.title.trim().toLowerCase(), right.title.trim().toLowerCase())
      || compareText(left.id, right.id)
  })
}

export function groupGoalsForPicker(
  goals: readonly Goal[],
  options: {
    query?: string
    showInactive?: boolean
    prioritizedGoalIds?: readonly string[]
  } = {},
): GoalPickerGroup[] {
  const query = options.query?.trim().toLowerCase() ?? ''
  const eligible = goals.filter(goal =>
    (options.showInactive || goal.status === 'active')
    && (!query || goal.title.toLowerCase().includes(query)),
  )

  return GOAL_PICKER_HORIZONS.flatMap(horizon => {
    const matching = sortGoalsForPicker(
      eligible.filter(goal => goal.horizon === horizon),
      options.prioritizedGoalIds,
    )
    return matching.length ? [{ horizon, label: horizonLabels[horizon], goals: matching }] : []
  })
}

export type GoalPickerProps = {
  goals: readonly Goal[]
  value?: string
  onChange: (goalId: string | undefined) => void
  label?: string
  placeholder?: string
  prioritizedGoalIds?: readonly string[]
  suggestedGoalId?: string
  allowClear?: boolean
  disabled?: boolean
  required?: boolean
  id?: string
}

export function GoalPicker({
  goals,
  value,
  onChange,
  label = 'Related goal',
  placeholder = 'Choose related goal',
  prioritizedGoalIds = [],
  suggestedGoalId,
  allowClear = true,
  disabled = false,
  required = false,
  id,
}: GoalPickerProps) {
  const generatedId = useId()
  const fieldId = id ?? `goal-picker-${generatedId}`
  const headingId = `${fieldId}-heading`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedGoal = goals.find(goal => goal.id === value)
  const inactiveCount = goals.filter(goal => goal.status !== 'active').length

  const groups = useMemo(() => groupGoalsForPicker(goals, {
    query,
    showInactive,
    prioritizedGoalIds,
  }), [goals, prioritizedGoalIds, query, showInactive])

  const suggestedGoal = suggestedGoalId
    ? groups.flatMap(group => group.goals).find(goal => goal.id === suggestedGoalId)
    : undefined
  const visibleGroups = suggestedGoal
    ? groups.map(group => ({ ...group, goals: group.goals.filter(goal => goal.id !== suggestedGoal.id) })).filter(group => group.goals.length)
    : groups

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const choose = (goalId: string | undefined) => {
    onChange(goalId)
    close()
  }

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter(element => element.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return <div className="momentum-goal-picker">
    <span className="momentum-goal-picker__label" id={`${fieldId}-label`}>{label}</span>
    <button
      aria-controls={open ? `${fieldId}-dialog` : undefined}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-labelledby={`${fieldId}-label ${fieldId}-value`}
      aria-required={required}
      className="momentum-goal-picker__trigger"
      disabled={disabled}
      id={fieldId}
      onClick={() => {
        setQuery('')
        setShowInactive(false)
        setOpen(true)
      }}
      ref={triggerRef}
      type="button"
    >
      <span id={`${fieldId}-value`}>
        <b>{selectedGoal?.title || placeholder}</b>
        {selectedGoal && <small>{horizonLabels[selectedGoal.horizon]}{selectedGoal.status !== 'active' ? ` · ${selectedGoal.status}` : ''}</small>}
      </span>
      <ChevronDown aria-hidden="true" size={17}/>
    </button>

    {open && <div
      className="momentum-goal-picker__layer"
      onPointerDown={event => event.target === event.currentTarget && close()}
    >
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="momentum-goal-picker__dialog"
        id={`${fieldId}-dialog`}
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="momentum-goal-picker__header">
          <div>
            <span>RELATED GOAL</span>
            <h2 id={headingId}>Choose related goal</h2>
          </div>
          <button aria-label="Cancel goal selection" onClick={close} type="button"><X size={18}/></button>
        </header>

        <label className="momentum-goal-picker__search">
          <Search aria-hidden="true" size={17}/>
          <span className="momentum-goal-picker__sr-only">Search goals</span>
          <input
            autoComplete="off"
            onChange={event => setQuery(event.target.value)}
            placeholder="Search goals"
            ref={searchRef}
            type="search"
            value={query}
          />
          {query && <button aria-label="Clear goal search" onClick={() => setQuery('')} type="button"><X size={15}/></button>}
        </label>

        <div className="momentum-goal-picker__results">
          {suggestedGoal && <section aria-labelledby={`${fieldId}-suggested`}>
            <h3 id={`${fieldId}-suggested`}>Suggested</h3>
            <GoalChoice goal={suggestedGoal} selected={suggestedGoal.id === value} onChoose={choose}/>
          </section>}

          {visibleGroups.map(group => <section aria-labelledby={`${fieldId}-${group.horizon}`} key={group.horizon}>
            <h3 id={`${fieldId}-${group.horizon}`}>{group.label}</h3>
            {group.goals.map(goal => <GoalChoice goal={goal} key={goal.id} selected={goal.id === value} onChoose={choose}/>) }
          </section>)}

          {!suggestedGoal && !visibleGroups.length && <div className="momentum-goal-picker__empty">
            <Target aria-hidden="true" size={21}/>
            <b>{query ? 'No matching goals' : 'No goals available'}</b>
            <small>{query ? 'Try another search.' : showInactive ? 'There are no saved goals.' : 'Show inactive goals or create a new goal.'}</small>
          </div>}
        </div>

        <footer className="momentum-goal-picker__footer">
          {inactiveCount > 0 && <button aria-pressed={showInactive} onClick={() => setShowInactive(current => !current)} type="button">
            {showInactive ? 'Hide inactive goals' : `Show inactive goals (${inactiveCount})`}
          </button>}
          {allowClear && value && <button className="momentum-goal-picker__clear" onClick={() => choose(undefined)} type="button">Remove relationship</button>}
          <button onClick={close} type="button">Cancel</button>
        </footer>
      </div>
    </div>}
  </div>
}

function GoalChoice({ goal, selected, onChoose }: { goal: Goal; selected: boolean; onChoose: (id: string) => void }) {
  return <button
    aria-pressed={selected}
    className={`momentum-goal-picker__choice${selected ? ' is-selected' : ''}`}
    onClick={() => onChoose(goal.id)}
    type="button"
  >
    <span aria-hidden="true" className="momentum-goal-picker__choice-mark">{selected ? <Check size={14}/> : null}</span>
    <span>
      <b>{goal.title}</b>
      {goal.status !== 'active' && <small>{goal.status}</small>}
    </span>
  </button>
}
