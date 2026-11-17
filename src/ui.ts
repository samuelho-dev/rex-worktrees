import { Cause, Effect, Option, Path, Queue, Result, Scope, Terminal } from "effect"
import { Prompt } from "effect/cli"
import { connectAndDiscover, connectMachine, inspectSessions, inspectProject, inspectRevision, inspectWorktrees, listMachines, review, reviewClone, sourceForClone, submit, submitClone } from "./client.ts"
import { AppError, popupSize, type ClientTarget, type CloneInput, type Color, type Destination, type DestinationHost, type Draft, type FormField, type FormRow, type FormView, type InputChoice, type InputChoiceOptions, type InputChoiceResult, type InputChoiceState, type JjRevision, type JjRevisionChoice, type LaunchInput, type Machine, type NoticeTone, type PopupOrigin, type ProjectChoice, type Repository, type SessionTarget, type Worktree } from "./contracts.ts"
import { BunTerminal } from "@effect/platform-bun";

const codes: Record<Color, string> = { cyan: "\x1b[36m", amber: "\x1b[33m", muted: "\x1b[90m", red: "\x1b[31m", bold: "\x1b[1m" }
const color = (text: string, tone: Color, enabled: boolean) => enabled ? `${codes[tone]}${text}\x1b[0m` : text
// External project names, paths and Rex labels are display data, never terminal instructions.
const safeDisplayText = (text: string, preserveWhitespace = false) => {
  const cleaned = Bun.stripANSI(text).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
  return preserveWhitespace ? cleaned : cleaned.replace(/\s+/g, " ").trim()
}
const fit = (text: string, width: number) => Bun.stringWidth(text) > width ? Bun.sliceAnsi(text, 0, Math.max(0, width), { ellipsis: "…" }) : text
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))

const formRows: readonly FormRow[] = [
  { id: "project", label: "Project", value: "—", disabled: true },
  { id: "machine", label: "Machine", value: "—", disabled: true },
  { id: "session", label: "Session", value: "—", disabled: true },
  { id: "destination", label: "Worktree", value: "—", disabled: true },
  { id: "branch", label: "Branch", value: "—", disabled: true },
  { id: "checkoutName", label: "Directory", value: "—", disabled: true },
  { id: "mode", label: "Mode", value: "—", disabled: true }
]
const choiceCount = popupSize.rows - formRows.length - 6

/** Every state keeps the same field slots, editor dock, and footer coordinates. */
export const renderFormFrame = (view: FormView, focused: FormField, columns: number, rows: number, colors = !process.env.NO_COLOR,
  options: { readonly editor?: { readonly title: string; readonly lines: readonly string[] }; readonly detailOffset?: number; readonly footer?: string } = {}): string => {
  const width = Math.max(2, columns)
  if (rows < popupSize.rows) return fit(`Rex Worktrees needs ${popupSize.rows} terminal rows. Resize this pane; Esc closes.`, width)
  const detailCount = rows - formRows.length - 4
  const screen: string[] = []
  const add = (text: string) => screen.push(pad(fit(text, width), width))
  add(`${color("REX", "cyan", colors)} ${color("/ WORKTREES", "bold", colors)}`)
  add(color("─".repeat(width), "muted", colors))
  for (const slot of formRows) {
    const row = view.rows.find(row => row.id === slot.id) ?? slot
    const active = focused === row.id
    const tone = row.disabled ? "muted" : active ? "cyan" : "bold"
    const indicator = active ? "›" : " "
    add(`${color(indicator, tone, colors)} ${color(pad(fit(safeDisplayText(row.label).toUpperCase(), 13), 13), tone, colors)}  ${color(fit(safeDisplayText(row.value) || "—", Math.max(1, width - 17)), tone, colors)}`)
  }
  const current = view.rows.find(row => row.id === focused)
  const heading = fit(safeDisplayText(options.editor?.title ?? current?.label ?? "Details") + " ", width)
  add(color(`${heading}${"─".repeat(Math.max(0, width - Bun.stringWidth(heading)))}`, "muted", colors))
  const subtitle = current?.detail ?? view.rows.find(row => row.id === "destination")?.detail ?? ""
  const wrapped = [view.error, view.notice, subtitle].filter(Boolean).flatMap(message =>
    Bun.wrapAnsi(safeDisplayText(message!), Math.max(1, width - 8), { hard: true }).split("\n"))
  const visible = options.editor ? 1 : detailCount
  const offset = Math.max(0, Math.min(options.detailOffset ?? 0, wrapped.length - visible))
  const detailLine = (index: number) => `${index === 0 && offset > 0 ? "↑ " : ""}${wrapped[offset + index] ?? ""}${index === visible - 1 && offset + visible < wrapped.length ? " ↓ PgDn" : ""}`
  if (options.editor) {
    for (let index = 0; index < detailCount - 1; index++) add(options.editor.lines[index] ?? "")
    add(view.error ? color(detailLine(0), "red", colors) : "")
  } else {
    for (let index = 0; index < detailCount; index++) add(color(detailLine(index), view.error ? "red" : view.notice ? "amber" : "muted", colors))
  }
  const hint = (key: string, label: string) => `${color(key, "bold", colors)} ${color(label, "muted", colors)}`
  const button = (label: string, active: boolean, primary = false, disabled = false) =>
    color(`${active ? "›" : " "}[ ${safeDisplayText(label)} ]`, disabled ? "muted" : active ? "cyan" : primary ? "bold" : "muted", colors)
  add(options.footer ? color(options.footer, "muted", colors) : options.editor
    ? `${hint("Enter", "accept")} · ${hint("Esc", "back")} · ${hint("↑↓", "choices")} · ${hint("PgUp/PgDn", "details")}`
    : `${button(`${view.submitLabel} · Ctrl+S`, focused === "submit", true, view.submitDisabled)} ${button("Cancel · Esc", focused === "cancel")}  ${hint("Tab", "next")}`)
  return screen.join("\r\n")
}

