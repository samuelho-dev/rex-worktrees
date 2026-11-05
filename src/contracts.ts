import { Schema } from "effect"

export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) { }
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  message: Schema.String, program: Schema.String, args: Schema.Array(Schema.String),
  exitCode: Schema.Number, stdout: Schema.String, stderr: Schema.String
}) { }
export const ServerHostIdSchema = Schema.String.pipe(Schema.brand("ServerHostId"))
export type ServerHostId = typeof ServerHostIdSchema.Type
export const RegisteredHostIdSchema = Schema.String.pipe(Schema.brand("RegisteredHostId"))
export type RegisteredHostId = typeof RegisteredHostIdSchema.Type
export const SessionIdSchema = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionIdSchema.Type
export const ClientIdSchema = Schema.String.pipe(Schema.brand("ClientId"))
export type ClientId = typeof ClientIdSchema.Type
export const WindowIdSchema = Schema.String.pipe(Schema.brand("WindowId"))
export type WindowId = typeof WindowIdSchema.Type
export const BlockIdSchema = Schema.String.pipe(Schema.brand("BlockId"))
export type BlockId = typeof BlockIdSchema.Type
export const LayerIdSchema = Schema.String.pipe(Schema.brand("LayerId"))
export type LayerId = typeof LayerIdSchema.Type

export const VcsSchema = Schema.Literals(["git", "jj"])
export type Vcs = typeof VcsSchema.Type
const RepositoryFields = { path: Schema.String, commonDir: Schema.String, name: Schema.String }
export const GitRepositorySchema = Schema.Struct({ vcs: Schema.Literal("git"), ...RepositoryFields })
export type GitRepository = typeof GitRepositorySchema.Type
export const JjRepositorySchema = Schema.Struct({ vcs: Schema.Literal("jj"), ...RepositoryFields })
export type JjRepository = typeof JjRepositorySchema.Type
export const RepositorySchema = Schema.Union([GitRepositorySchema, JjRepositorySchema])
export type Repository = typeof RepositorySchema.Type
export const JjWorkspaceNameSchema = Schema.String.pipe(Schema.brand("JjWorkspaceName"))
export type JjWorkspaceName = typeof JjWorkspaceNameSchema.Type
export const JjCommitIdSchema = Schema.String.pipe(Schema.brand("JjCommitId"))
export type JjCommitId = typeof JjCommitIdSchema.Type
export const JjChangeIdSchema = Schema.String.pipe(Schema.brand("JjChangeId"))
export type JjChangeId = typeof JjChangeIdSchema.Type
export const JjRevisionSchema = Schema.Struct({ commitId: JjCommitIdSchema, changeId: JjChangeIdSchema, description: Schema.String })
export type JjRevision = typeof JjRevisionSchema.Type
export const JjRevisionChoiceSchema = Schema.Struct({ expression: Schema.String, label: Schema.String, revision: JjRevisionSchema })
export type JjRevisionChoice = typeof JjRevisionChoiceSchema.Type
export const RepositoryHeadSchema = Schema.Struct({ branch: Schema.NullOr(Schema.String), head: Schema.String })
export type RepositoryHead = typeof RepositoryHeadSchema.Type
export const GitWorktreeSchema = Schema.Struct({
  vcs: Schema.Literal("git"), path: Schema.String,
  branch: Schema.mutableKey(Schema.NullOr(Schema.String)),
  head: Schema.mutableKey(Schema.String),
  bare: Schema.mutableKey(Schema.Boolean),
  locked: Schema.mutableKey(Schema.Boolean),
  prunable: Schema.mutableKey(Schema.Boolean)
})
export type GitWorktree = typeof GitWorktreeSchema.Type
export const JjWorktreeSchema = Schema.Struct({
  vcs: Schema.Literal("jj"), path: Schema.NullOr(Schema.String), name: JjWorkspaceNameSchema,
  head: JjCommitIdSchema, changeId: JjChangeIdSchema, present: Schema.Boolean, colocated: Schema.Boolean
})
export type JjWorktree = typeof JjWorktreeSchema.Type
export const WorktreeSchema = Schema.Union([GitWorktreeSchema, JjWorktreeSchema])
export type Worktree = typeof WorktreeSchema.Type
export type CreateWorktreeOptions = {
  readonly startPoint?: string | undefined
  readonly attachOnly?: boolean | undefined
  readonly worktreeRoot?: string | undefined
  readonly worktreeName?: string | undefined
}
export type Environment = Record<string, string>

