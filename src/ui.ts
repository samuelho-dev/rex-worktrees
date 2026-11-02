import { Cause, Effect, Option, Queue, Result, Scope, Terminal } from "effect"
import { Prompt } from "effect/cli"
import { connectMachine, discover, inspectProject, inspectRevision, inspectWorktrees, listMachines, review, reviewClone, sourceForClone, submit, submitClone } from "./client.ts"
import { AppError, type ClientTarget, type CloneInput, type ClonePlan, type Color, type Destination, type DestinationHost, type Draft, type FormField, type FormRow, type FormView, type InputChoice, type InputChoiceOptions, type InputChoiceResult, type InputChoiceState, type JjRevision, type JjRevisionChoice, type LaunchInput, type LaunchPlan, type Machine, type NoticeTone, type PopupOrigin, type ProjectChoice, type PromptAction, type Repository, type SessionTarget, type Worktree } from "./contracts.ts"
import { makePopupSizer } from "./rex.ts"
import { sameClonePlan, sameLaunchPlan } from "./worktrees.ts"

const codes: Record<Color, string> = { cyan: "\x1b[36m", amber: "\x1b[33m", muted: "\x1b[90m", red: "\x1b[31m", bold: "\x1b[1m" }
const color = (text: string, tone: Color, enabled: boolean) => enabled ? `${codes[tone]}${text}\x1b[0m` : text
// External project names, paths and Rex labels are display data, never terminal instructions.
const safeDisplayText = (text: string, preserveWhitespace = false) => {
  const cleaned = Bun.stripANSI(text).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
  return preserveWhitespace ? cleaned : cleaned.replace(/\s+/g, " ").trim()
}
const fit = (text: string, width: number) => Bun.stringWidth(text) > width ? Bun.sliceAnsi(text, 0, Math.max(0, width), { ellipsis: "…" }) : text
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))

/** Pure frame used by the terminal painter and the narrow-screen/security checks. */
export const renderFormFrame = (view: FormView, focused: FormField, editing: boolean, columns: number, rows: number, colors = !process.env.NO_COLOR, fill = true): string => {
  const width = Math.max(20, columns)
  const inside = width - 4
  const screen: string[] = []
  const border = (body: string) => `${color("│", "muted", colors)} ${pad(body, inside)} ${color("│", "muted", colors)}`
  const line = (left: string, right: string) => color(`${left}${"─".repeat(width - 2)}${right}`, "muted", colors)
  const add = (text: string) => screen.push(border(fit(text, inside)))
  screen.push(line("┌", "┐"))
  const heading = `${color("REX", "cyan", colors)} ${color("/ WORKTREES", "bold", colors)}`
  add(heading)
  screen.push(line("├", "┤"))
  // ponytail: reserve exactly the editor's four/six rows at this terminal height.
  const budget = Math.max(0, rows - (editing ? rows >= 20 ? 11 : 9 : 7))
  const body: string[] = []
  const addBody = (text: string) => body.push(border(fit(text, inside)))
  const addWrapped = (text: string, tone: Color, limit = budget) => {
    for (const part of Bun.wrapAnsi(safeDisplayText(text), inside - 2, { hard: true }).split("\n")) {
      if (body.length >= limit) break
      addBody(`  ${color(part, tone, colors)}`)
    }
  }
  for (const row of view.rows) {
    const active = focused === row.id
    const label = pad(fit(safeDisplayText(row.label).toUpperCase(), 13), 13)
    const value = safeDisplayText(row.value) || "—"
    const room = Math.max(1, inside - 19)
    const indicator = active ? color("›", "cyan", colors) : " "
    addBody(`${indicator} ${color(label, row.disabled ? "muted" : active ? "cyan" : "bold", colors)}  ${color(fit(value, room), row.disabled ? "muted" : active ? "bold" : "muted", colors)}`)
    if (!editing && row.detail && (row.id === "destination" && row.detail.startsWith("/") || !view.error && active) && body.length < budget - 3)
      addWrapped(row.detail, "muted", budget - 3)
  }
  if (view.error) {
    const errorLimit = budget - (view.fitWarning && budget - body.length > 1 ? 1 : 0)
    addWrapped(view.error, "red", errorLimit)
  } else if (view.notice) addWrapped(view.notice, "amber")
  if (view.fitWarning) addWrapped(view.fitWarning, "amber")
  if (view.error && view.notice && body.length < budget) addBody(`  ${color(fit(safeDisplayText(view.notice), inside - 2), "amber", colors)}`)
  if (fill) while (body.length < budget) addBody("")
  screen.push(...body.slice(0, budget))
  if (!editing) {
    screen.push(line("├", "┤"))
    const submit = focused === "submit" ? color("›", "cyan", colors) : " "
    const cancel = focused === "cancel" ? color("›", "cyan", colors) : " "
    add(`${submit} ${color(fit(safeDisplayText(view.submitLabel), Math.max(1, inside - 19)), view.submitDisabled ? "muted" : "cyan", colors)}     ${cancel} ${color("Cancel", focused === "cancel" ? "cyan" : "muted", colors)}`)
    add(color("  ↑↓ / jk move · Tab next · Enter select · Ctrl+S submit · Esc close", "muted", colors))
  }
  screen.push(line("└", "┘"))
  // Native Effect editors need a following line; the main form must not scroll past its bottom border.
  return screen.join("\r\n") + (editing ? "\r\n" : "")
}

