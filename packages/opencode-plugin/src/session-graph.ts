/**
 * Session relationship data for OpenCode sub-agent nesting.
 *
 * Pure bookkeeping — no spans, no I/O, no timers. The tracer consults this
 * graph to decide whether a session is a sub-agent child and, if so, which
 * task tool call in the parent session dispatched it.
 *
 * Binding sources, in order of authority:
 *  1. `bind(source: "metadata")` from the task tool part's
 *     `state.metadata.sessionId`. OpenCode publishes this while the part is
 *     still running, before the child session starts — exact and safe under
 *     concurrent task calls.
 *  2. Task args `task_id` (session resume) — the child session is named
 *     explicitly, matched in {@link resolveTaskCall}.
 *  3. Heuristic inference from parentID + task call candidates (unique
 *     candidate → agent name → prompt text), for OpenCode versions that do
 *     not publish part metadata. Never resolves on ambiguity: a wrong
 *     nesting is silent data corruption, a missing one is only a missing
 *     edge.
 */

export type TaskCallArgs = {
  prompt?: string;
  subagent_type?: string;
  task_id?: string;
};

export type TaskBinding = {
  childSessionID: string;
  parentSessionID: string;
  taskCallID: string;
  /** "metadata" is authoritative and never overwritten by "inferred". */
  source: "metadata" | "inferred";
};

type TaskCall = {
  callID: string;
  sessionID: string;
  args: TaskCallArgs;
  startedAt: number;
  endedAt?: number;
};

/** Window in which an ended task call stays a valid inference candidate. */
const RECENTLY_ENDED_TASK_MS = 15 * 60 * 1000;
/** Ended task calls are pruned after a day; active ones are never pruned. */
const ENDED_TASK_CALL_TTL_MS = 24 * 60 * 60 * 1000;
/** Safety cap on remembered task calls (active + recently ended). */
const MAX_TASK_CALLS = 500;

function definedArgs(args: TaskCallArgs): TaskCallArgs {
  const out: TaskCallArgs = {};
  if (typeof args.prompt === "string") out.prompt = args.prompt;
  if (typeof args.subagent_type === "string") out.subagent_type = args.subagent_type;
  if (typeof args.task_id === "string") out.task_id = args.task_id;
  return out;
}

export class SessionGraph {
  /** child sessionID → parent sessionID (from session events or API lookup). */
  private readonly parents = new Map<string, string>();
  /** Sessions known to have no parent. */
  private readonly roots = new Set<string>();
  /** child sessionID → dispatching task call. */
  private readonly bindings = new Map<string, TaskBinding>();
  /** task callID → child sessionID (reverse of bindings). */
  private readonly childByTaskCall = new Map<string, string>();
  /** task callID → call record (args for inference, times for recency). */
  private readonly taskCalls = new Map<string, TaskCall>();

  registerParent(childSessionID: string, parentSessionID: string): void {
    if (childSessionID === parentSessionID) return;
    this.roots.delete(childSessionID);
    this.parents.set(childSessionID, parentSessionID);
  }

  markRoot(sessionID: string): void {
    if (this.parents.has(sessionID) || this.bindings.has(sessionID)) return;
    this.roots.add(sessionID);
  }

  isRoot(sessionID: string): boolean {
    return this.roots.has(sessionID);
  }

  parentOf(sessionID: string): string | undefined {
    return this.parents.get(sessionID);
  }

  registerTaskCall(callID: string, sessionID: string, args: TaskCallArgs): void {
    const existing = this.taskCalls.get(callID);
    if (existing) {
      existing.args = { ...existing.args, ...definedArgs(args) };
      return;
    }
    this.taskCalls.set(callID, {
      callID,
      sessionID,
      args: definedArgs(args),
      startedAt: Date.now(),
    });
    this.pruneTaskCalls();
  }

  endTaskCall(callID: string): void {
    const task = this.taskCalls.get(callID);
    if (task && task.endedAt === undefined) task.endedAt = Date.now();
  }