const matchingChoices = <A>(choices: readonly InputChoice<A>[], text: string): number[] => {
  const query = text.toLocaleLowerCase()
  const matches: number[] = []
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]
    if (choice && `${choice.title} ${choice.description ?? ""}`.toLocaleLowerCase().includes(query)) matches.push(index)
  }
  return matches
}
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Pure editor transition: typing never implicitly selects a matching existing value. */
export const advanceInputChoice = <A>(
  state: InputChoiceState,
  event: Terminal.UserInput,
  choices: readonly InputChoice<A>[],
  selectionOnly = false
): Prompt.Action<InputChoiceState, InputChoiceResult<A> | null> => {
  const { key } = event
  if (key.name === "escape" || key.ctrl && key.name === "c") return { _tag: "Submit", value: null }
  if (key.ctrl && key.name === "u") return { _tag: "NextFrame", state: { text: "", selected: selectionOnly ? state.selected : null } }
  const matches = matchingChoices(choices, state.text)
  if (key.name === "up" || key.name === "down" || key.name === "tab") {
    if (matches.length === 0) return { _tag: "Beep" }
    const current = state.selected === null ? (key.name === "up" ? 0 : -1) : matches.indexOf(state.selected)
    const next = matches[(current + (key.name === "up" ? -1 : 1) + matches.length) % matches.length]
    return next === undefined ? { _tag: "Beep" } : { _tag: "NextFrame", state: { ...state, selected: next } }
  }
  if (key.name === "enter" || key.name === "return" || key.ctrl && key.name === "s") {
    const picked = state.selected === null ? undefined : choices[state.selected]
    if (picked && state.selected !== null && matches.includes(state.selected)) return { _tag: "Submit", value: { kind: "selected", value: picked.value } }
    return !selectionOnly && state.text.trim() ? { _tag: "Submit", value: { kind: "typed", text: state.text } } : { _tag: "Beep" }
  }
  if (key.name === "backspace" || key.name === "delete") {
    const last = graphemeSegmenter.segment(state.text).containing(state.text.length - 1)?.index ?? 0
    return { _tag: "NextFrame", state: { text: state.text.slice(0, last), selected: selectionOnly ? state.selected : null } }
  }
  const text = Option.getOrElse(event.input, () => "")
  if (key.ctrl || key.meta || !text || /[\p{ASCII}&&\p{Cc}]/v.test(text)) return { _tag: "Beep" }
  return { _tag: "NextFrame", state: { text: state.text + text, selected: selectionOnly ? state.selected : null } }
}

export const renderInputChoice = <A>(
  state: InputChoiceState, choices: readonly InputChoice<A>[], columns: number, colors = !process.env.NO_COLOR, selectionOnly = false, count = choiceCount
): readonly string[] => {
  const width = Math.max(20, columns)
  const matches = matchingChoices(choices, state.text)
  const selected = matches.indexOf(state.selected ?? -1)
  const start = selected < 0 ? 0 : Math.max(0, Math.min(selected, matches.length - count))
  const lines = [`${color("›", "cyan", colors)} ${fit(safeDisplayText(state.text, true) || (selectionOnly ? "Filter exact choices…" : "Type new value…"), width - 2)}`]
  for (const index of matches.slice(start, start + count)) {
    const choice = choices[index]
    if (!choice) continue
    const label = `${state.selected === index ? "›" : " "} ${safeDisplayText(choice.title)}${choice.description ? ` · ${safeDisplayText(choice.description)}` : ""}`
    lines.push(fit(label, width))
  }
  return lines
}

const acknowledge = (title: string, lines: readonly string[], tone: NoticeTone, view: FormView = { rows: [], submitLabel: "Close" }): Effect.Effect<void, Terminal.QuitError, Prompt.Environment> =>
  Prompt.run(Prompt.Custom<number, void>(0, {
    render: (detailOffset, action) => action._tag === "Submit" ? Effect.succeed("") : Effect.gen(function*() {
      const terminal = yield* Terminal.Terminal
      const notice = `${title} · ${lines.join(" · ")}`
      return `\x1b[?25l\x1b[H\x1b[2J${renderFormFrame({ ...view, error: tone === "error" ? notice : undefined, notice: tone !== "error" ? notice : undefined }, "submit", yield* terminal.columns, yield* terminal.rows, !process.env.NO_COLOR, { detailOffset, footer: "Enter / Space close · Esc close · PgUp/PgDn details" })}\x1b[0J`
    }),
    clear: () => Effect.succeed(""),
    process: (input, offset) => Effect.succeed<Prompt.Action<number, void>>(input.key.name === "pageup" || input.key.name === "pagedown"
      ? { _tag: "NextFrame", state: Math.max(0, offset + (input.key.name === "pageup" ? -1 : 1)) }
      : input.key.name === "enter" || input.key.name === "return" || input.key.name === "space" || input.key.name === "escape" || input.key.ctrl && input.key.name === "c"
        ? { _tag: "Submit", value: undefined } : { _tag: "Beep" })
  })).pipe(Effect.catch(() => Effect.void))

const problem = (error: unknown) => error instanceof AppError ? error.message : Cause.pretty(Cause.fail(error))
const selected = <T>(value: T, current: boolean, title: string, description?: string): InputChoice<T> => ({ value, selected: current, title, description })
const directoryFor = (draft: Draft): string | undefined => {
  if (draft.destination?.path) return draft.destination.path
  if (draft.clone && !draft.isCreating) return draft.clone.repo
  if (draft.directory) return draft.directory
  const repo = draft.clone?.repo ?? draft.project?.path
  const name = draft.worktreeName ?? draft.destination?.branch
  return repo && name ? `${(draft.worktreeRoot ?? `${repo}.worktrees`).replace(/\/$/, "")}/${name}` : undefined
}
export const generatedName = (draft: Draft) => draft.clone && !draft.isCreating
  ? draft.projectChoice?.name ?? "Project"
  : draft.worktreeName ?? draft.destination?.label ?? draft.projectChoice?.name ?? "Worktree"
export const inputFor = (draft: Draft): LaunchInput | undefined => {
  if (!draft.host || !draft.project || !draft.projectChoice || !draft.destination || !draft.session) return undefined
  const common = {
    repo: draft.project.vcs === "jj" ? draft.sourcePath ?? draft.project.path : draft.project.path,
    session: draft.session, name: generatedName(draft),
    clientId: draft.clientId, additional: draft.mode === "new-tab", split: draft.mode === "split"
  }
  if (draft.destination.path) return { ...common, vcs: draft.project.vcs, path: draft.destination.path }
  const directory = directoryFor(draft)
  if (!directory) return undefined
  if (draft.project.vcs === "jj") return draft.worktreeName && draft.destination.revision
    ? { ...common, vcs: "jj", worktreeName: draft.worktreeName, revision: draft.destination.revision, directory }
    : undefined
  return draft.destination.branch
    ? { ...common, vcs: "git", branch: draft.destination.branch, directory,
      ...(draft.worktreeName ? { worktreeName: draft.worktreeName } : {}) }
    : undefined
}

