import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { AppError, AssociationSchema, type Association } from "./contracts.ts";
const cloneRootFile = Effect.fnUntraced(function*(stateRoot?: string) {
  const path = yield* Path.Path;
  const root = stateRoot ?? process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
  if (!path.isAbsolute(root)) return yield* new AppError({ message: "State home must be absolute" });
  return path.join(root, "rex-worktrees", "clone-root.json");
});

const CloneRootSchema = Schema.Struct({ cloneRoot: Schema.String });

export const rememberedCloneRoot = Effect.fnUntraced(function*(stateRoot?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = yield* cloneRootFile(stateRoot);
  const raw = yield* fs.readFileString(filename).pipe(Effect.catchIf(
    error => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound",
    () => Effect.succeed(undefined)
  ));
  if (raw === undefined) return undefined;
  // ponytail: advisory state can be damaged, but inaccessible state is a real IO error.
  const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloneRootSchema))(raw).pipe(
    Effect.catch(() => Effect.succeed(undefined))
  );
  return record && path.isAbsolute(record.cloneRoot) && path.resolve(record.cloneRoot) === record.cloneRoot
    ? record.cloneRoot : undefined;
});

export const rememberCloneRoot = Effect.fnUntraced(function*(parent: string, stateRoot?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(parent) || path.resolve(parent) !== parent) return yield* new AppError({ message: "Clone parent must be normalized and absolute" });
  const filename = yield* cloneRootFile(stateRoot);
  yield* fs.makeDirectory(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  yield* fs.writeFileString(temporary, JSON.stringify({ cloneRoot: parent }), { flag: "wx", mode: 0o600 });
  yield* fs.rename(temporary, filename).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});


// One atomic file per terminal prevents overlapping task processes from losing associations.
export const saveAssociation = Effect.fnUntraced(function*(association: Association) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  const directory = path.join(root, "rex-worktrees", "associations");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporary = path.join(directory, `${id}.tmp`);
  const destination = path.join(directory, `${id}.json`);
  yield* fs.writeFileString(temporary, JSON.stringify(association), { flag: "wx", mode: 0o600 });
  yield* fs.rename(temporary, destination).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

export const associations = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "rex-worktrees", "associations");
  const result: Association[] = [];
  if (!(yield* fs.exists(directory))) return result;
  for (const name of yield* fs.readDirectory(directory)) {
    if (!name.endsWith(".json")) continue;
    // A damaged single record is advisory, never a reason to block a checkout.
    const raw = yield* Effect.catchIf(
      fs.readFileString(path.join(directory, name)),
      (error) => PlatformError.isPlatformError(error) && error.reason._tag === "NotFound",
      () => Effect.succeed(undefined)
    );
    if (raw === undefined) continue;
    const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AssociationSchema))(raw).pipe(
      Effect.catch(() => Effect.succeed(undefined))
    );
    if (record) result.push(record);
  }
  return result;
});
