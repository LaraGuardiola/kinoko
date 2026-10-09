# Interruption (first-class)

The user must always be able to cut the model, queue guidance for it, and never lose what they typed.
The AbortSignal of a run reaches: the provider fetch, every tool, every subprocess (own process
group), ripgrep, and compaction.

## Agent semantics (every item is implemented and tested)
1. ABORT: one AbortController per run. abort() while idle is a no-op. After an abort the agent is
   "idle" within 100ms and reusable for the next prompt().
2. ABORT mid-stream: keep the partial assistant text as a message with stop "aborted" and NO tool calls.
3. ABORT mid-tools: every tool call of the assistant message that did not finish gets a synthetic tool
   message with content "Aborted by user". Every tool call must end with exactly one result, so the
   transcript stays valid for providers. Running tools receive the aborted signal.
4. STEER: steer(text) while running is queued and delivered as a user message AFTER the current tool
   batch finishes and BEFORE the next model call. If the model was streaming a plain answer with no
   tools, it is delivered right after that message ends and the loop continues instead of stopping.
5. FOLLOW-UP: followUp(text) is delivered ONLY when the agent would otherwise stop (no tool calls and
   an empty steer queue). Steer always has priority over follow-up. Each queue is FIFO.
6. ABORT and queues: on abort, queued messages are NOT run. Emit queue_change and return the dropped
   messages in the run_end event (field `dropped: string[]`) so the UI can put them back into the
   editor. Nothing the user typed is lost.
7. Tools of one batch run one at a time, in the order the model called them (a read after a write sees the write).
8. A thrown tool error becomes a tool message "ERROR: ...", never a crash.
9. Aborting during compaction leaves the history unchanged.

## Key bindings
- Enter while IDLE: send as prompt.
- Enter while RUNNING: steer. Shown in a "queued" area above the editor, tagged [steer].
- Alt+Enter while RUNNING: followUp, tagged [follow-up]. Alt+Enter while idle: same as Enter.
- Esc while running: abort. Esc while idle: nothing.
- Ctrl-C: running -> abort; idle with text -> clear editor; idle and empty -> press twice to quit.
- On run_end "aborted": put `dropped` messages back into the editor (joined by newlines) and show a
  one-line "Interrupted" marker.
- Alt+Up: pull the last queued message back into the editor.

## RPC
Commands `abort`, `steer`, `follow_up` must work while a run is in progress.