export const ConfigSchema = Schema.Struct({
  roots: Schema.optional(Schema.Array(Schema.String)),
  projects: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Struct({
    path: Schema.String, worktreeRoot: Schema.optional(Schema.String)
  })]))),
  worktreeRoot: Schema.optional(Schema.String)
})
export type Config = typeof ConfigSchema.Type
export const NativeConfigSchema = Schema.Struct({ config: ConfigSchema, directory: Schema.String })
export type ResolvedConfig = {
  readonly roots: readonly string[]
  readonly projects: readonly string[]
  readonly worktreeRoot: string | undefined
  readonly projectRoots: readonly { readonly path: string; readonly worktreeRoot: string }[]
}
export type Install = {
  readonly source: string
  readonly home: string
  readonly configPath: string
  readonly lua: string
  readonly rexBinDir: string
  readonly managedBin?: string | undefined
  readonly pathEnv?: string | undefined
  readonly allowLinkedConfig?: boolean | undefined
  readonly legacyConfigPath?: string | undefined
}
export const AssociationSchema = Schema.Struct({
  vcs: VcsSchema, hostId: ServerHostIdSchema, commonDir: Schema.String, path: Schema.String,
  sessionId: SessionIdSchema, windowId: WindowIdSchema, blockId: BlockIdSchema
})
export type Association = typeof AssociationSchema.Type

