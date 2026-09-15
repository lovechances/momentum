import { describe, expect, it } from 'vitest'
import type { Goal, Task } from './domain'
import { groupGoalsForPicker, sortGoalsForPicker } from './goal-picker'
import { classifyTaskGesture, shouldRevealTaskAction, taskRowActionOrder } from './task-row'

const goal = (id: string, horizon: Goal['horizon'], patch: Partial<Goal> = {}): Goal => ({
  id,
  title: id,
  horizon,
  kind: 'qualitative',
  deadline: '2026-10-01',
  status: 'active',
  color: 'sky',
  milestones: [],
  links: [],
  history: [],
  evidenceSchedules: [],
  createdAt: '2026-09-01T12:00:00.000Z',
  ...patch,
})

const task = (patch: Partial<Task> = {}): Task => ({
  id: 'task',
  title: 'Do the next thing',
  section: 'Day',
  done: false,
  kind: 'task',
  dueDate: '2026-09-15',
  createdAt: '2026-09-15T12:00:00.000Z',
  carriedCount: 0,
  ...patch,
})

describe('goal picker helpers', () => {
  it('groups active goals by horizon and excludes inactive goals by default', () => {
    const groups = groupGoalsForPicker([
      goal('far', '2Y'),
      goal('near', '1M'),
      goal('paused', '1M', { status: 'paused' }),
      goal('middle', '6M'),
    ])
    expect(groups.map(group => [group.horizon, group.goals.map(item => item.id)])).toEqual([
      ['1M', ['near']],
      ['6M', ['middle']],
      ['2Y', ['far']],
    ])
    expect(groupGoalsForPicker([goal('paused', '1M', { status: 'paused' })], { showInactive: true })[0].goals[0].id).toBe('paused')
  })

  it('puts prioritized goals first, then uses deadline, creation time, title, and id deterministically', () => {
    const values = [
      goal('later', '1M', { deadline: '2026-11-01' }),
      goal('beta', '1M', { title: 'Beta', createdAt: '2026-09-02T12:00:00.000Z' }),
      goal('alpha-2', '1M', { title: 'Alpha', createdAt: '2026-09-02T12:00:00.000Z' }),
      goal('alpha-1', '1M', { title: 'Alpha', createdAt: '2026-09-02T12:00:00.000Z' }),
      goal('recent', '1M', { deadline: '2027-01-01' }),
    ]
    expect(sortGoalsForPicker(values, ['recent']).map(item => item.id)).toEqual(['recent', 'alpha-1', 'alpha-2', 'beta', 'later'])
  })

  it('places a newly supplied 1M goal in its section immediately and filters search by title', () => {
    const goals = [goal('one-year', '1Y', { title: 'Build audience' })]
    expect(groupGoalsForPicker([...goals, goal('new', '1M', { title: 'Finish Buyee' })])[0]).toMatchObject({
      horizon: '1M',
      goals: [{ id: 'new' }],
    })
    expect(groupGoalsForPicker([
      goal('weight', '1M', { title: 'Reach 150 lbs' }),
      goal('savings', '3M', { title: '$10k stacked' }),
    ], { query: 'STACK' }).flatMap(group => group.goals).map(item => item.id)).toEqual(['savings'])
  })
})

describe('task row helpers', () => {
  it('keeps small motion pending, treats vertical movement as scroll, and recognizes horizontal intent', () => {
    expect(classifyTaskGesture(3, 4)).toBe('pending')
    expect(classifyTaskGesture(8, 22)).toBe('scroll')
    expect(classifyTaskGesture(-28, 7)).toBe('swipe')
    expect(classifyTaskGesture(28, 7)).toBe('swipe')
  })

  it('reveals the destructive action only after a deliberate swipe threshold', () => {
    expect(shouldRevealTaskAction(-20)).toBe(false)
    expect(shouldRevealTaskAction(-42)).toBe(true)
  })

  it('exposes ordinary and recurring action sets without mutating task data', () => {
    const oneOff = task()
    const recurring = task({ kind: 'routine', sourceRoutineId: 'routine-1' })
    expect(taskRowActionOrder(oneOff)).toEqual(['edit', 'delete'])
    expect(taskRowActionOrder(recurring)).toEqual(['edit', 'remove-today', 'edit-routine', 'stop-routine'])
    expect(recurring).toMatchObject({ done: false, sourceRoutineId: 'routine-1' })
  })
})