export const changeProjectChoice = (draft: Draft, projectChoice: ProjectChoice): Draft => ({
  ...draft, projectChoice, project: undefined, clone: undefined, destination: undefined,
  worktreeName: undefined, directory: undefined, worktreeRoot: undefined, isCreating: false, sourcePath: undefined
})
export const changeProject = (draft: Draft, candidate: Repository): Draft => {
  const same = draft.project?.vcs === candidate.vcs && draft.project.commonDir === candidate.commonDir
  return {
    ...draft, project: candidate, clone: undefined,
    destination: same ? draft.destination : undefined,
    worktreeName: same ? draft.worktreeName : undefined,
    directory: same ? draft.directory : undefined,
    isCreating: same && draft.isCreating,
    sourcePath: candidate.vcs === "jj" && same ? draft.sourcePath : undefined
  }
}
export const changeDestination = (draft: Draft, candidate: Destination, worktreeName?: string): Draft => ({
  ...draft, destination: candidate, worktreeName: candidate.path ? undefined : worktreeName,
  directory: candidate.path ? undefined : draft.directory, isCreating: candidate.path ? false : draft.isCreating
})
export const selectWorktree = (draft: Draft, tree: Worktree): Draft => {
  if (!tree.path || tree.vcs === "jj" && !tree.present)
    throw new AppError({ message: `Workspace ${tree.vcs === "jj" ? tree.name : tree.path} is unavailable; inspect its registered location before opening` })
  return {
    ...changeDestination(draft, {
      path: tree.path, worktree: tree, label: tree.vcs === "jj" ? tree.name
        : tree.path.split("/").filter(Boolean).at(-1) ?? tree.path
    }),
    ...(tree.vcs === "jj" ? {
      sourcePath: tree.path,
      projectChoice: draft.projectChoice?.source && draft.projectChoice.source.hostId === draft.host?.hostId
        ? { ...draft.projectChoice, source: { ...draft.projectChoice.source, checkoutPath: tree.path } }
        : draft.projectChoice
    } : {})
  }
}
export const selectRevision = (draft: Draft, choice: JjRevisionChoice): Draft =>
  changeDestination(draft, { revision: choice.revision.commitId, label: choice.label }, draft.worktreeName)

export const cloneInputFor = (draft: Draft): CloneInput | undefined => {
  if (!draft.host || !draft.clone || !draft.session || !draft.clone.repo.startsWith("/")) return undefined
  const directory = draft.isCreating ? directoryFor(draft) : undefined
  const checkout = draft.isCreating ? "worktree" : "primary"
  if (draft.isCreating && (!directory || draft.clone.vcs === "git" && draft.destination?.branch === draft.clone.branch)) return undefined
  if (draft.clone.vcs === "jj") {
    const revision = draft.clone.revision?.commitId === draft.destination?.revision ? draft.clone.revision
      : draft.clone.revisions.find(choice => choice.revision.commitId === draft.destination?.revision)?.revision
    return {
      vcs: "jj", source: {
        vcs: "jj", url: draft.clone.url, sourceHostId: draft.clone.sourceHostId,
        revisions: [], ...(revision ? { revision } : {})
      },
      repo: draft.clone.repo, session: draft.session, clientId: draft.clientId, checkout, directory,
      name: generatedName(draft), ...(draft.isCreating && draft.worktreeName ? { worktreeName: draft.worktreeName } : {}),
      ...(draft.destination?.revision ? { revision: draft.destination.revision } : {})
    }
  }
  if (!draft.destination?.branch) return undefined
  return {
    vcs: "git", source: {
      vcs: "git", url: draft.clone.url, sourceHostId: draft.clone.sourceHostId,
      branches: draft.clone.branches, branch: draft.clone.branch
    },
    repo: draft.clone.repo, session: draft.session, clientId: draft.clientId, checkout, directory,
    name: generatedName(draft), branch: draft.destination.branch,
    branchMode: draft.clone.branches.includes(draft.destination.branch) ? "existing" : "create",
    ...(draft.isCreating && draft.worktreeName ? { worktreeName: draft.worktreeName } : {})
  }
}

