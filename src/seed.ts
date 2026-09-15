import type { AppData, Goal, GoalKind, Horizon, Routine } from './domain'
import { deadlineFor } from './goals'
import { now } from './domain'

const goalSeed: Array<[string, Horizon, string | undefined, GoalKind, 'active' | 'completed']> = [
  ['140 lbs clean', '1M', 'Body', 'numeric', 'active'],
  ['Finish Buyee', '1M', 'Business', 'binary', 'active'],
  ['Next project / business started', '1M', 'Business', 'milestone', 'active'],
  ['$7k stacked', '1M', 'Money', 'numeric', 'active'],
  ['Progress Tracker app — completed', '1M', 'Business', 'binary', 'completed'],
  ['$10k stacked', '3M', 'Money', 'numeric', 'active'],
  ['150 lbs clean', '3M', 'Body', 'numeric', 'active'],
  ['First profit from business', '3M', 'Business', 'milestone', 'active'],
  ['Contacts', '3M', 'Life', 'qualitative', 'active'],
  ['$20k stacked', '6M', 'Money', 'numeric', 'active'],
  ['Start content', '6M', 'Business', 'consistency', 'active'],
  ['170 lbs clean', '6M', 'Body', 'numeric', 'active'],
  ['$5k/mo+ online', '1Y', 'Business', 'numeric', 'active'],
  ['10k+ on platforms', '1Y', 'Business', 'numeric', 'active'],
  ['One solid mentor', '1Y', 'Life', 'qualitative', 'active'],
  ['175–185 lbs clean', '1Y', 'Body', 'numeric', 'active'],
  ['Personal brand reputable', '2Y', 'Business', 'qualitative', 'active'],
  ['Location freedom', '2Y', 'Life', 'qualitative', 'active'],
  ['Sports car in cash', '2Y', 'Money', 'milestone', 'active'],
]

const targetFromTitle = (title: string) => {
  if (title === '$7k stacked') return 7_000
  if (title === '$10k stacked') return 10_000
  if (title === '$20k stacked') return 20_000
  if (title === '$5k/mo+ online') return 5_000
  if (title === '10k+ on platforms') return 10_000
  if (title === '140 lbs clean') return 140
  if (title === '150 lbs clean') return 150
  if (title === '170 lbs clean') return 170
  return undefined
}

export function seededGoals(createdAt = new Date()): Goal[] {
  const created = createdAt.toISOString()
  return goalSeed.map(([title, horizon, area, kind, status], index) => {
    const target = targetFromTitle(title)
    const id = `seed-goal-${index + 1}`
    return {
      id,
      title,
      horizon,
      kind,
      area,
      target,
      unit: title.includes('lbs') ? 'lbs' : title.startsWith('$') ? 'USD' : title === '10k+ on platforms' ? 'followers' : undefined,
      deadline: deadlineFor(horizon, createdAt),
      status,
      color: area === 'Body' ? 'lime' : area === 'Money' ? 'gold' : area === 'Business' ? 'violet' : 'sky',
      milestones: [],
      links: [],
      // A locked seed may already be complete, but its actual completion date is
      // unknown. Keep the status without inventing a completion event for Recap.
      history: [{ at: created, action: 'created', target, deadline: deadlineFor(horizon, createdAt) }],
      evidenceSchedules: kind === 'numeric' && area === 'Body'
        ? [{ id: `${id}-number`, kind: 'number', cadence: 'weekly', active: true }, { id: `${id}-photo`, kind: 'photo', cadence: 'monthly', active: true }]
        : kind === 'numeric' && area === 'Money'
          ? [{ id: `${id}-number`, kind: 'number', cadence: 'weekly', active: true }, { id: `${id}-screenshot`, kind: 'screenshot', cadence: 'monthly', active: true }]
          : [],
      createdAt: created,
    }
  })
}

export function seededRoutines(createdAt = now()): Routine[] {
  const values: Array<[string, Routine['section']]> = [
    ['Pray + meditate', 'Morning'], ['3 water', 'Morning'], ['Breakfast + supps', 'Morning'],
    ['Lunch + supps', 'Day'], ['Gym', 'Evening'], ['Dinner + mag', 'Evening'],
    ['2 water', 'Evening'], ['Skincare + retainer', 'Evening'],
  ]
  return values.map(([title, section], index) => ({ id: `seed-routine-${index + 1}`, title, section, recurrence: { type: 'daily' }, active: true, createdAt }))
}

export function createInitialData(date = new Date()): AppData {
  const created = date.toISOString()
  return {
    schema: 2,
    goals: seededGoals(date), tasks: [], routines: seededRoutines(created), evidence: [], wins: [], progress: [], periods: [],
    settings: {
      areas: ['Money', 'Business', 'Body', 'Life'],
      ai: { enabled: false, monthlyCap: 0.5, month: created.slice(0, 7), estimatedCost: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
      reminders: { morning: true, evidence: true, recap: true, deadline: true },
    },
    onboarded: false,
    updatedAt: created,
  }
}
