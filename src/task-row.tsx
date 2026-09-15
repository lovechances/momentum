import { useEffect, useRef, useState } from 'react'
import { Ban, Check, CalendarX2, MoreHorizontal, Pencil, RotateCcw, Target, Trash2 } from 'lucide-react'
import type { Task } from './domain'

export const TASK_LONG_PRESS_MS = 520
export const TASK_GESTURE_MOTION_PX = 10
export const TASK_SWIPE_WIDTH_PX = 92

export type TaskGestureIntent = 'pending' | 'scroll' | 'swipe'
export type TaskRowAction = 'edit' | 'delete' | 'remove-today' | 'edit-routine' | 'stop-routine'

export function classifyTaskGesture(deltaX: number, deltaY: number): TaskGestureIntent {
  if (Math.hypot(deltaX, deltaY) < TASK_GESTURE_MOTION_PX) return 'pending'
  return Math.abs(deltaY) >= Math.abs(deltaX) * .85 ? 'scroll' : 'swipe'
}

export function shouldRevealTaskAction(offset: number) {
  return offset <= -(TASK_SWIPE_WIDTH_PX * .45)
}

export function taskRowActionOrder(task: Pick<Task, 'kind' | 'sourceRoutineId'>): TaskRowAction[] {
  const routineOccurrence = task.kind === 'routine' || Boolean(task.sourceRoutineId)
  return routineOccurrence
    ? ['edit', 'remove-today', ...(task.sourceRoutineId ? ['edit-routine', 'stop-routine'] as const : [])]
    : ['edit', 'delete']
}

export type TaskRowProps = {
  task: Task
  goalTitle?: string
  onToggle: (task: Task) => void
  onEdit: (task: Task) => void
  onDelete: (task: Task) => void
  onRemoveToday?: (task: Task) => void
  onEditRoutine?: (routineId: string) => void
  onStopRoutine?: (routineId: string) => void
  onOpenGoal?: (goalId: string) => void
}

type PointerSession = {
  id: number
  startX: number
  startY: number
  baseOffset: number
  intent: TaskGestureIntent
  longPressed: boolean
}