  bind(binding: TaskBinding): void {
    const existing = this.bindings.get(binding.childSessionID);
    if (existing?.source === "metadata" && binding.source === "inferred") {
      return;
    }
    if (existing && existing.taskCallID !== binding.taskCallID) {
      this.childByTaskCall.delete(existing.taskCallID);
    }
    this.roots.delete(binding.childSessionID);
    this.parents.set(binding.childSessionID, binding.parentSessionID);
    this.bindings.set(binding.childSessionID, binding);
    this.childByTaskCall.set(binding.taskCallID, binding.childSessionID);
  }

  bindingFor(childSessionID: string): TaskBinding | undefined {
    return this.bindings.get(childSessionID);
  }

  childForTaskCall(callID: string): string | undefined {
    return this.childByTaskCall.get(callID);
  }

  /**
   * Infer which task call in `parentSessionID` dispatched `childSessionID`.
   * Returns undefined on any ambiguity — never guesses.
   */
  resolveTaskCall(
    childSessionID: string,
    parentSessionID: string,
    hints: { agent?: string; prompt?: string } = {},
  ): string | undefined {
    const now = Date.now();
    const candidates = [...this.taskCalls.values()].filter(
      (task) =>
        task.sessionID === parentSessionID && this.isCandidate(task, now),
    );
    if (candidates.length === 0) return undefined;

    // task_id resume names the child session explicitly — unambiguous even
    // with several candidates.
    const resumed = candidates.filter(
      (task) => task.args.task_id === childSessionID,
    );
    if (resumed.length > 0) {
      return resumed.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
        .callID;
    }

    if (candidates.length === 1) return candidates[0]!.callID;

    if (hints.agent) {
      const byAgent = candidates.filter(
        (task) => task.args.subagent_type === hints.agent,
      );
      if (byAgent.length === 1) return byAgent[0]!.callID;
    }
    if (hints.prompt) {
      const byPrompt = candidates.filter(
        (task) => task.args.prompt === hints.prompt,
      );
      if (byPrompt.length === 1) return byPrompt[0]!.callID;
    }
    return undefined;
  }

  /**
   * Drop relationship data owned by a deleted session: its own parent link,
   * root mark, task calls, and bindings dispatched by it (its children lose
   * their dispatcher).
   */
  evictSession(sessionID: string): void {
    this.parents.delete(sessionID);
    this.roots.delete(sessionID);
    this.dropBinding(sessionID);
    for (const binding of [...this.bindings.values()]) {
      if (binding.parentSessionID === sessionID) {
        this.dropBinding(binding.childSessionID);
      }
    }
    for (const [callID, task] of this.taskCalls) {
      if (task.sessionID === sessionID) this.taskCalls.delete(callID);
    }
  }

  private dropBinding(childSessionID: string): void {
    const binding = this.bindings.get(childSessionID);
    if (!binding) return;
    this.bindings.delete(childSessionID);
    this.childByTaskCall.delete(binding.taskCallID);
  }

  private isCandidate(task: TaskCall, now: number): boolean {
    return (
      task.endedAt === undefined || now - task.endedAt <= RECENTLY_ENDED_TASK_MS
    );
  }

  private pruneTaskCalls(): void {
    const now = Date.now();
    for (const [callID, task] of this.taskCalls) {
      if (task.endedAt !== undefined && now - task.endedAt > ENDED_TASK_CALL_TTL_MS) {
        this.taskCalls.delete(callID);
      }
    }
    if (this.taskCalls.size <= MAX_TASK_CALLS) return;
    const ended = [...this.taskCalls.values()]
      .filter((task) => task.endedAt !== undefined)
      .sort((a, b) => a.endedAt! - b.endedAt!);
    for (const task of ended) {
      if (this.taskCalls.size <= MAX_TASK_CALLS) break;
      this.taskCalls.delete(task.callID);
    }
  }
}