/** Size from unclipped content, including the tallest focus detail and the editor reserve. */
export const naturalFormRows = (view: FormView, columns: number, editing = false): number => {
  const fields: FormField[] = [...view.rows.map(row => row.id), "submit"]
  return Math.max(...fields
    .map(field => renderFormFrame(view, field, editing, columns, 1000, false, false).split("\r\n").length - (editing ? 1 : 0))) + (editing ? 6 : 0)
}
// ponytail: keep the main viewport stable; editors reserve six more rows but still grow for content.
export const popupTargetRows = (view: FormView, columns: number, editing = false): number =>
  Math.max(16 + (editing ? 6 : 0), naturalFormRows(view, Math.min(96, columns), editing))

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
  message: string, state: InputChoiceState, choices: readonly InputChoice<A>[], columns: number, rows: number, colors = !process.env.NO_COLOR, selectionOnly = false
): string => {
  const width = Math.max(20, columns) - 2
  const matches = matchingChoices(choices, state.text)
  const count = rows >= 20 ? 3 : 1
  const selected = matches.indexOf(state.selected ?? -1)
  const start = selected < 0 ? 0 : Math.max(0, Math.min(selected, matches.length - count))
  const lines = [`  ${fit(safeDisplayText(message), width - 2)}`,
  `  ${color("›", "cyan", colors)} ${fit(safeDisplayText(state.text, true) || (selectionOnly ? "Filter exact choices…" : "Type new value…"), width - 4)}`]
  for (const index of matches.slice(start, start + count)) {
    const choice = choices[index]
    if (!choice) continue
    const label = `${state.selected === index ? "›" : " "} ${safeDisplayText(choice.title)}${choice.description ? ` · ${safeDisplayText(choice.description)}` : ""}`
    lines.push(`  ${fit(label, width - 2)}`)
  }
  while (lines.length < count + 2) lines.push("")
  lines.push(`  ${fit(selectionOnly ? "Enter selected · ↑↓ choose · Ctrl+U clear · Esc back" : "Enter typed/selected · ↑↓ choose · Ctrl+U clear · Esc back", width - 2)}`)
  return lines.join("\r\n")
}

const acknowledge = (title: string, lines: readonly string[], tone: NoticeTone): Effect.Effect<void, Terminal.QuitError, Prompt.Environment> =>
  Prompt.run(Prompt.Custom<boolean, void>(false, {
    render: (_, action) => action._tag === "Submit" ? Effect.succeed("") : Effect.gen(function*() {
      const terminal = yield* Terminal.Terminal
      const width = Math.max(20, yield* terminal.columns)
      const height = yield* terminal.rows
      const active = !process.env.NO_COLOR
      const output = [color(`  REX / ${safeDisplayText(title)}`, tone === "error" ? "red" : tone === "warning" ? "amber" : "cyan", active), ""]
      for (const line of lines) {
        for (const part of Bun.wrapAnsi(safeDisplayText(line), width - 4, { hard: true }).split("\n")) {
          if (output.length >= height - 3) break
          output.push(`  ${part}`)
        }
      }
      output.push("", color("  Enter / Space confirm · Esc / Ctrl+C close", "muted", active))
      return `\x1b[H\x1b[2J${output.join("\r\n")}\r\n`
    }),
    clear: () => Effect.succeed(""),
    process: (input) => Effect.succeed<PromptAction<boolean, void>>(input.key.name === "enter" || input.key.name === "return" || input.key.name === "space" || input.key.name === "escape" || input.key.ctrl && input.key.name === "c"
      ? { _tag: "Submit", value: undefined }
      : { _tag: "Beep" })
  })).pipe(Effect.catch(() => Effect.void))

const problem = (error: unknown) => error instanceof AppError ? error.message : Cause.pretty(Cause.fail(error))
const selected = <T>(value: T, current: boolean, title: string, description?: string): InputChoice<T> => ({ value, selected: current, title, description })
export const generatedName = (draft: Draft) => draft.worktreeName ??
  (draft.clone?.vcs === "jj" ? draft.projectChoice?.name : draft.destination?.label) ??
  draft.projectChoice?.name ?? "Worktree"
export const inputFor = (draft: Draft): LaunchInput | undefined => {
  if (!draft.host || !draft.project || !draft.projectChoice || !draft.destination || !draft.session) return undefined
  const common = {
    repo: draft.project.vcs === "jj" ? draft.sourcePath ?? draft.project.path : draft.project.path,
    session: draft.session, name: generatedName(draft),
    clientId: draft.clientId, additional: draft.mode === "new-tab", split: draft.mode === "split"
  }
  if (draft.project.vcs === "jj") return draft.destination.path
    ? { ...common, vcs: "jj", path: draft.destination.path }
    : draft.worktreeName && draft.destination.revision
      ? { ...common, vcs: "jj", worktreeName: draft.worktreeName, revision: draft.destination.revision }
      : undefined
  return draft.destination.branch
    ? { ...common, vcs: "git", branch: draft.destination.branch, ...(draft.worktreeName ? { worktreeName: draft.worktreeName } : {}) }
    : { ...common, vcs: "git", path: draft.destination.path }
}

// A logical choice survives a machine failure; no path/session/checkout from the previous host does.
export const changeMachine = (draft: Draft, machine: Machine): Draft => draft.machine?.key === machine.key
  ? { ...draft, machine }
  : { machine, projectChoice: draft.projectChoice, mode: draft.mode }