export function TaskRow({
  task,
  goalTitle,
  onToggle,
  onEdit,
  onDelete,
  onRemoveToday,
  onEditRoutine,
  onStopRoutine,
  onOpenGoal,
}: TaskRowProps) {
  const routineOccurrence = task.kind === 'routine' || Boolean(task.sourceRoutineId)
  const [revealed, setRevealed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [offset, setOffset] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const sessionRef = useRef<PointerSession | undefined>(undefined)
  const longPressTimerRef = useRef<number | undefined>(undefined)
  const offsetRef = useRef(0)
  const suppressClickRef = useRef(false)

  const setCurrentOffset = (next: number) => {
    offsetRef.current = next
    setOffset(next)
  }
  const clearLongPress = () => {
    if (longPressTimerRef.current !== undefined) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = undefined
  }
  const settle = (nextRevealed: boolean) => {
    setRevealed(nextRevealed)
    setDragging(false)
    setCurrentOffset(nextRevealed ? -TASK_SWIPE_WIDTH_PX : 0)
  }

  useEffect(() => () => clearLongPress(), [])

  useEffect(() => {
    if (!menuOpen) return
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
      menuRef.current?.scrollIntoView({ block: 'nearest' })
    })
    const closeOutside = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', closeOutside)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!revealed) return
    const closeOutside = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) settle(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [revealed])

  const beginGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-task-gesture-ignore]')) return
    clearLongPress()
    sessionRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseOffset: revealed ? -TASK_SWIPE_WIDTH_PX : 0,
      intent: 'pending',
      longPressed: false,
    }
    longPressTimerRef.current = window.setTimeout(() => {
      const session = sessionRef.current
      if (!session || session.id !== event.pointerId || session.intent !== 'pending') return
      session.longPressed = true
      suppressClickRef.current = true
      settle(false)
      setMenuOpen(false)
      onEdit(task)
    }, TASK_LONG_PRESS_MS)
  }

  const moveGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current
    if (!session || session.id !== event.pointerId || session.longPressed) return
    const deltaX = event.clientX - session.startX
    const deltaY = event.clientY - session.startY
    if (session.intent === 'pending') session.intent = classifyTaskGesture(deltaX, deltaY)
    if (session.intent === 'pending') return
    clearLongPress()
    if (session.intent === 'scroll') {
      setDragging(false)
      setCurrentOffset(session.baseOffset)
      return
    }
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
    setMenuOpen(false)
    setDragging(true)
    setCurrentOffset(Math.max(-TASK_SWIPE_WIDTH_PX, Math.min(0, session.baseOffset + deltaX)))
  }

  const endGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current
    if (!session || session.id !== event.pointerId) return
    clearLongPress()
    sessionRef.current = undefined
    if (session.intent === 'swipe') {
      event.preventDefault()
      suppressClickRef.current = true
      settle(shouldRevealTaskAction(offsetRef.current))
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    } else if (session.intent === 'scroll') {
      settle(revealed)
    } else if (session.longPressed) {
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
  }

  const cancelGesture = () => {
    clearLongPress()
    sessionRef.current = undefined
    settle(revealed)
  }

  const runAction = (action: TaskRowAction) => {
    setMenuOpen(false)
    settle(false)
    if (action === 'edit') onEdit(task)
    else if (action === 'delete') onDelete(task)
    else if (action === 'remove-today') (onRemoveToday ?? onDelete)(task)
    else if (action === 'edit-routine' && task.sourceRoutineId) onEditRoutine?.(task.sourceRoutineId)
    else if (action === 'stop-routine' && task.sourceRoutineId) onStopRoutine?.(task.sourceRoutineId)
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      setMenuOpen(false)
      moreRef.current?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      items[(index + direction + items.length) % items.length]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      setMenuOpen(false)
    }
  }

  const destructiveLabel = routineOccurrence ? 'Remove today' : 'Delete'
  return <div className={`momentum-task-row${task.done ? ' is-done' : ''}${revealed ? ' is-revealed' : ''}`} ref={rowRef}>
    <button
      aria-hidden={!revealed}
      className="momentum-task-row__reveal"
      onClick={() => runAction(routineOccurrence ? 'remove-today' : 'delete')}
      tabIndex={revealed ? 0 : -1}
      type="button"
    >
      {routineOccurrence ? <CalendarX2 size={17}/> : <Trash2 size={17}/>}<span>{destructiveLabel}</span>
    </button>

    <div
      className={`momentum-task-row__surface${dragging ? ' is-dragging' : ''}`}
      onClickCapture={event => {
        if (!suppressClickRef.current) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onContextMenu={event => event.preventDefault()}
      onPointerCancel={cancelGesture}
      onPointerDown={beginGesture}
      onPointerMove={moveGesture}
      onPointerUp={endGesture}
      style={{ transform: `translate3d(${offset}px,0,0)` }}
    >
      <button
        aria-label={`${task.done ? 'Uncheck' : 'Complete'} ${task.title}`}
        aria-pressed={task.done}
        className="momentum-task-row__toggle"
        data-task-gesture-ignore
        onClick={() => onToggle(task)}
        type="button"
      >
        <span>{task.done && <Check aria-hidden="true" size={14}/>}</span>
      </button>

      {task.goalId && onOpenGoal
        ? <button className="momentum-task-row__copy" onClick={() => onOpenGoal(task.goalId!)} type="button">
          <b>{task.title}</b>
          {goalTitle && <small>{goalTitle}</small>}
        </button>
        : <div className="momentum-task-row__copy"><b>{task.title}</b>{goalTitle && <small>{goalTitle}</small>}</div>}

      {task.kind === 'move' && <Target aria-label="Goal Move" className="momentum-task-row__move" size={14}/>}
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={`More actions for ${task.title}`}
        className="momentum-task-row__more"
        data-task-gesture-ignore
        onClick={() => {
          settle(false)
          setMenuOpen(current => !current)
        }}
        ref={moreRef}
        type="button"
      ><MoreHorizontal aria-hidden="true" size={19}/></button>
    </div>

    {menuOpen && <div aria-label={`Actions for ${task.title}`} className="momentum-task-row__menu" onKeyDown={onMenuKeyDown} ref={menuRef} role="menu">
      {taskRowActionOrder(task).filter(action =>
        (action !== 'edit-routine' || onEditRoutine)
        && (action !== 'stop-routine' || onStopRoutine),
      ).map(action => <button className={action === 'delete' || action === 'remove-today' || action === 'stop-routine' ? 'is-danger' : ''} key={action} onClick={() => runAction(action)} role="menuitem" type="button">
        {action === 'edit' ? <Pencil size={15}/> : action === 'delete' ? <Trash2 size={15}/> : action === 'remove-today' ? <CalendarX2 size={15}/> : action === 'edit-routine' ? <RotateCcw size={15}/> : <Ban size={15}/>}
        {action === 'edit' ? 'Edit' : action === 'delete' ? 'Delete' : action === 'remove-today' ? 'Remove from today' : action === 'edit-routine' ? 'Edit routine' : 'Stop routine'}
      </button>)}
    </div>}
  </div>
}