export const popup = <E, R>(command: readonly string[], context: Effect.Effect<string | undefined, E, R>, origin: PopupOrigin = {}, preferredMachine?: string) =>
  Effect.scoped(Effect.suspend(() => {
    let launchAcknowledged = false
    return Effect.gen(function*() {
      const terminal = yield* Terminal.Terminal
      const path = yield* Path.Path
      yield* Effect.acquireRelease(
        terminal.display("\x1b[?1049h\x1b[?25l"),
        () => terminal.display("\x1b[?25h\x1b[?1049l").pipe(Effect.orDie)
      )
      let machines: Machine[] = []
      let draft: Draft = { mode: "auto" }
      let sessions: readonly SessionTarget[] = []
      let focused: FormField = "project"
      let isBranchEditPending = false
      let error: string | undefined
      let blocked = false
      let cloneRoot = ""
      let contextPath: string | undefined
      let activeView: FormView | undefined
      const resizeEvents = Effect.gen(function*() {
        const source = yield* terminal.size
        const events = yield* Queue.sliding<Terminal.Size>(1)
        yield* Effect.forever(Queue.take(source).pipe(Effect.flatMap(value => Queue.offer(events, value)))).pipe(Effect.forkScoped)
        return events
      })
      const chooseField: (view: FormView, initialFocus: FormField) => Effect.Effect<FormField, Terminal.QuitError, Prompt.Environment> =
        Effect.fnUntraced(function*(view: FormView, initialFocus: FormField) {
          let detailOffset = 0
          let visibleRows = popupSize.rows
          const fields: FormField[] = [...formRows.filter(slot => view.rows.some(row => row.id === slot.id && !row.disabled && !row.isReadOnly)).map(row => row.id), "submit", "cancel"]
          const initial = Math.max(0, fields.indexOf(initialFocus))
          const prompt = Prompt.Custom<number, FormField, Terminal.Size>(initial, yield* resizeEvents, {
            render: (index, action) => action._tag === "Submit" ? Effect.succeed("") : Effect.gen(function*() {
              const columns = yield* terminal.columns
              const rows = yield* terminal.rows
              visibleRows = rows
              return `\x1b[?25l\x1b[H\x1b[2J${renderFormFrame(view, fields[index], columns, rows, !process.env.NO_COLOR, { detailOffset })}\x1b[0J`
            }),
            clear: () => Effect.succeed(""),
            process: (event, index) => {
              if (event._tag === "Event") return Effect.succeed<Prompt.Action<number, FormField>>({ _tag: "NextFrame", state: index })
              const { key } = event.input
              if (key.name === "escape" || key.ctrl && key.name === "c") return Effect.succeed<Prompt.Action<number, FormField>>({ _tag: "Submit", value: "cancel" })
              if (visibleRows < popupSize.rows) return Effect.succeed<Prompt.Action<number, FormField>>({ _tag: "Beep" })
              if (key.name === "pageup" || key.name === "pagedown") {
                detailOffset = Math.max(0, detailOffset + (key.name === "pageup" ? -1 : 1))
                return Effect.succeed<Prompt.Action<number, FormField>>({ _tag: "NextFrame", state: index })
              }
              if (key.ctrl && key.name === "s") return Effect.succeed<Prompt.Action<number, FormField>>(view.submitDisabled
                ? { _tag: "Beep" } : { _tag: "Submit", value: "submit" })
              if (key.name === "enter" || key.name === "return") {
                const selected = fields[index]
                return Effect.succeed<Prompt.Action<number, FormField>>(selected === "submit" && view.submitDisabled
                  ? { _tag: "Beep" }
                  : { _tag: "Submit", value: selected })
              }
              const backward = key.name === "up" || key.name === "k" && !key.ctrl || key.name === "backtab" || key.name === "tab" && key.shift
              const forward = key.name === "down" || key.name === "j" && !key.ctrl || key.name === "tab"
              return Effect.succeed<Prompt.Action<number, FormField>>(backward || forward
                ? { _tag: "NextFrame", state: (index + (backward ? -1 : 1) + fields.length) % fields.length }
                : { _tag: "Beep" })
            }
          })
          return yield* Prompt.run(prompt)
        }, Effect.scoped)
      const inputChoice: <A>(options: InputChoiceOptions<A>) => Effect.Effect<InputChoiceResult<A>, Terminal.QuitError, Prompt.Environment> =
        Effect.fnUntraced(function*<A>(options: InputChoiceOptions<A>): Effect.fn.Return<InputChoiceResult<A>, Terminal.QuitError, Prompt.Environment | Scope.Scope> {
          let detailOffset = 0
          let visibleRows = popupSize.rows
          const result = yield* Prompt.run(Prompt.Custom<InputChoiceState, InputChoiceResult<A> | null, Terminal.Size>(
            { text: "", selected: options.selected === undefined || options.selected < 0 ? null : options.selected }, yield* resizeEvents, {
            render: (state, action) => action._tag === "Submit" ? Effect.succeed("") : Effect.gen(function*() {
              const columns = yield* terminal.columns
              const rows = yield* terminal.rows
              visibleRows = rows
              const view = activeView
              const editor = renderInputChoice(state, options.choices, columns, !process.env.NO_COLOR, options.selectionOnly, Math.max(1, rows - formRows.length - 6))
              if (!view) return ""
              return `\x1b[?25l\x1b[H\x1b[2J${renderFormFrame(view, focused, columns, rows, !process.env.NO_COLOR, { editor: { title: options.message, lines: editor }, detailOffset })}\x1b[0J`
            }),
            clear: () => Effect.succeed(""),
            process: (event, state) => {
              if (event._tag !== "Event" && visibleRows < popupSize.rows &&
                event.input.key.name !== "escape" && !(event.input.key.ctrl && event.input.key.name === "c"))
                return Effect.succeed<Prompt.Action<InputChoiceState, InputChoiceResult<A> | null>>({ _tag: "Beep" })
              if (event._tag !== "Event" && (event.input.key.name === "pageup" || event.input.key.name === "pagedown")) {
                detailOffset = Math.max(0, detailOffset + (event.input.key.name === "pageup" ? -1 : 1))
                return Effect.succeed<Prompt.Action<InputChoiceState, InputChoiceResult<A> | null>>({ _tag: "NextFrame", state })
              }
              return Effect.succeed<Prompt.Action<InputChoiceState, InputChoiceResult<A> | null>>(
                event._tag === "Event" ? { _tag: "NextFrame", state }
                  : advanceInputChoice(state, event.input, options.choices, options.selectionOnly))
            }
          }
          ))
          return result === null ? yield* Effect.fail(new Terminal.QuitError({})) : result
        }, Effect.scoped)
      const choose = Effect.fnUntraced(function*<T>(message: string, choices: readonly InputChoice<T>[]): Effect.fn.Return<T, AppError | Terminal.QuitError, Prompt.Environment> {
        const picked = yield* inputChoice({
          message, choices, selectionOnly: true, selected: choices.findIndex(choice => choice.selected)
        })
        if (picked.kind !== "selected") return yield* Effect.fail(new AppError({ message: "Select an exact value" }))
        return picked.value
      })
      let projects: ProjectChoice[] = []
      const focusClient = (clients: readonly ClientTarget[]) =>
        clients.some(item => item.id === draft.clientId) ? draft.clientId
          : draft.host?.local && clients.some(item => item.id === origin.clientId) ? origin.clientId
            : clients.length === 1 ? clients[0]?.id : undefined
      const loadMachines = Effect.gen(function*() {
        const found = yield* Effect.result(listMachines)
        if (Result.isFailure(found)) error = problem(found.failure)
        else { machines = found.success; error = undefined }
      })
      const clonePath = (choice: ProjectChoice) =>
        choice.name && choice.name !== "." && choice.name !== ".." && !/[/\\\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(choice.name)
          ? `${cloneRoot.replace(/\/$/, "")}/${choice.name}` : undefined
      const known = (host: DestinationHost, repository: Repository, checkout?: Repository): ProjectChoice => ({
        name: repository.name, source: {
          machineKey: host.key, hostId: host.hostId, repository,
          ...(repository.vcs === "jj" && checkout?.vcs === "jj" && checkout.commonDir === repository.commonDir
            ? { checkoutPath: checkout.path } : {})
        }
      })
      const proposeClone = Effect.fnUntraced(function*(choice: ProjectChoice, host: DestinationHost, repo: string) {
        const reference = choice.source
        if (!reference) return yield* Effect.fail(new AppError({ message: "Choose a known source project before cloning" }))
        const sourceMachine = machines.find(item => item.key === reference.machineKey)
        if (!sourceMachine) return yield* Effect.fail(new AppError({ message: "Source Rex machine is no longer registered" }))
        const sourceHost = yield* connectMachine(sourceMachine)
        if (sourceHost.hostId !== reference.hostId)
          return yield* Effect.fail(new AppError({ message: "Source Rex host identity changed; select the project again" }))
        const source = yield* sourceForClone(sourceHost, command, reference.checkoutPath ?? reference.repository.path)
        draft = {
          ...draft, projectChoice: choice, host, project: undefined, sourcePath: undefined,
          clone: { ...source, repo }, destination: source.vcs === "git" && source.branch
            ? { branch: source.branch, label: source.branch } : undefined,
          worktreeName: undefined, directory: undefined, worktreeRoot: undefined, isCreating: false
        }
      })
      const bindProject = Effect.fnUntraced(function*(choice: ProjectChoice, host: DestinationHost, available: readonly Repository[]) {
        const source = choice.source
        const sameHost = source?.machineKey === host.key && source.hostId === host.hostId
        const matches = available.filter(repo => repo.name === choice.name && (!source || repo.vcs === source.repository.vcs))
        let directory = sameHost ? source.checkoutPath ?? source.repository.path : choice.path
        if (!directory && matches.length === 1) directory = matches[0]!.path
        if (!directory && matches.length > 1)
          return yield* Effect.fail(new AppError({ message: `Multiple projects named ${choice.name} on this machine; select its exact project directory` }))
        directory ??= source ? clonePath(choice) : undefined
        if (!directory) {
          if (source) { yield* proposeClone(choice, host, ""); return undefined }
          return yield* Effect.fail(new AppError({ message: "Select a known project or enter its absolute directory on this machine" }))
        }
        if (!path.isAbsolute(directory)) return yield* Effect.fail(new AppError({ message: "Project directory must be an absolute path on this machine" }))
        const inspected = yield* Effect.result(inspectProject(host, command, directory))
        if (Result.isFailure(inspected)) {
          if (source && inspected.failure instanceof AppError &&
            inspected.failure.message.startsWith("Project directory does not exist:")) {
            yield* proposeClone(choice, host, directory)
            return undefined
          }
          return yield* Effect.fail(inspected.failure)
        }
        if (sameHost && (inspected.success.project.vcs !== source.repository.vcs ||
          inspected.success.project.commonDir !== source.repository.commonDir))
          return yield* Effect.fail(new AppError({ message: "Project directory changed; select the exact project directory again" }))
        return inspected.success
      })
      const useProject = (found: { project: Repository; checkout: Repository; worktrees: readonly Worktree[]; worktreeRoot?: string }) => {
        draft = { ...changeProject(draft, found.project), worktreeRoot: found.worktreeRoot }
        if (found.checkout.vcs === "jj" && !draft.sourcePath) draft = { ...draft, sourcePath: found.checkout.path }
        if (!draft.destination) {
          const tree = found.worktrees.find(item => item.path === found.checkout.path &&
            (item.vcs === "jj" ? item.present : !item.bare && !item.prunable))
          if (tree) draft = selectWorktree(draft, tree)
        }
      }
      const activate = Effect.fnUntraced(function*(machine: Machine, showLoading = false) {
        const previous = draft
        const previousHostId = draft.host?.hostId
        draft = { machine, projectChoice: draft.projectChoice, mode: draft.mode }
        sessions = []; cloneRoot = ""
        error = undefined
        const discoveredContext = machine.local ? contextPath : undefined
        contextPath = undefined
        if (showLoading) {
          const pending = { ...formView(true), notice: `Connecting to ${machine.label}…` }
          activeView = pending
          yield* terminal.display(`\x1b[?25l\x1b[H\x1b[2J${renderFormFrame(pending, "machine", yield* terminal.columns, yield* terminal.rows)}\x1b[0J`)
        }
        const connected = yield* Effect.result(connectAndDiscover(machine, command, discoveredContext))
        if (Result.isFailure(connected)) {
          error = problem(connected.failure)
          return
        }
        const { host, ...found } = connected.success
        if (previous.machine?.key === machine.key && previousHostId === host.hostId)
          draft = { ...previous, machine, host }
        else draft = { ...draft, host }
        cloneRoot = found.cloneRoot
        projects = [...projects.filter(item => item.source?.machineKey !== machine.key || item.source.hostId !== host.hostId),
        ...found.projects.map(repo => known(host, repo, found.checkout))]
        sessions = found.sessions
        draft = {
          ...draft, session: draft.session?.kind === "new" ? draft.session
            : sessions.some(item => item.id === (draft.session?.kind === "existing" ? draft.session.id : undefined)) ? draft.session
              : host.local && origin.sessionId && sessions.some(item => item.id === origin.sessionId) ? { kind: "existing", id: origin.sessionId }
                : sessions.length === 1 ? { kind: "existing", id: sessions[0]!.id } : undefined,
          clientId: focusClient(found.clients)
        }
        if (!draft.projectChoice && found.checkout && discoveredContext) {
          const inspected = yield* Effect.result(inspectProject(host, command, found.checkout.path))
          if (Result.isFailure(inspected)) { error = problem(inspected.failure); return }
          draft = changeProjectChoice(draft, known(host, inspected.success.project, inspected.success.checkout))
          useProject(inspected.success)
        } else if (draft.projectChoice) {
          const inspected = yield* Effect.result(bindProject(draft.projectChoice, host, found.projects))
          if (Result.isFailure(inspected)) {
            if (!Terminal.isQuitError(inspected.failure)) error = problem(inspected.failure)
            return
          }
          if (inspected.success) useProject(inspected.success)
        }
        error = undefined

      })
      const formView = (initializing = false): FormView => {
        const jj = (draft.clone?.vcs ?? draft.project?.vcs) === "jj"
        const tree = draft.destination?.path ? draft.destination.worktree : undefined
        const ready = !!draft.host && !!(draft.project || draft.clone)
        const directory = directoryFor(draft)
        const rows: FormRow[] = [
          { id: "project", label: "Project", value: draft.projectChoice?.name ?? "Choose a project" },
          {
            id: "machine", label: "Machine", value: draft.machine?.label ?? "Choose Rex host",
            detail: draft.host ? `Host ID: ${draft.host.hostId}` : draft.machine?.selector
          },
          {
            id: "session", label: "Session", value: draft.session?.kind === "new" ? `New: ${draft.session.name}`
              : sessions.find(s => s.id === (draft.session?.kind === "existing" ? draft.session.id : undefined))?.label ?? (draft.session?.kind === "existing" ? draft.session.id : "Choose or type new session"),
            detail: draft.session?.kind === "existing" ? draft.session.id : draft.session?.kind === "new" ? "Create on submit" : undefined, disabled: !draft.host
          },
          {
            id: "destination", label: jj ? "Workspace" : "Worktree",
            value: draft.clone && !draft.isCreating ? "Project checkout (after clone)" :
              draft.isCreating ? jj ? "Create new workspace…" : "Create new worktree…" :
                draft.destination?.label ?? (jj ? "Choose a workspace" : "Choose a worktree"),
            detail: tree ? "Branch and Directory describe this worktree; select another worktree to change them." :
              draft.isCreating ? jj ? "Choose the starting revision and directory for the new workspace." :
                "Choose an unused branch or a new branch name, then its directory." : undefined,
            disabled: !ready
          },
          {
            id: "branch", label: tree?.vcs === "jj" ? "Revision" : jj ? "Start from" : "Branch",
            value: tree?.vcs === "jj" ? `${tree.changeId.slice(0, 12)} · ${tree.head.slice(0, 12)}` :
              tree?.vcs === "git" ? tree.branch ?? `Detached HEAD · ${tree.head.slice(0, 12)}` :
                jj ? draft.destination?.revision ? draft.destination.label : draft.clone ? "Cloned default" : "Choose a starting revision" :
                  draft.destination?.branch ?? "Select or type branch",
            detail: tree ? undefined : jj ? "Revision for the new workspace; the source workspace is not moved." :
              "Select an unused existing branch, or type the name of a new branch.",
            isReadOnly: !!tree, disabled: !ready || !tree && !draft.clone && !draft.isCreating
          },
          {
            id: "checkoutName", label: "Directory", value: directory || (draft.clone ? "Choose an absolute directory" : "Choose a branch first"),
            detail: directory, isReadOnly: !!tree, disabled: !ready || !draft.clone && !directory
          },
          {
            id: "mode", label: "Mode", value: draft.clone ? "New tab (cloning)" :
              draft.mode === "auto" ? "Reuse matching tab, otherwise new tab" :
                draft.mode === "new-tab" ? "Always new tab" : "Split matching tab, otherwise new tab",
            isReadOnly: !!draft.clone, disabled: !draft.host
          }
        ]
        return {
          rows: rows.map(row => ({ ...row, disabled: initializing || row.disabled })),
          submitLabel: draft.clone ? "Clone & open" : tree ? jj ? "Open workspace" : "Open worktree" :
            jj ? "Create workspace & open" : "Create worktree & open",
          submitDisabled: initializing || blocked || !draft.host || !(cloneInputFor(draft) || inputFor(draft)),
          notice: draft.clone ? `This project will be cloned onto this machine: ${draft.clone.repo || "choose its Directory"}. Only pushed history transfers.` : undefined,
          error: initializing ? undefined : error ?? (!draft.projectChoice ? "Select a project" : !draft.machine ? "Select a Rex machine"
            : !draft.host ? "Connect to the selected machine and install its worktrees helper if missing"
              : !ready ? "Select the exact project directory on this machine"
                : !draft.destination && !draft.clone ? "Choose an existing worktree or Create new worktree…"
                  : !jj && !tree && !draft.destination?.branch ? "Choose a branch"
                    : jj && draft.isCreating && !draft.destination?.revision && !draft.clone ? "Choose a starting revision"
                      : !directory ? "Choose an absolute directory"
                        : !draft.session ? "Choose an existing Rex session or type a new name" : undefined)
        }
      }
      const initialView = { ...formView(true), notice: "Discovering projects and Rex sessions…" }
      activeView = initialView
      yield* terminal.display(`\x1b[?25l\x1b[H\x1b[2J${renderFormFrame(initialView, "project", yield* terminal.columns, yield* terminal.rows)}\x1b[0J`)
      const initialize = Effect.gen(function*() {
        contextPath = yield* context
        yield* loadMachines
        const initial = machines.find(item => preferredMachine && [item.key, item.selector, item.label].includes(preferredMachine))
          ?? (!preferredMachine ? machines.find(item => item.local) : undefined)
        if (initial) yield* activate(initial)
        else if (preferredMachine) error = `Machine ${preferredMachine} is not in Rex hosts. Select a connected machine.`
        return yield* Effect.succeed<"ready">("ready")
      })
      const initialAction = yield* Effect.raceFirst(initialize,
        chooseField(initialView, "project").pipe(Effect.catchTag("QuitError", () => Effect.succeed<FormField>("cancel"))))
      if (initialAction === "cancel") return
      while (true) {
        const view = formView()
        activeView = view
        const action: FormField = isBranchEditPending ? "branch" :
          yield* chooseField(view, focused).pipe(Effect.catchTag("QuitError", () => Effect.succeed<FormField>("cancel")))
        isBranchEditPending = false
        focused = action
        if (action === "cancel") return
        if (action === "submit") {
          const cloneInput = cloneInputFor(draft)
          if (!draft.host || !(cloneInput || inputFor(draft))) continue
          if (cloneInput) {
            const current = yield* Effect.result(reviewClone(draft.host, command, cloneInput))
            if (Result.isFailure(current)) { error = problem(current.failure); continue }
            const clonePlan = current.success
            if (clonePlan.repo !== cloneInput.repo || clonePlan.hostId !== draft.host.hostId ||
              clonePlan.input.checkout !== cloneInput.checkout || clonePlan.input.directory !== cloneInput.directory) {
              error = clonePlan.hostId !== draft.host.hostId ? "Rex target changed; select the machine again"
                : clonePlan.repo !== cloneInput.repo ? `Clone destination changed; edit the destination: ${clonePlan.repo}`
                  : "Clone helper changed the checkout request; update its plugin and select the machine again"
              blocked = true
              continue
            }
            const launched = yield* Effect.result(submitClone(draft.host, command, cloneInput, clonePlan))
            if (Result.isFailure(launched)) {
              launchAcknowledged = true
              yield* acknowledge("Clone needs inspection",
                [problem(launched.failure), `Destination: ${clonePlan.repo}`,
                  "A clone or Rex tab may already exist. Inspect the destination and session before opening again."], "error", view)
              return yield* Effect.fail(launched.failure)
            }
            if (launched.success.warning) yield* acknowledge("Clone task submitted with warning",
              [`Session: ${launched.success.sessionId}`, `Destination: ${launched.success.repo}`,
                "The clone task was created; Rex may not have focused its tab. Inspect the session before opening again.",
              launched.success.warning], "warning", view)
            return
          }
          const input = inputFor(draft)
          if (!input) continue
          const current = yield* Effect.result(review(draft.host, command, input))
          if (Result.isFailure(current)) { error = problem(current.failure); continue }
          const plan = current.success
          if (plan.hostId !== draft.host.hostId || input.path && plan.path !== input.path ||
            input.directory && plan.path !== input.directory) {
            error = plan.hostId !== draft.host.hostId ? "Rex target changed; select the machine again"
              : `Destination changed; select the worktree again: ${plan.path}`
            blocked = true
            continue
          }
          const launched = yield* Effect.result(submit(draft.host, command, input, plan))
          if (Result.isFailure(launched)) {
            launchAcknowledged = true
            yield* acknowledge("Launch needs inspection",
              [problem(launched.failure), `Destination: ${plan.path}`,
                "The checkout or Rex tab may already have changed. Inspect the session before opening again."], "error", view)
            return yield* Effect.fail(launched.failure)
          }
          if (launched.success.warning || plan.warning) yield* acknowledge("Opened with warning",
            [`Session: ${launched.success.sessionId}`, `Destination: ${launched.success.path}`,
            `Action: ${launched.success.action}`, launched.success.pending
              ? `Task submitted; ${plan.vcs === "jj" ? "JJ" : "Git"} setup may still be running.` : "Existing task focused.",
            ...new Set([plan.warning, launched.success.warning].filter((line): line is string => !!line))], "warning", view)
          return
        }
        if (view.rows.find(row => row.id === action)?.disabled) continue
        error = undefined
        const editing = yield* Effect.result(Effect.gen(function*() {
          if (action === "machine") {
            yield* loadMachines
            if (!machines.length) return yield* Effect.fail(new AppError({ message: error ?? "No Rex machines available" }))
            const machine = yield* choose("Execution machine", machines.map(item =>
              selected(item, item.key === draft.machine?.key, item.label,
                item.local ? "This machine" : `Rex host · ${item.selector}`)))
            yield* activate(machine, true)
          } else if (action === "project") {
            const choices = projects.map(item => ({
              value: item, title: item.name,
              description: `${item.source?.repository.path ?? item.path ?? ""} · ${machines.find(machine => machine.key === item.source?.machineKey)?.label ?? "Source machine"}`
            }))
            const picked = yield* inputChoice({
              message: "Project (select known or type name / absolute path)",
              choices
            })
            const choice: ProjectChoice = picked.kind === "selected" ? picked.value : {
              name: picked.text.trim().split("/").filter(Boolean).at(-1) ?? picked.text.trim(),
              ...(picked.text.trim().startsWith("/") ? { path: picked.text.trim() } : {})
            }
            if (!choice.name) return yield* Effect.fail(new AppError({ message: "Project name is required" }))
            const host = draft.host
            if (host) {
              const available = projects.flatMap(item => item.source?.machineKey === host.key && item.source.hostId === host.hostId
                ? [item.source.repository] : [])
              const inspected = yield* bindProject(choice, host, available)
              if (inspected) {
                draft = changeProjectChoice(draft, choice)
                useProject(inspected)
                if (!available.some(repo => repo.vcs === inspected.project.vcs && repo.commonDir === inspected.project.commonDir))
                  projects.push(known(host, inspected.project, inspected.checkout))
              }
            } else draft = changeProjectChoice(draft, choice)
          } else if (action === "destination") {
            if (!draft.host || !(draft.project || draft.clone)) return yield* Effect.fail(new AppError({ message: "Select a project and machine before choosing a worktree" }))
            const jj = (draft.clone?.vcs ?? draft.project?.vcs) === "jj"
            const found = draft.clone ? undefined : yield* inspectWorktrees(draft.host, command,
              jj ? draft.sourcePath ?? draft.project!.path : draft.project!.path)
            const trees = found?.worktrees.filter(tree => tree.vcs === "jj" || !tree.bare && !tree.prunable) ?? []
            const choices: InputChoice<Worktree | "create" | "primary">[] = trees.map(tree => ({
              value: tree, selected: tree.path === draft.destination?.path,
              title: tree.vcs === "jj" ? `${tree.present ? "" : "Unavailable: "}${tree.name}` : path.basename(tree.path),
              description: tree.vcs === "jj" ? tree.present && tree.path ? `${tree.changeId.slice(0, 12)} · ${tree.path}`
                : `Unavailable · ${tree.path ?? "location unknown"}` : `${tree.branch ?? "Detached HEAD"} · ${tree.path}`
            }))
            if (draft.clone) choices.push({
              value: "primary", selected: !draft.isCreating, title: "Project checkout (after clone)", description: draft.clone.repo
            })
            choices.push({ value: "create", selected: !!draft.isCreating,
              title: jj ? "Create new workspace…" : "Create new worktree…",
              description: jj ? "Choose starting revision and directory" : "Choose branch and directory" })
            const picked = yield* choose(jj ? "Workspace (select existing or create new)" : "Worktree (select existing or create new)", choices)
            if (picked === "primary") {
              const clone = draft.clone!
              draft = { ...draft, isCreating: false, directory: undefined, worktreeName: undefined,
                destination: clone.vcs === "git" && clone.branch ? { branch: clone.branch, label: clone.branch } : undefined }
            } else if (picked === "create") {
              let name = "workspace"
              if (jj) for (let suffix = 2; trees.some(tree => tree.vcs === "jj" && tree.name === name); suffix++) name = `workspace-${suffix}`
              const mainline = (draft.clone?.vcs === "jj" ? draft.clone.revisions : found?.revisions)?.find(choice => choice.expression === "trunk()")
              draft = { ...draft, isCreating: true, directory: undefined, worktreeName: jj ? name : undefined,
                worktreeRoot: found ? found.worktreeRoot : draft.worktreeRoot,
                destination: jj && mainline ? { revision: mainline.revision.commitId, label: mainline.label } :
                  { label: jj ? "Create new workspace…" : "Create new worktree…" } }
              isBranchEditPending = !jj
            } else draft = selectWorktree(draft, picked)
          } else if (action === "checkoutName") {
            const proposed = draft.clone && !draft.isCreating && draft.projectChoice ? clonePath(draft.projectChoice) :
              directoryFor({ ...draft, directory: undefined })
            const picked = yield* inputChoice({
              message: "Directory (absolute path on selected machine)",
              choices: proposed ? [{ value: proposed, title: "Use proposed directory", description: proposed }] : []
            })
            const text = (picked.kind === "selected" ? picked.value : picked.text).trim()
            if (!path.isAbsolute(text) || /[\p{ASCII}&&\p{Cc}]/v.test(text) || path.dirname(path.resolve(text)) === path.resolve(text))
              return yield* Effect.fail(new AppError({ message: "Directory must be an absolute non-root path on this machine" }))
            const directory = path.resolve(text)
            if (draft.clone && !draft.isCreating) draft = { ...draft, clone: { ...draft.clone, repo: directory } }
            else draft = { ...draft, directory,
              ...((draft.clone?.vcs ?? draft.project?.vcs) === "jj" ? { worktreeName: path.basename(directory) } : {}) }
          } else if (action === "branch") {
            if (!draft.host || !(draft.project || draft.clone)) return yield* Effect.fail(new AppError({ message: "Select a project and machine before choosing a base or branch" }))
            const jjClone = draft.clone?.vcs === "jj" ? draft.clone : undefined
            if (draft.project?.vcs === "jj" || jjClone) {
              if (draft.destination?.path) return yield* Effect.fail(new AppError({ message: "Opening an existing workspace does not change its revision" }))
              const found = jjClone ? undefined : yield* inspectWorktrees(draft.host, command, draft.sourcePath ?? draft.project!.path)
              const revisions = jjClone ? jjClone.revisions : found!.revisions
              const picked = yield* inputChoice<JjRevisionChoice | null>({
                message: jjClone ? "Start from source revision (or cloned default)" : "Start from revision for new workspace",
                choices: [
                  ...(jjClone ? [{ value: null, title: "Cloned default", description: "Use the clone's native default" }] : []),
                  ...revisions.map(choice => ({
                    value: choice, title: choice.label,
                    description: `${choice.expression} · ${choice.revision.commitId.slice(0, 12)}`
                  }))
                ]
              })
              if (picked.kind === "selected" && picked.value === null) draft = { ...draft, destination: undefined }
              else {
                let choice: JjRevisionChoice
                if (picked.kind === "selected") choice = picked.value!
                else {
                  const expression = picked.text.trim()
                  if (!expression) return yield* Effect.fail(new AppError({ message: "A singular starting revision is required" }))
                  let sourceHost = draft.host
                  let repo = draft.sourcePath ?? draft.project?.path
                  if (jjClone) {
                    const reference = draft.projectChoice?.source
                    const machine = machines.find(item => item.key === reference?.machineKey)
                    if (!reference || !machine) return yield* Effect.fail(new AppError({ message: "Clone source machine is no longer registered" }))
                    sourceHost = yield* connectMachine(machine)
                    if (sourceHost.hostId !== reference.hostId || sourceHost.hostId !== jjClone.sourceHostId)
                      return yield* Effect.fail(new AppError({ message: "Clone source host identity changed; reselect the project" }))
                    repo = reference.checkoutPath ?? reference.repository.path
                  }
                  const revision: JjRevision = yield* inspectRevision(sourceHost, command, repo!, expression)
                  choice = { expression, label: expression, revision }
                }
                draft = selectRevision(draft, choice)
                if (jjClone) draft = { ...draft, clone: { ...jjClone, revision: choice.revision } }
              }
            } else {
              const clone = draft.clone?.vcs === "git" ? draft.clone : undefined
              const found = clone ? undefined : yield* inspectWorktrees(draft.host, command, draft.project!.path)
              const occupied = new Set<string>()
              for (const tree of found?.worktrees ?? []) if (tree.vcs === "git" && tree.branch) occupied.add(tree.branch)
              if (clone && draft.isCreating && clone.branch) occupied.add(clone.branch)
              const picked = yield* inputChoice({
                message: "Branch (select unused or type new name)",
                choices: (clone?.branches ?? found?.branches ?? []).filter(branch => !occupied.has(branch)).map(branch => ({
                  value: branch, title: branch, description: clone ? "Published branch" : "Existing branch · new worktree"
                }))
              })
              const branch = picked.kind === "selected" ? picked.value : picked.text.trim()
              if (!branch || branch.startsWith("-") || /[\p{ASCII}&&\p{Cc}]/v.test(branch))
                return yield* Effect.fail(new AppError({ message: "Branch name must be a valid Git branch" }))
              if (occupied.has(branch)) return yield* Effect.fail(new AppError({ message: `Branch ${branch} is already checked out; select its existing worktree instead` }))
              draft = { ...draft, destination: { branch, label: branch } }
            }
          } else if (action === "session") {
            if (!draft.host) return yield* Effect.fail(new AppError({ message: "Select a machine before choosing a session" }))
            const found = yield* inspectSessions(draft.host, command)
            sessions = found.sessions
            draft = { ...draft, clientId: focusClient(found.clients) }
            const picked = yield* inputChoice({
              message: "Session (select existing or type new name)",
              choices: sessions.map(item => ({ value: item.id, title: item.label, description: item.id }))
            })
            draft = { ...draft, session: picked.kind === "selected" ? { kind: "existing", id: picked.value } : { kind: "new", name: picked.text } }
          } else if (action === "mode") {
            draft = {
              ...draft, mode: yield* choose<Draft["mode"]>("Open mode", [
                selected<Draft["mode"]>("auto", draft.mode === "auto", "Reuse matching tab", "Focus existing task, otherwise open new tab"),
                selected<Draft["mode"]>("new-tab", draft.mode === "new-tab", "Always new tab"),
                selected<Draft["mode"]>("split", draft.mode === "split", "Split matching task", "Opens new tab when no live target exists")
              ])
            }
          }
        }))
        if (Result.isFailure(editing)) {
          if (!Terminal.isQuitError(editing.failure)) error = problem(editing.failure)
        } else {
          blocked = false
        }
      }
    }).pipe(Effect.catchCause(cause => Cause.hasInterrupts(cause) || launchAcknowledged
      ? Effect.failCause(cause)
      : acknowledge("Could not open worktrees", [Cause.pretty(cause)], "error")
        .pipe(Effect.andThen(Effect.failCause(cause)))),
      Effect.provideServiceEffect(Terminal.Terminal, Effect.gen(function*() {
        // Esc navigates within the popup; it must not end the shared input queue.
        const terminal = yield* BunTerminal.make(({ key }) => key.ctrl && (key.name === "c" || key.name === "d"))
        const input = yield* terminal.readInput
        return { ...terminal, readInput: Effect.succeed(input) }
      })))
  }))