export const changeProjectChoice = (draft: Draft, projectChoice: ProjectChoice): Draft => ({
  ...draft, projectChoice, project: undefined, clone: undefined, destination: undefined,
  worktreeName: undefined, sourcePath: undefined
})
export const changeProject = (draft: Draft, candidate: Repository): Draft => ({
  ...draft, project: candidate, clone: undefined,
  destination: draft.project?.vcs === candidate.vcs && draft.project.commonDir === candidate.commonDir ? draft.destination : undefined,
  worktreeName: draft.project?.vcs === candidate.vcs && draft.project.commonDir === candidate.commonDir ? draft.worktreeName : undefined,
  sourcePath: candidate.vcs === "jj" && draft.project?.vcs === "jj" && draft.project.commonDir === candidate.commonDir
    ? draft.sourcePath : undefined
})
export const changeDestination = (draft: Draft, candidate: Destination, worktreeName?: string): Draft => ({
  ...draft, destination: candidate, worktreeName: candidate.path ? undefined : worktreeName
})
export const selectWorktree = (draft: Draft, tree: Worktree): Draft => {
  if (!tree.path || tree.vcs === "jj" && !tree.present)
    throw new AppError({ message: `Workspace ${tree.vcs === "jj" ? tree.name : tree.path} is unavailable; inspect its registered location before opening` })
  return {
    ...changeDestination(draft, {
      path: tree.path, label: tree.vcs === "jj" ? tree.name
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
export const typeWorktreeName = (draft: Draft, name: string, mainline?: JjRevisionChoice): Draft => ({
  ...draft, worktreeName: name,
  destination: draft.destination && !draft.destination.path ? draft.destination :
    draft.project?.vcs === "jj" && !draft.clone && mainline
      ? { revision: mainline.revision.commitId, label: mainline.label } : undefined
})
export const selectRevision = (draft: Draft, choice: JjRevisionChoice): Draft =>
  changeDestination(draft, { revision: choice.revision.commitId, label: choice.label }, draft.worktreeName)

export const cloneInputFor = (draft: Draft): CloneInput | undefined => {
  if (!draft.host || !draft.clone || !draft.session || !draft.clone.repo.startsWith("/")) return undefined
  if (draft.clone.vcs === "jj") return {
    vcs: "jj", source: {
      vcs: "jj", url: draft.clone.url, sourceHostId: draft.clone.sourceHostId,
      revisions: draft.clone.revisions, ...(draft.clone.revision ? { revision: draft.clone.revision } : {})
    },
    repo: draft.clone.repo, session: draft.session, clientId: draft.clientId,
    name: generatedName(draft), ...(draft.worktreeName ? { worktreeName: draft.worktreeName } : {}),
    ...(draft.destination?.revision ? { revision: draft.destination.revision } : {})
  }
  if (!draft.destination?.branch) return undefined
  return {
    vcs: "git", source: {
      vcs: "git", url: draft.clone.url, sourceHostId: draft.clone.sourceHostId,
      branches: draft.clone.branches, branch: draft.clone.branch
    },
    repo: draft.clone.repo, session: draft.session, clientId: draft.clientId,
    name: generatedName(draft), branch: draft.destination.branch,
    branchMode: draft.clone.branches.includes(draft.destination.branch) ? "existing" : "create",
    ...(draft.worktreeName ? { worktreeName: draft.worktreeName } : {})
  }
}

export const popup = <E, R>(command: readonly string[], context: Effect.Effect<string | undefined, E, R>, origin: PopupOrigin = {}, preferredMachine?: string) =>
  Effect.scoped(Effect.suspend(() => {
    let launchAcknowledged = false
    return Effect.gen(function*() {
      const terminal = yield* Terminal.Terminal
      yield* Effect.acquireRelease(
        terminal.display("\x1b[?1049h"),
        () => terminal.display("\x1b[?25h\x1b[?1049l").pipe(Effect.orDie)
      )
      let machines: Machine[] = []
      let draft: Draft = { mode: "auto" }
      let sessions: readonly SessionTarget[] = []
      let focused: FormField = "project"
      let error: string | undefined
      let plan: LaunchPlan | undefined
      let optionsExpanded = false
      let clonePlan: ClonePlan | undefined
      let cloneRoot = ""
      let cloneRoots: readonly string[] = []
      let contextPath: string | undefined
      const resizePopup = yield* makePopupSizer
      let activeView: FormView | undefined
      let repaint: Queue.Queue<Terminal.Size> | undefined
      const fitRequests = yield* Queue.sliding<{ view: FormView; columns: number; rows: number; editing: boolean }>(1)
      yield* Effect.forever(Effect.gen(function*() {
        const { view, columns, rows, editing } = yield* Queue.take(fitRequests)
        const warning = yield* resizePopup(
          { columns: 96, rows: popupTargetRows(view, columns, editing) },
          { columns, rows }
        )
        if (activeView !== view) return
        const changed = view.fitWarning !== warning
        view.fitWarning = warning
        if (changed && repaint) yield* Queue.offer(repaint, { columns, rows })
      })).pipe(Effect.forkScoped)
      const chooseField: (view: FormView, initialFocus: FormField) => Effect.Effect<FormField, Terminal.QuitError, Prompt.Environment> =
        Effect.fnUntraced(function*(view: FormView, initialFocus: FormField) {
          const terminal = yield* Terminal.Terminal
          const size = yield* terminal.size
          const resized = yield* Queue.sliding<Terminal.Size>(1)
          yield* Effect.acquireRelease(Effect.sync(() => { repaint = resized }), () => Effect.sync(() => { repaint = undefined }))
          yield* Effect.forever(Queue.take(size).pipe(Effect.flatMap(value => Queue.offer(resized, value)))).pipe(Effect.forkScoped)
          const fields: FormField[] = [...view.rows.map(row => row.id), "submit", "cancel"]
          const initial = Math.max(0, fields.indexOf(initialFocus))
          const prompt = Prompt.Custom<number, FormField, Terminal.Size>(initial, resized, {
            render: (index, action) => action._tag === "Submit" ? Effect.succeed("") : Effect.gen(function*() {
              const columns = yield* terminal.columns
              const rows = yield* terminal.rows
              yield* Queue.offer(fitRequests, { view, columns, rows, editing: false })
              return `\x1b[H\x1b[2J${renderFormFrame(view, fields[index], false, columns, rows)}`
            }),
            clear: () => Effect.succeed(""),
            process: (event, index) => {
              if (event._tag === "Event") return Effect.succeed<PromptAction<number, FormField>>({ _tag: "NextFrame", state: index })
              const { key } = event.input
              if (key.name === "escape" || key.ctrl && key.name === "c") return Effect.succeed<PromptAction<number, FormField>>({ _tag: "Submit", value: "cancel" })
              if (key.ctrl && key.name === "s") return Effect.succeed<PromptAction<number, FormField>>(view.submitDisabled
                ? { _tag: "Beep" } : { _tag: "Submit", value: "submit" })
              if (key.name === "enter" || key.name === "return") {
                const selected = fields[index]
                return Effect.succeed<PromptAction<number, FormField>>(selected === "submit" && view.submitDisabled || view.rows.some(row => row.id === selected && row.disabled)
                  ? { _tag: "Beep" }
                  : { _tag: "Submit", value: selected })
              }
              const backward = key.name === "up" || key.name === "k" && !key.ctrl || key.name === "backtab" || key.name === "tab" && key.shift
              const forward = key.name === "down" || key.name === "j" && !key.ctrl || key.name === "tab"
              return Effect.succeed<PromptAction<number, FormField>>(backward || forward
                ? { _tag: "NextFrame", state: (index + (backward ? -1 : 1) + fields.length) % fields.length }
                : { _tag: "Beep" })
            }
          })
          return yield* Prompt.run(prompt)
        }, Effect.scoped)
      const inputChoice: <A>(options: InputChoiceOptions<A>) => Effect.Effect<InputChoiceResult<A>, Terminal.QuitError, Prompt.Environment> =
        Effect.fnUntraced(function*<A>(options: InputChoiceOptions<A>): Effect.fn.Return<InputChoiceResult<A>, Terminal.QuitError, Prompt.Environment | Scope.Scope> {
          const terminal = yield* Terminal.Terminal
          const size = yield* terminal.size
          const resized = yield* Queue.sliding<Terminal.Size>(1)
          yield* Effect.forever(Queue.take(size).pipe(Effect.flatMap(value => Queue.offer(resized, value)))).pipe(Effect.forkScoped)
          yield* Effect.acquireRelease(Effect.sync(() => { repaint = resized }), () => Effect.sync(() => { repaint = undefined }))
          const result = yield* Prompt.run(Prompt.Custom<InputChoiceState, InputChoiceResult<A> | null, Terminal.Size>(
            { text: "", selected: options.selected === undefined || options.selected < 0 ? null : options.selected }, resized, {
            render: (state, action) => action._tag === "Submit" ? Effect.succeed("") : Effect.gen(function*() {
              const columns = yield* terminal.columns
              const rows = yield* terminal.rows
              const view = activeView
              if (view) yield* Queue.offer(fitRequests, { view, columns, rows, editing: true })
              const editor = renderInputChoice(options.message, state, options.choices, columns, rows, !process.env.NO_COLOR, options.selectionOnly)
              if (!view) return ""
              return `\x1b[H\x1b[2J${renderFormFrame(view, focused, true, columns, rows)}${editor}`
            }),
            clear: () => Effect.succeed(""),
            process: (event, state) => Effect.succeed<PromptAction<InputChoiceState, InputChoiceResult<A> | null>>(
              event._tag === "Event" ? { _tag: "NextFrame", state }
                : advanceInputChoice(state, event.input, options.choices, options.selectionOnly))
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
          ...draft, projectChoice: choice, host, project: undefined,
          clone: { ...source, repo }, destination: source.vcs === "git" && source.branch
            ? { branch: source.branch, label: source.branch } : undefined,
          worktreeName: undefined
        }
      })
      const cloneDestination = Effect.fnUntraced(function*(choice: ProjectChoice, host: DestinationHost) {
        let repo = clonePath(choice)
        if (!repo) {
          const picked = yield* inputChoice<string>({
            message: "Project name is not a safe clone directory; type an absolute clone destination",
            choices: []
          })
          repo = picked.kind === "selected" ? picked.value : picked.text.trim()
        }
        if (!repo.startsWith("/")) return yield* Effect.fail(new AppError({ message: "Clone destination must be an absolute path on this machine" }))
        yield* proposeClone(choice, host, repo)
      })
      const bindProject = Effect.fnUntraced(function*(choice: ProjectChoice, host: DestinationHost, available: readonly Repository[]) {
        const source = choice.source
        let path = source?.machineKey === host.key && source.hostId === host.hostId
          ? source.checkoutPath ?? source.repository.path : undefined
        if (!path && choice.path?.startsWith("/")) path = choice.path
        if (source && (source.machineKey !== host.key || source.hostId !== host.hostId)) {
          if (path) yield* proposeClone(choice, host, path)
          else yield* cloneDestination(choice, host)
          return undefined
        }
        if (!path) {
          const directory = yield* inputChoice({
            message: `Project directory on ${host.label} (existing checkout; absolute path)`,
            choices: available.map(repo => ({ value: repo.path, title: repo.name, description: repo.path }))
          })
          path = directory.kind === "selected" ? directory.value : directory.text.trim()
        }
        if (!path.startsWith("/")) return yield* Effect.fail(new AppError({ message: "Project directory must be an absolute path on this machine" }))
        const inspected = yield* Effect.result(inspectProject(host, command, path))
        if (Result.isFailure(inspected)) {
          if (choice.source && inspected.failure instanceof AppError &&
            inspected.failure.message.startsWith("Project directory does not exist:")) {
            yield* proposeClone(choice, host, path)
            return undefined
          }
          return yield* Effect.fail(inspected.failure)
        }
        if (source?.machineKey === host.key && source.hostId === host.hostId &&
          (inspected.success.project.vcs !== source.repository.vcs ||
            inspected.success.project.commonDir !== source.repository.commonDir))
          return yield* Effect.fail(new AppError({ message: "Project directory changed; select the exact project directory again" }))
        return inspected.success
      })
      const activate = Effect.fnUntraced(function*(machine: Machine) {
        const previousHostId = draft.host?.hostId
        draft = changeMachine(draft, machine)
        const discoveredContext = machine.local ? contextPath : undefined
        contextPath = undefined
        const connected = yield* Effect.result(connectMachine(machine))
        if (Result.isFailure(connected)) {
          draft = { machine, projectChoice: draft.projectChoice, mode: draft.mode }; sessions = []; plan = undefined; clonePlan = undefined; cloneRoot = ""; cloneRoots = []
          error = problem(connected.failure)
          return
        }
        if (previousHostId && previousHostId !== connected.success.hostId) {
          draft = { machine, projectChoice: draft.projectChoice, mode: draft.mode }
          sessions = []; plan = undefined; clonePlan = undefined
        }
        draft = { ...draft, host: connected.success }
        const discovered = yield* Effect.result(discover(connected.success, command, discoveredContext))
        if (Result.isFailure(discovered)) {
          draft = { machine, projectChoice: draft.projectChoice, mode: draft.mode }; sessions = []; plan = undefined; clonePlan = undefined; cloneRoot = ""; cloneRoots = []
          error = problem(discovered.failure)
          return
        }
        const found = discovered.success
        cloneRoot = found.cloneRoot
        cloneRoots = found.roots
        projects = [...projects.filter(item => item.source?.machineKey !== machine.key || item.source.hostId !== connected.success.hostId),
        ...found.projects.map(repo => known(connected.success, repo, found.checkout))]
        sessions = found.sessions
        draft = {
          ...draft, session: draft.session?.kind === "new" ? draft.session
            : sessions.some(item => item.id === (draft.session?.kind === "existing" ? draft.session.id : undefined)) ? draft.session
              : connected.success.local && origin.sessionId && sessions.some(item => item.id === origin.sessionId) ? { kind: "existing", id: origin.sessionId }
                : sessions.length === 1 ? { kind: "existing", id: sessions[0]!.id } : undefined,
          clientId: focusClient(found.clients)
        }
        if (!draft.projectChoice && found.checkout && discoveredContext) {
          const inspected = yield* Effect.result(inspectProject(connected.success, command, found.checkout.path))
          if (Result.isFailure(inspected)) { error = problem(inspected.failure); return }
          if (Result.isSuccess(inspected)) {
            draft = changeProjectChoice(draft,
              known(connected.success, inspected.success.project, inspected.success.checkout))
            draft = changeProject(draft, inspected.success.project)
            if (inspected.success.checkout.vcs === "jj") draft = { ...draft, sourcePath: inspected.success.checkout.path }
            const tree = inspected.success.worktrees.find(item => item.path === found.checkout?.path &&
              (item.vcs === "jj" ? item.present : !item.bare && !item.prunable))
            if (tree) draft = selectWorktree(draft, tree)
          }
        } else if (draft.projectChoice) {
          const inspected = yield* Effect.result(bindProject(draft.projectChoice, connected.success, found.projects))
          if (Result.isFailure(inspected)) {
            if (!Terminal.isQuitError(inspected.failure)) error = problem(inspected.failure)
            return
          }
          if (inspected.success) {
            draft = changeProject(draft, inspected.success.project)
            if (inspected.success.checkout.vcs === "jj" && !draft.sourcePath)
              draft = { ...draft, sourcePath: inspected.success.checkout.path }
            if (!draft.destination) {
              const checkoutPath = inspected.success.checkout.path
              const tree = inspected.success.worktrees.find(item => item.path === checkoutPath &&
                (item.vcs === "jj" ? item.present : !item.bare && !item.prunable))
              if (tree) draft = selectWorktree(draft, tree)
            }
          }
        }
        error = undefined

      })
      const formView = (initializing = false): FormView => {
        const rows: FormRow[] = [
          { id: "project", label: "Project", value: draft.projectChoice?.name ?? "Choose a project" },
          {
            id: "machine", label: "Machine", value: draft.machine?.label ?? "Choose Rex host",
            detail: draft.host ? `Host ID: ${draft.host.hostId}` : draft.machine?.selector
          },
          {
            id: "destination", label: draft.clone ? "Clone to" : draft.project?.vcs === "jj" ? "Workspace" : "Checkout",
            value: draft.clone?.repo ?? draft.destination?.label ?? (draft.project?.vcs === "jj" ? draft.worktreeName : undefined) ??
              (draft.project?.vcs === "jj" ? "Choose workspace or type new name" : "Choose checkout or type branch"),
            detail: draft.clone?.repo ?? draft.destination?.path,
            disabled: !draft.host || !(draft.project || draft.clone)
          },
          {
            id: "session", label: "Session", value: draft.session?.kind === "new" ? `New: ${draft.session.name}`
              : sessions.find(s => s.id === (draft.session?.kind === "existing" ? draft.session.id : undefined))?.label ?? (draft.session?.kind === "existing" ? draft.session.id : "Choose or type new session"),
            detail: draft.session?.kind === "existing" ? draft.session.id : draft.session?.kind === "new" ? "Create on confirmation" : undefined, disabled: !draft.host
          },
          { id: "options", label: "Options", value: optionsExpanded ? "Hide options ↑" : "Show options ↓" }
        ]
        if (draft.project?.vcs === "jj" && !draft.destination?.path || optionsExpanded && draft.clone?.vcs === "jj")
          rows.push({
            id: "branch", label: "Start from",
            value: draft.destination?.revision ? draft.destination.label : draft.clone ? "Cloned default" : "Select or type revision",
            disabled: !draft.host || !(draft.project || draft.clone) || (!!draft.project && !draft.clone && !draft.worktreeName)
          })
        if (optionsExpanded) {
          if (draft.clone || draft.project?.vcs === "git") rows.push({
            id: "checkoutName", label: draft.clone?.vcs === "jj" ? "Workspace name" : "Directory name",
            value: draft.worktreeName ?? (draft.clone?.vcs === "jj" ? "Use cloned default workspace" : "Default (derived from branch)"),
            disabled: !draft.host || !(draft.project || draft.clone) || !!draft.destination?.path && !draft.clone
          })
          if (draft.clone?.vcs === "git") rows.push({
            id: "branch", label: "Branch", value: draft.destination?.branch ?? "Select or type branch",
            disabled: !draft.host
          })
          if (!draft.clone) rows.push({
            id: "mode", label: "Mode", value: draft.mode === "auto" ? "Reuse matching tab, otherwise new tab"
              : draft.mode === "new-tab" ? "Always new tab" : "Split matching tab, otherwise new tab", disabled: !draft.host
          })
        }
        const safeOpen = !draft.clone && !!draft.destination?.path && draft.session?.kind === "existing"
        return {
          rows: rows.map(row => ({ ...row, disabled: initializing || row.disabled })),
          submitLabel: clonePlan?.label ?? plan?.label ?? (draft.clone ? "Review clone" : safeOpen ? "Open checkout" : "Review & open"),
          submitDisabled: initializing || !draft.host || !(cloneInputFor(draft) || inputFor(draft)),
          notice: [clonePlan || plan ? "Review this action; submit again to launch" : draft.clone ? "Only pushed history transfers" : undefined,
          plan ? `Destination: ${plan.path}` : undefined, clonePlan?.detail,
          clonePlan?.vcs === "jj" ? `Start from: ${draft.destination?.revision ? `${draft.destination.label} (${draft.destination.revision})` : "cloned default"}` : undefined,
          clonePlan?.warning, plan?.detail, plan?.warning].filter(Boolean).join(" · ") || undefined,
          error: initializing ? undefined : error ?? (!draft.projectChoice ? "Select a project" : !draft.machine ? "Select a Rex machine"
            : !draft.host ? "Connect to the selected machine and install its worktrees helper if missing"
              : !(draft.project || draft.clone) ? "Select the exact project directory on this machine"
                : !draft.destination && draft.project?.vcs !== "jj" && draft.clone?.vcs !== "jj" ? "Select a branch"
                  : draft.project?.vcs === "jj" && (!draft.worktreeName && !draft.destination?.path || !!draft.worktreeName && !draft.destination?.revision)
                    ? "Choose an existing workspace or a new workspace name and starting revision"
                    : !draft.session ? "Choose an existing Rex session or type a new name" : undefined),
          fitWarning: activeView?.fitWarning
        }
      }
      const initialView = formView(true)
      activeView = initialView
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
        const action: FormField = yield* chooseField(view, focused).pipe(Effect.catchTag("QuitError", () => Effect.succeed<FormField>("cancel")))
        focused = action
        if (action === "cancel") return
        if (action === "submit") {
          const cloneInput = cloneInputFor(draft)
          if (!draft.host || !(cloneInput || inputFor(draft))) continue
          if (cloneInput) {
            const current = yield* Effect.result(reviewClone(draft.host, command, cloneInput))
            if (Result.isFailure(current)) { error = problem(current.failure); clonePlan = undefined; continue }
            if (!clonePlan || !sameClonePlan(current.success, clonePlan)) {
              error = clonePlan ? "Clone destination or Rex target changed; review the updated URL and destination before submitting again" : undefined
              clonePlan = current.success
              continue
            }
            const launched = yield* Effect.result(submitClone(draft.host, command, cloneInput, clonePlan))
            if (Result.isFailure(launched)) {
              launchAcknowledged = true
              yield* acknowledge("Clone needs inspection",
                [problem(launched.failure), `Destination: ${clonePlan.repo}`,
                  "A clone or Rex tab may already exist. Inspect the destination and session before opening again."], "error")
              return yield* Effect.fail(launched.failure)
            }
            if (launched.success.warning) yield* acknowledge("Clone task submitted with warning",
              [`Session: ${launched.success.sessionId}`, `Destination: ${launched.success.repo}`,
                "The clone task was created; Rex may not have focused its tab. Inspect the session before opening again.",
              launched.success.warning], "warning")
            return
          }
          const input = inputFor(draft)
          if (!input) continue
          const current = yield* Effect.result(review(draft.host, command, input))
          if (Result.isFailure(current)) { error = problem(current.failure); plan = undefined; continue }
          if (plan && !sameLaunchPlan(current.success, plan)) {
            error = "Destination or Rex target changed; review the updated action before submitting again"
            plan = current.success
            continue
          }
          if (!plan) {
            const safeOpen = !!draft.destination?.path && draft.session?.kind === "existing" &&
              current.success.checkout === "existing" && current.success.path === draft.destination.path &&
              !current.success.detail && !current.success.warning
            plan = current.success
            if (!safeOpen) { error = undefined; continue }
          }
          const launched = yield* Effect.result(submit(draft.host, command, input, plan))
          if (Result.isFailure(launched)) {
            launchAcknowledged = true
            yield* acknowledge("Launch needs inspection",
              [problem(launched.failure), `Destination: ${plan.path}`,
                "The checkout or Rex tab may already have changed. Inspect the session before opening again."], "error")
            return yield* Effect.fail(launched.failure)
          }
          if (launched.success.warning || plan.warning) yield* acknowledge("Opened with warning",
            [`Session: ${launched.success.sessionId}`, `Destination: ${launched.success.path}`,
            `Action: ${launched.success.action}`, launched.success.pending
              ? `Task submitted; ${plan.vcs === "jj" ? "JJ" : "Git"} setup may still be running.` : "Existing task focused.",
            ...new Set([plan.warning, launched.success.warning].filter((line): line is string => !!line))], "warning")
          return
        }
        if (view.rows.find(row => row.id === action)?.disabled) continue
        if (action === "options") { optionsExpanded = !optionsExpanded; continue }
        error = undefined
        const editing = yield* Effect.result(Effect.gen(function*() {
          if (action === "machine") {
            yield* loadMachines
            if (!machines.length) return yield* Effect.fail(new AppError({ message: error ?? "No Rex machines available" }))
            const machine = yield* choose("Execution machine", machines.map(item =>
              selected(item, item.key === draft.machine?.key, item.label,
                item.local ? "This machine" : `Rex host · ${item.selector}`)))
            yield* activate(machine)
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
              const found = yield* discover(host, command)
              cloneRoots = found.roots
              const inspected = yield* bindProject(choice, host, found.projects)
              if (inspected) {
                draft = changeProjectChoice(draft, choice)
                draft = changeProject(draft, inspected.project)
                if (inspected.checkout.vcs === "jj") draft = { ...draft, sourcePath: inspected.checkout.path }
                const tree = inspected.worktrees.find(item => item.path === inspected.checkout.path &&
                  (item.vcs === "jj" ? item.present : !item.bare && !item.prunable))
                if (tree) draft = selectWorktree(draft, tree)
              }
              projects = [...projects.filter(item => item.source?.machineKey !== host.key ||
                item.source.hostId !== host.hostId),
              ...found.projects.map(repo => known(host, repo, found.checkout))]
              sessions = found.sessions
              if (draft.session?.kind === "existing" && !sessions.some(item => item.id === (draft.session?.kind === "existing" ? draft.session.id : undefined)))
                draft = { ...draft, session: sessions.length === 1 ? { kind: "existing", id: sessions[0]!.id } : undefined }
              draft = { ...draft, clientId: focusClient(found.clients) }
            } else draft = changeProjectChoice(draft, choice)
          } else if (action === "destination") {
            if (!draft.host || !(draft.project || draft.clone)) return yield* Effect.fail(new AppError({ message: "Select a project and machine before choosing a worktree" }))
            if (draft.clone) {
              const clone = draft.clone
              const picked = yield* inputChoice({
                message: "Clone to (absolute destination path on selected machine)",
                choices: [
                  { value: clone.repo, title: "Current clone destination", description: clone.repo },
                  ...cloneRoots.map(root => ({
                    value: `${root.replace(/\/$/, "")}/${draft.projectChoice?.name ?? "project"}`,
                    title: "Configured root suggestion", description: `${root.replace(/\/$/, "")}/${draft.projectChoice?.name ?? "project"}`
                  }))
                ]
              })
              const repo = (picked.kind === "selected" ? picked.value : picked.text).trim()
              if (!repo.startsWith("/")) return yield* Effect.fail(new AppError({ message: "Clone destination must be an absolute path on this machine" }))
              draft = { ...draft, clone: { ...clone, repo } }
            } else {
              const found = yield* inspectWorktrees(draft.host, command,
                draft.project!.vcs === "jj" ? draft.sourcePath ?? draft.project!.path : draft.project!.path)
              const trees = found.worktrees.filter(tree => tree.vcs === "jj" || !tree.bare && !tree.prunable)
              const git = draft.project!.vcs === "git"
              const picked = yield* inputChoice<Worktree | "clone" | { kind: "branch"; value: string }>({
                message: git ? "Checkout (select exact worktree or branch, or type new branch)" :
                  "Workspace (select existing, Clone this project, or type new workspace name)",
                choices: [
                  ...trees.map(tree => ({
                    value: tree, title: tree.vcs === "jj" ? tree.name
                      : tree.path.split("/").filter(Boolean).at(-1) ?? tree.path,
                    description: tree.vcs === "jj"
                      ? tree.present && tree.path ? `${tree.changeId.slice(0, 12)} · ${tree.path}`
                        : `Unavailable · ${tree.path ?? "location unknown"}`
                      : `${tree.branch ?? "Detached HEAD"} · ${tree.path}`
                  })),
                  ...(git ? found.branches.map(branch => ({
                    value: { kind: "branch" as const, value: branch }, title: `Branch: ${branch}`,
                    description: trees.find(tree => tree.vcs === "git" && tree.branch === branch)?.path ?? "Free branch — attach new checkout"
                  })) : []),
                  ...(draft.projectChoice?.source ? [{
                    value: "clone" as const, title: "Clone this project…",
                    description: clonePath(draft.projectChoice)
                      ? `Propose ${clonePath(draft.projectChoice)} · only pushed history transfers`
                      : "Choose an absolute clone destination · only pushed history transfers"
                  }] : [])
                ]
              })
              if (picked.kind === "selected") {
                if (picked.value === "clone") yield* cloneDestination(draft.projectChoice!, draft.host)
                else if ("kind" in picked.value) {
                  const branch = picked.value.value
                  const existing = trees.find(tree => tree.vcs === "git" && tree.branch === branch)
                  draft = existing ? selectWorktree(draft, existing)
                    : changeDestination(draft, { branch, label: branch }, draft.worktreeName)
                } else {
                  if (picked.value.vcs === "jj" && (!picked.value.present || !picked.value.path))
                    return yield* Effect.fail(new AppError({ message: `Workspace ${picked.value.name} is unavailable; inspect its registered location before opening` }))
                  draft = selectWorktree(draft, picked.value)
                }
              } else {
                const name = picked.text.trim()
                if (!name || name.startsWith("-") && git || /[\p{ASCII}&&\p{Cc}]/v.test(name) ||
                  !git && (name.startsWith("/") || name.split(/[\\/]/).some(part => !part || part === "." || part === "..")))
                  return yield* Effect.fail(new AppError({ message: git ? "Branch name must be a valid Git branch" : "Invalid workspace name" }))
                if (git) {
                  const existing = trees.find(tree => tree.vcs === "git" && tree.branch === name)
                  draft = existing ? selectWorktree(draft, existing) : changeDestination(draft, { branch: name, label: name }, draft.worktreeName)
                } else draft = typeWorktreeName(draft, name, found.revisions.find(choice => choice.expression === "trunk()"))
              }
            }
          } else if (action === "checkoutName") {
            const picked = yield* inputChoice<string | null>({
              message: draft.clone?.vcs === "jj" ? "Optional separate workspace name" : "Optional custom checkout directory name",
              choices: [
                { value: null, title: "Use default", description: "No separate custom name" },
                ...(draft.worktreeName ? [{ value: draft.worktreeName, title: "Current custom name" }] : [])
              ]
            })
            if (picked.kind === "selected" && picked.value === null) draft = { ...draft, worktreeName: undefined }
            else {
              const name = (picked.kind === "selected" ? picked.value! : picked.text).trim()
              if (!name || /[\p{ASCII}&&\p{Cc}]/v.test(name) ||
                name.split(/[\\/]/).some(part => !part || part === "." || part === ".."))
                return yield* Effect.fail(new AppError({ message: "Invalid custom checkout name" }))
              draft = { ...draft, worktreeName: name }
            }
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
            } else if (draft.clone?.vcs === "git") {
              const picked = yield* inputChoice({
                message: "Branch (select source branch or type new branch; only pushed history transfers)",
                choices: draft.clone.branches.map(branch => ({
                  value: branch, title: branch,
                  description: "Use this branch from the cloned origin"
                }))
              })
              const branch = picked.kind === "selected" ? picked.value : picked.text.trim()
              if (!branch || branch.startsWith("-") || /[\p{ASCII}&&\p{Cc}]/v.test(branch))
                return yield* Effect.fail(new AppError({ message: "Branch name must be a valid Git branch" }))
              draft = { ...draft, destination: { branch, label: branch } }
            }
          } else if (action === "session") {
            if (!draft.host) return yield* Effect.fail(new AppError({ message: "Select a machine before choosing a session" }))
            const found = yield* discover(draft.host, command)
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
          plan = undefined
          clonePlan = undefined
        }
      }
    }).pipe(Effect.catchCause(cause => Cause.hasInterrupts(cause) || launchAcknowledged
      ? Effect.failCause(cause)
      : acknowledge("Could not open worktrees", [Cause.pretty(cause)], "error")
        .pipe(Effect.andThen(Effect.failCause(cause)))))
  }))