export const SessionTargetSchema = Schema.Struct({ id: SessionIdSchema, label: Schema.String })
export type SessionTarget = typeof SessionTargetSchema.Type
export const SessionSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("existing"), id: SessionIdSchema }),
  Schema.Struct({
    kind: Schema.Literal("new"), name: Schema.String.pipe(
      Schema.check(Schema.isMaxLength(128), Schema.isPattern(/^(?=.*\S)(?!.*[\p{ASCII}&&\p{Cc}]).*$/v)))
  })
])
export type SessionSelection = typeof SessionSelectionSchema.Type
export const ClientTargetSchema = Schema.Struct({ id: ClientIdSchema, label: Schema.String })
export type ClientTarget = typeof ClientTargetSchema.Type
export const MachineSchema = Schema.Struct({ key: Schema.Union([Schema.Literal("local"), RegisteredHostIdSchema]), label: Schema.String, local: Schema.Boolean, selector: Schema.String })
export type Machine = typeof MachineSchema.Type
export const DestinationHostSchema = Schema.Struct({ ...MachineSchema.fields, hostId: ServerHostIdSchema })
export type DestinationHost = typeof DestinationHostSchema.Type
export const GitCloneSourceSchema = Schema.Struct({
  vcs: Schema.Literal("git"), url: Schema.String, sourceHostId: ServerHostIdSchema,
  branches: Schema.Array(Schema.String), branch: Schema.optional(Schema.String)
})
export type GitCloneSource = typeof GitCloneSourceSchema.Type
export const JjCloneSourceSchema = Schema.Struct({
  vcs: Schema.Literal("jj"), url: Schema.String, sourceHostId: ServerHostIdSchema,
  revisions: Schema.Array(JjRevisionChoiceSchema), revision: Schema.optional(JjRevisionSchema)
})
export type JjCloneSource = typeof JjCloneSourceSchema.Type
export const CloneSourceSchema = Schema.Union([GitCloneSourceSchema, JjCloneSourceSchema])
export type CloneSource = typeof CloneSourceSchema.Type
export const GitCloneInputSchema = Schema.Struct({
  vcs: Schema.Literal("git"), source: GitCloneSourceSchema, repo: Schema.String, session: SessionSelectionSchema,
  clientId: Schema.optional(ClientIdSchema), name: Schema.String, branch: Schema.String,
  branchMode: Schema.Literals(["existing", "create"]), worktreeName: Schema.optional(Schema.String)
})
export type GitCloneInput = typeof GitCloneInputSchema.Type
export const JjCloneInputSchema = Schema.Struct({
  vcs: Schema.Literal("jj"), source: JjCloneSourceSchema, repo: Schema.String, session: SessionSelectionSchema,
  clientId: Schema.optional(ClientIdSchema), name: Schema.String,
  worktreeName: Schema.optional(Schema.String), revision: Schema.optional(Schema.String)
})
export type JjCloneInput = typeof JjCloneInputSchema.Type
export const CloneInputSchema = Schema.Union([GitCloneInputSchema, JjCloneInputSchema])
export type CloneInput = typeof CloneInputSchema.Type
const ClonePlanFields = {
  hostId: ServerHostIdSchema, clientId: Schema.optional(ClientIdSchema),
  repo: Schema.String, existing: Schema.Boolean, commonDir: Schema.optional(Schema.String),
  label: Schema.String, detail: Schema.optional(Schema.String), warning: Schema.optional(Schema.String)
}
export const GitClonePlanSchema = Schema.Struct({
  ...ClonePlanFields, vcs: Schema.Literal("git"), input: GitCloneInputSchema, base: Schema.optional(Schema.String)
})
export type GitClonePlan = typeof GitClonePlanSchema.Type
export const JjClonePlanSchema = Schema.Struct({
  ...ClonePlanFields, vcs: Schema.Literal("jj"), input: JjCloneInputSchema, base: Schema.optional(JjRevisionSchema)
})
export type JjClonePlan = typeof JjClonePlanSchema.Type
export const ClonePlanSchema = Schema.Union([GitClonePlanSchema, JjClonePlanSchema])
export type ClonePlan = typeof ClonePlanSchema.Type
export const CloneLaunchResultSchema = Schema.Struct({
  hostId: ServerHostIdSchema, sessionId: SessionIdSchema, windowId: WindowIdSchema, blockId: BlockIdSchema,
  repo: Schema.String, pending: Schema.Literal(true), warning: Schema.optional(Schema.String)
})
export type CloneLaunchResult = typeof CloneLaunchResultSchema.Type
export const CloneTaskRequestSchema = Schema.Struct({ plan: ClonePlanSchema, sessionId: SessionIdSchema, rexBinDir: Schema.optional(Schema.String), rexLocalEndpoint: Schema.optional(Schema.String) })
export type CloneTaskRequest = typeof CloneTaskRequestSchema.Type
const LaunchInputFields = {
  repo: Schema.String, session: SessionSelectionSchema, name: Schema.String,
  clientId: Schema.optional(ClientIdSchema), additional: Schema.optional(Schema.Boolean), split: Schema.optional(Schema.Boolean)
}
export const GitLaunchInputSchema = Schema.Struct({
  ...LaunchInputFields, vcs: Schema.Literal("git"), branch: Schema.optional(Schema.String),
  worktreeName: Schema.optional(Schema.String), path: Schema.optional(Schema.String)
})
export type GitLaunchInput = typeof GitLaunchInputSchema.Type
export const JjLaunchInputSchema = Schema.Struct({
  ...LaunchInputFields, vcs: Schema.Literal("jj"), path: Schema.optional(Schema.String),
  worktreeName: Schema.optional(Schema.String), revision: Schema.optional(Schema.String)
})
export type JjLaunchInput = typeof JjLaunchInputSchema.Type
export const LaunchInputSchema = Schema.Union([GitLaunchInputSchema, JjLaunchInputSchema])
export type LaunchInput = typeof LaunchInputSchema.Type
const LaunchPlanFields = {
  hostId: ServerHostIdSchema, clientId: Schema.optional(ClientIdSchema),
  path: Schema.String, worktreeRoot: Schema.optional(Schema.String),
  action: Schema.Literals(["focus", "new-tab", "split"]),
  target: Schema.optional(Schema.Struct({ windowId: WindowIdSchema, blockId: BlockIdSchema, label: Schema.String })),
  nameRole: Schema.Literals(["tab", "pane", "none"]), name: Schema.optional(Schema.String),
  label: Schema.String, detail: Schema.optional(Schema.String), warning: Schema.optional(Schema.String)
}
export const GitLaunchPlanSchema = Schema.Struct({
  ...LaunchPlanFields, vcs: Schema.Literal("git"), input: GitLaunchInputSchema,
  branch: Schema.NullOr(Schema.String), checkout: Schema.Literals(["existing", "attach", "create"]),
  base: Schema.optional(RepositoryHeadSchema)
})
export type GitLaunchPlan = typeof GitLaunchPlanSchema.Type
export const JjLaunchPlanSchema = Schema.Struct({
  ...LaunchPlanFields, vcs: Schema.Literal("jj"), input: JjLaunchInputSchema,
  checkout: Schema.Literals(["existing", "create"]), workspaceName: JjWorkspaceNameSchema,
  base: Schema.optional(JjRevisionSchema)
})
export type JjLaunchPlan = typeof JjLaunchPlanSchema.Type
export const LaunchPlanSchema = Schema.Union([GitLaunchPlanSchema, JjLaunchPlanSchema])
export type LaunchPlan = typeof LaunchPlanSchema.Type
export const LaunchResultSchema = Schema.Struct({
  hostId: ServerHostIdSchema, sessionId: SessionIdSchema, windowId: WindowIdSchema, blockId: BlockIdSchema,
  path: Schema.String, pending: Schema.Boolean, action: Schema.Literals(["focus", "new-tab", "split"]), warning: Schema.optional(Schema.String)
})
export type LaunchResult = typeof LaunchResultSchema.Type
const TaskRequestFields = {
  repo: Schema.String, hostId: ServerHostIdSchema, rexBinDir: Schema.optional(Schema.String),
  rexLocalEndpoint: Schema.optional(Schema.String), path: Schema.String, commonDir: Schema.String,
  sessionId: SessionIdSchema, worktreeRoot: Schema.optional(Schema.String)
}
export const GitTaskRequestSchema = Schema.Struct({
  ...TaskRequestFields, vcs: Schema.Literal("git"), branch: Schema.optional(Schema.String),
  worktreeName: Schema.optional(Schema.String), base: Schema.optional(Schema.String),
  checkout: Schema.optional(Schema.Literals(["attach", "existing"]))
})
export type GitTaskRequest = typeof GitTaskRequestSchema.Type
export const JjTaskRequestSchema = Schema.Struct({
  ...TaskRequestFields, vcs: Schema.Literal("jj"), checkout: Schema.Literals(["existing", "create"]),
  workspaceName: JjWorkspaceNameSchema, base: Schema.optional(JjRevisionSchema)
})
export type JjTaskRequest = typeof JjTaskRequestSchema.Type
export const TaskRequestSchema = Schema.Union([GitTaskRequestSchema, JjTaskRequestSchema])
export type TaskRequest = typeof TaskRequestSchema.Type
export const RequestIdentitySchema = Schema.Struct({ version: Schema.Literal(4), hostId: ServerHostIdSchema })
export type RequestIdentity = typeof RequestIdentitySchema.Type
export const RequestSchema = Schema.Union([
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("discover"), context: Schema.optional(Schema.String) }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("sessions") }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("clone-source"), repo: Schema.String }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("project"), path: Schema.String }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("worktrees"), repo: Schema.String }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("revision"), repo: Schema.String, revision: Schema.String }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("plan"), input: LaunchInputSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("clone-plan"), input: CloneInputSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("clone-launch"), input: CloneInputSchema, reviewed: ClonePlanSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("launch"), input: LaunchInputSchema, reviewed: LaunchPlanSchema })
])
export type Request = typeof RequestSchema.Type
export type RequestBody<R = Request> = R extends Request ? Omit<R, keyof RequestIdentity> : never
export const ResponseSchema = Schema.Union([
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("discover"), sessions: Schema.Array(SessionTargetSchema), clients: Schema.Array(ClientTargetSchema), projects: Schema.Array(RepositorySchema), roots: Schema.optional(Schema.Array(Schema.String)), cloneRoot: Schema.String, checkout: Schema.optional(RepositorySchema) }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("sessions"), sessions: Schema.Array(SessionTargetSchema), clients: Schema.Array(ClientTargetSchema) }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("project"), project: RepositorySchema, checkout: RepositorySchema, worktrees: Schema.Array(WorktreeSchema), branches: Schema.Array(Schema.String), revisions: Schema.Array(JjRevisionChoiceSchema) }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("project-missing"), path: Schema.String }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("clone-source"), source: CloneSourceSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("worktrees"), repository: RepositorySchema, worktrees: Schema.Array(WorktreeSchema), branches: Schema.Array(Schema.String), revisions: Schema.Array(JjRevisionChoiceSchema) }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("revision"), revision: JjRevisionSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("plan"), plan: LaunchPlanSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("clone-plan"), plan: ClonePlanSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("clone-launch"), result: CloneLaunchResultSchema }),
  Schema.Struct({ ...RequestIdentitySchema.fields, kind: Schema.Literal("launch"), result: LaunchResultSchema })
])
export type Response = typeof ResponseSchema.Type
// Native Lua actions return an opaque JSON string inside Rex's JSON response.
export const RexWorktreesResponseSchema = Schema.fromJsonString(Schema.fromJsonString(ResponseSchema))
export const RexNativeConfigResponseSchema = Schema.fromJsonString(Schema.fromJsonString(NativeConfigSchema))

export const PopupOriginSchema = Schema.Struct({ sessionId: Schema.optional(SessionIdSchema), blockId: Schema.optional(BlockIdSchema), clientId: Schema.optional(ClientIdSchema) })
export type PopupOrigin = typeof PopupOriginSchema.Type
export const RexIdentitySchema = Schema.Struct({ host_id: ServerHostIdSchema, endpoint: Schema.String, principal: Schema.Struct({ transport: Schema.String }) })
export const RexSessionsSchema = Schema.Struct({ sessions: Schema.Array(Schema.Struct({ session_id: SessionIdSchema, label: Schema.String })) })
export const RexSessionCreatedSchema = Schema.Struct({ session_id: SessionIdSchema })
export const RexClientsSchema = Schema.Struct({
  clients: Schema.Array(Schema.Struct({
    client_id: ClientIdSchema, info: Schema.optional(Schema.Struct({ kind: Schema.String, label: Schema.optional(Schema.String) })),
    connection_state: Schema.optional(Schema.String)
  }))
})
export const RexWindowsSchema = Schema.Struct({
  windows: Schema.Array(Schema.Struct({
    window_id: WindowIdSchema, label: Schema.String,
    layers: Schema.Array(Schema.Struct({ blocks: Schema.optional(Schema.Array(Schema.Struct({ block_id: BlockIdSchema, host_id: ServerHostIdSchema }))) }))
  }))
})
export const RexViewSchema = Schema.Struct({
  active_window_id: Schema.NullOr(WindowIdSchema), windows: Schema.Array(Schema.Struct({
    window_id: WindowIdSchema, layers: Schema.Array(Schema.Struct({
      blocks: Schema.Array(Schema.Struct({ block_id: BlockIdSchema, owner: Schema.optional(Schema.NullOr(ClientIdSchema)) }))
    }))
  }))
})
export const RexCreatedSchema = Schema.Struct({ window_id: Schema.optional(WindowIdSchema), block_ids: Schema.Array(BlockIdSchema) })
export const RexLayerSchema = Schema.Struct({ layer_id: Schema.NullOr(LayerIdSchema), block_ids: Schema.NullOr(Schema.Array(Schema.NullOr(BlockIdSchema))), revision: Schema.Number })
export const RexDirectorySchema = Schema.Struct({ pwd: Schema.optional(Schema.String) })
export const RexRegistrySchema = Schema.Struct({
  home: Schema.Struct({ label: Schema.String, endpoint: Schema.String, this_machine: Schema.Boolean }),
  hosts: Schema.Array(Schema.Struct({ host: Schema.Struct({ id: RegisteredHostIdSchema, label: Schema.String, endpoints: Schema.Array(Schema.String) }) }))
})
export const RexProcessSchema = Schema.Struct({
  last_exit: Schema.NullOr(Schema.Struct({ exit_code: Schema.Number })),
  foreground: Schema.optional(Schema.NullOr(Schema.Struct({ cwd: Schema.optional(Schema.String) })))
})
export const RexActionsSchema = Schema.Struct({ actions: Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) })) })
export const RexHelperArgsSchema = Schema.Struct({ properties: Schema.Struct({ request: Schema.Struct({ type: Schema.Literal("string") }) }) })
export const RexConfigCheckSchema = Schema.Struct({ path: Schema.String, exists: Schema.Boolean, diagnostics: Schema.Array(Schema.Unknown) })

export const CliBooleanFlagSchema = Schema.Literals(["--additional", "--split", "--no-context", "--managed-popup"])
export const CliStringFlagSchema = Schema.Literals(["--bin", "--config", "--host", "--repo", "--session", "--name", "--branch", "--revision", "--worktree", "--worktree-name", "--client", "--context", "--origin-session", "--origin-block", "--origin-client"])
export const CliFlagsSchema = Schema.Struct({
  "--additional": Schema.mutableKey(Schema.optional(Schema.Boolean)), "--split": Schema.mutableKey(Schema.optional(Schema.Boolean)),
  "--no-context": Schema.mutableKey(Schema.optional(Schema.Boolean)), "--managed-popup": Schema.mutableKey(Schema.optional(Schema.Boolean)),
  "--bin": Schema.mutableKey(Schema.optional(Schema.String)), "--config": Schema.mutableKey(Schema.optional(Schema.String)), "--host": Schema.mutableKey(Schema.optional(Schema.String)), "--repo": Schema.mutableKey(Schema.optional(Schema.String)),
  "--session": Schema.mutableKey(Schema.optional(SessionIdSchema)), "--name": Schema.mutableKey(Schema.optional(Schema.String)),
  "--branch": Schema.mutableKey(Schema.optional(Schema.String)), "--worktree": Schema.mutableKey(Schema.optional(Schema.String)),
  "--revision": Schema.mutableKey(Schema.optional(Schema.String)),
  "--worktree-name": Schema.mutableKey(Schema.optional(Schema.String)), "--client": Schema.mutableKey(Schema.optional(ClientIdSchema)),
  "--context": Schema.mutableKey(Schema.optional(Schema.String)), "--origin-session": Schema.mutableKey(Schema.optional(SessionIdSchema)),
  "--origin-block": Schema.mutableKey(Schema.optional(BlockIdSchema)), "--origin-client": Schema.mutableKey(Schema.optional(ClientIdSchema))
})
export type CliFlags = typeof CliFlagsSchema.Type

export type FormField = "project" | "machine" | "destination" | "checkoutName" | "branch" | "session" | "mode" | "submit" | "cancel"
export type FormRow = {
  readonly id: Exclude<FormField, "submit" | "cancel">
  readonly label: string
  readonly value: string
  readonly detail?: string
  readonly disabled?: boolean
}
export type FormView = {
  readonly rows: readonly FormRow[]
  readonly submitLabel: string
  readonly submitDisabled?: boolean
  readonly notice?: string
  readonly error?: string
}
export type Color = "cyan" | "amber" | "muted" | "red" | "bold"
export type NoticeTone = "warning" | "error" | "info"
export type InputChoiceState = { readonly text: string; readonly selected: number | null }
export type ProjectChoice = {
  readonly name: string
  readonly path?: string
  readonly source?: { readonly machineKey: Machine["key"]; readonly hostId: ServerHostId; readonly repository: Repository; readonly checkoutPath?: string }
}
export type Destination =
  | { readonly path: string; readonly branch?: never; readonly revision?: never; readonly label: string }
  | { readonly branch: string; readonly path?: never; readonly revision?: never; readonly label: string }
  | { readonly revision: string; readonly path?: never; readonly branch?: never; readonly label: string }
export type Draft = {
  readonly machine?: Machine
  readonly host?: DestinationHost
  readonly projectChoice?: ProjectChoice
  readonly clone?: CloneSource & { readonly repo: string }
  readonly project?: Repository
  readonly sourcePath?: string
  readonly destination?: Destination
  readonly worktreeName?: string
  readonly session?: SessionSelection
  readonly clientId?: ClientId
  readonly mode: "auto" | "new-tab" | "split"
}

// Generic in-memory prompt values and Effect capabilities are not serialized inputs.
export type InputChoice<A> = { readonly value: A; readonly title: string; readonly description?: string; readonly selected?: boolean }
export type InputChoiceResult<A> = { readonly kind: "selected"; readonly value: A } | { readonly kind: "typed"; readonly text: string }
export type InputChoiceOptions<A> = { readonly message: string; readonly choices: readonly InputChoice<A>[]; readonly selectionOnly?: boolean; readonly selected?: number }
